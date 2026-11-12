import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { AgentConfig } from '../../config/schema.ts';
import type { AgentAdapter, AgentReply, AgentTurn, Workspace } from './types.ts';
import {
  ensureWorktree,
  expandHome,
  mergeBlocker,
  removeWorktree,
  squashMerge,
  worktreeStatus,
  type WorktreeOpts,
  type WorktreeStatus,
} from './worktree.ts';

type ClaudeCodeConfig = Extract<AgentConfig, { type: 'claude-code' }>;

const BRIDGE_PROMPT = `You are being reached through agents-bridge. Messages come from people in a chat app (Slack, Telegram, …) or from other agents.
- Your final answer is posted back to the conversation automatically.
- Use the "bridge" MCP tools to post an interim update (send_message), ask the person a question and wait for the reply (ask_human), hand work to another agent (delegate), or call the external tools you were granted.
- Keep chat replies short and readable; the conversation is a chat thread, not a terminal.
- Reply in the language the person writes in, even when bridge notes like this one are in English.`;

/** Runs Claude Code headless (`claude -p`) per turn, resuming the same Claude session across turns of a thread. */
export class ClaudeCodeAgent implements AgentAdapter {
  readonly name: string;
  private readonly cfg: ClaudeCodeConfig;
  private readonly running = new Set<ChildProcess>();
  readonly workspace?: Workspace;

  constructor(name: string, cfg: ClaudeCodeConfig) {
    this.name = name;
    this.cfg = cfg;
    if (cfg.worktree) this.workspace = new WorktreeWorkspace(this.worktreeOpts.bind(this));
  }

  private worktreeOpts(sessionKey: string): WorktreeOpts {
    return {
      baseCwd: expandHome(this.cfg.cwd ?? process.cwd()),
      sessionKey,
      dir: this.cfg.worktree_dir,
      links: this.cfg.worktree_links,
    };
  }

  async run(turn: AgentTurn): Promise<AgentReply> {
    let cwd = expandHome(this.cfg.cwd ?? process.cwd());
    let resume = turn.agentSessionId;
    let systemPrompt = BRIDGE_PROMPT;
    if (this.cfg.worktree) {
      const wt = ensureWorktree(this.worktreeOpts(turn.envelope.sessionKey));
      cwd = wt.cwd;
      systemPrompt += `\n- You are working in your own git worktree (${wt.path}) on branch ${wt.branch}, separate from the user's main checkout. Stay on this branch and commit your changes here when a piece of work is done; the user merges the branch.`;
      // Claude sessions are stored per directory; one from another checkout can't be resumed here.
      if (wt.created) resume = undefined;
      if (wt.created) turn.onNotice?.(`🌿 ${this.name} works on its own branch \`${wt.branch}\` for this conversation (${wt.path}).`);
    }
    const dir = mkdtempSync(join(tmpdir(), 'agents-bridge-'));
    const mcpFile = join(dir, 'mcp.json');
    writeFileSync(mcpFile, JSON.stringify({ mcpServers: { bridge: { type: 'http', url: turn.mcp.url } } }), {
      mode: 0o600,
    });
    const args = [
      '-p',
      '--output-format', 'stream-json',
      '--verbose',
      '--mcp-config', mcpFile,
      '--append-system-prompt', systemPrompt,
      '--permission-mode', this.cfg.permission_mode,
      '--allowedTools', ['mcp__bridge', ...this.cfg.allowed_tools].join(','),
    ];
    if (resume) args.push('--resume', resume);
    if (this.cfg.model) args.push('--model', this.cfg.model);

    try {
      return await new Promise<AgentReply>((resolve, reject) => {
        const child = spawn(this.cfg.command, args, {
          cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
          signal: turn.signal,
        });
        this.running.add(child);
        child.on('close', () => this.running.delete(child));
        let result: AgentReply | undefined;
        let sessionId: string | undefined;
        let stderr = '';
        child.stderr.on('data', (d) => (stderr = (stderr + d).slice(-4000)));
        createInterface({ input: child.stdout }).on('line', (line) => {
          let ev: any;
          try {
            ev = JSON.parse(line);
          } catch {
            return;
          }
          if (ev.session_id && ev.session_id !== sessionId) {
            sessionId = ev.session_id;
            turn.onSessionId?.(ev.session_id);
          }
          if (ev.type === 'assistant') {
            for (const block of ev.message?.content ?? []) {
              if (block.type === 'tool_use') turn.onProgress?.(describeToolUse(block.name, block.input));
            }
          } else if (ev.type === 'result') {
            result = {
              text: ev.is_error ? `⚠️ ${ev.result ?? ev.subtype ?? 'Claude Code failed'}` : String(ev.result ?? ''),
              agentSessionId: ev.session_id ?? sessionId,
              costUsd: typeof ev.total_cost_usd === 'number' ? ev.total_cost_usd : undefined,
            };
          }
        });
        child.on('error', reject);
        child.on('close', (code) => {
          if (result) resolve(result);
          else reject(new Error(`claude exited with code ${code}${stderr ? `: ${stderr.trim()}` : ''}`));
        });
        child.stdin.end(turn.text);
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** Bridge shutdown: end running turns so they can't keep editing while a resumed turn starts. */
  async stop() {
    for (const child of this.running) child.kill('SIGTERM');
    this.running.clear();
  }
}

/** status / merge / discard for a conversation's `bridge/…` branch. */
class WorktreeWorkspace implements Workspace {
  private readonly opts: (sessionKey: string) => WorktreeOpts;
  constructor(opts: (sessionKey: string) => WorktreeOpts) {
    this.opts = opts;
  }

  status(key: string) {
    const st = worktreeStatus(this.opts(key));
    return st && describe(st);
  }

  previewMerge(key: string) {
    const o = this.opts(key);
    const st = worktreeStatus(o);
    if (!st) return { ok: false as const, reason: 'this conversation has no branch yet' };
    const blocker = mergeBlocker(o, st);
    if (blocker) return { ok: false as const, reason: `can't merge: ${blocker}` };
    return { ok: true as const, summary: `Squash ${st.commits.length} commit(s) from \`${st.branch}\` into \`${st.base}\` as one commit:\n${commitList(st)}\n${fence(st.diffstat)}` };
  }

  merge(key: string) {
    const { commit, message } = squashMerge(this.opts(key));
    return `✅ Merged into one commit \`${commit}\` — ${message.split('\n')[0]}. The branch and its worktree are removed; your next message starts fresh from the updated base.`;
  }

  previewDiscard(key: string) {
    const st = worktreeStatus(this.opts(key));
    if (!st) return undefined;
    const lost = [
      st.commits.length ? `${st.commits.length} unmerged commit(s):\n${commitList(st)}` : '',
      st.dirty.length ? `${st.dirty.length} uncommitted file(s)` : '',
    ].filter(Boolean);
    return lost.join('\n');
  }

  discard(key: string) {
    const st = worktreeStatus(this.opts(key));
    removeWorktree(this.opts(key));
    return `🗑 Discarded ${st ? `\`${st.branch}\`` : 'the branch'}. Your next message starts fresh.`;
  }
}

function describe(st: WorktreeStatus): string {
  const lines = [`🌿 \`${st.branch}\` (from \`${st.base}\`)`];
  lines.push(st.commits.length ? `${st.commits.length} commit(s) not in ${st.base}:\n${commitList(st)}` : `No commits beyond ${st.base} yet.`);
  if (st.diffstat) lines.push(fence(st.diffstat));
  if (st.dirty.length) lines.push(`Uncommitted: ${st.dirty.map((d) => d.slice(3)).join(', ')}`);
  lines.push('Reply `merge` to squash it into the base branch, or `discard` to throw it away.');
  return lines.join('\n');
}

function commitList(st: WorktreeStatus) {
  const shown = st.commits.slice(0, 10).map((c) => `• ${c}`);
  if (st.commits.length > 10) shown.push(`• … and ${st.commits.length - 10} more`);
  return shown.join('\n');
}

function fence(s: string) {
  return s ? '```\n' + s + '\n```' : '';
}

function describeToolUse(name: string, input: any): string {
  const target = input?.file_path ?? input?.path ?? input?.pattern ?? input?.command ?? input?.url;
  const short = typeof target === 'string' ? ` ${target.length > 60 ? target.slice(0, 57) + '…' : target}` : '';
  return `${name.replace(/^mcp__bridge__/, '')}${short}`;
}

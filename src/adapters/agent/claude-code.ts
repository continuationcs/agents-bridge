import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import type { AgentConfig } from '../../config/schema.ts';
import type { AgentAdapter, AgentReply, AgentTurn, Workspace } from './types.ts';
import { resolveSecret } from '../../secrets.ts';
import {
  ensureWorktree,
  expandHome,
  mergeBlocker,
  prBlocker,
  pruneIdle,
  pushPullRequest,
  removeWorktree,
  sessionSlug,
  squashMerge,
  worktreeStatus,
  type WorktreeOpts,
  type WorktreeStatus,
} from './worktree.ts';

type ClaudeCodeConfig = Extract<AgentConfig, { type: 'claude-code' }>;

const BRIDGE_PROMPT = `You are being reached through bridge. Messages come from people in a chat app (Slack, Telegram, …) or from other agents.
- Your final answer is posted back to the conversation automatically.
- Use the "bridge" MCP tools to post an interim update (send_message), ask the person a question and wait for the reply (ask_human), hand work to another agent (delegate), or call the external tools you were granted.
- Keep chat replies short and readable; the conversation is a chat thread, not a terminal.
- Reply in the language of the person's own message, even when bridge notes like this one, attached files, screenshots or tool output are in another language. If their message has no words, use the language of their earlier messages.`;

/** How long a stopped Claude Code (and the tools it started) gets after SIGTERM before SIGKILL. */
const KILL_GRACE_MS = 5000;

/**
 * Claude keeps its sessions per directory, so the session id the bridge stores also names the
 * directory the session ran in: `<claude session id>@<dir tag>`. A session is resumed only in
 * the same directory (ids without a tag come from older versions: resumed unless the worktree is new).
 */
function encodeSessionId(claudeId: string, cwd: string): string {
  return `${claudeId}@${dirTag(cwd)}`;
}

function decodeSessionId(stored: string): { id: string; dir?: string } {
  const at = stored.lastIndexOf('@');
  return at < 0 ? { id: stored } : { id: stored.slice(0, at), dir: stored.slice(at + 1) };
}

const dirTag = (cwd: string) => createHash('sha1').update(cwd).digest('hex').slice(0, 12);

/** Serializes work per key (a conversation's worktree): creating, pruning, merging, discarding. */
class KeyedLock {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const tail = prev.then(() => mine);
    this.tails.set(key, tail);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

/** Runs Claude Code headless (`claude -p`) per turn, resuming the same Claude session across turns of a thread. */
export class ClaudeCodeAgent implements AgentAdapter {
  readonly name: string;
  private readonly cfg: ClaudeCodeConfig;
  /** Running processes and a promise that settles when each has closed. */
  private readonly running = new Map<ChildProcess, Promise<void>>();
  private readonly locks = new KeyedLock();
  /** Worktrees (by session slug) a turn is running in: never pruned. */
  private readonly busy = new Map<string, number>();
  readonly workspace?: Workspace;

  constructor(name: string, cfg: ClaudeCodeConfig) {
    this.name = name;
    this.cfg = cfg;
    if (cfg.worktree) {
      this.workspace = new WorktreeWorkspace(this.worktreeOpts.bind(this), cfg.git_token, (key, fn) => this.locks.run(sessionSlug(key), fn), async (slug, fn) =>
        this.locks.run(slug, async () => {
          if (!this.busy.get(slug)) await fn();
        }),
      );
    }
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
    if (!this.cfg.worktree) return this.runIn(expandHome(this.cfg.cwd ?? process.cwd()), turn, BRIDGE_PROMPT, false);
    const slug = sessionSlug(turn.envelope.sessionKey);
    // Under the lock, so a prune or discard can't remove the worktree between creating and using it.
    const wt = await this.locks.run(slug, async () => {
      const w = await ensureWorktree(this.worktreeOpts(turn.envelope.sessionKey));
      this.busy.set(slug, (this.busy.get(slug) ?? 0) + 1);
      return w;
    });
    try {
      if (wt.notice) turn.onNotice?.(wt.notice);
      if (wt.created) turn.onNotice?.(`🌿 ${this.name} works on its own branch \`${wt.branch}\` for this conversation (${wt.path}).`);
      const prompt = `${BRIDGE_PROMPT}\n- You are working in your own git worktree (${wt.path}) on branch ${wt.branch}, separate from the user's main checkout. Stay on this branch and commit your changes here when a piece of work is done; the user merges the branch.`;
      return await this.runIn(wt.cwd, turn, prompt, wt.created);
    } finally {
      const n = (this.busy.get(slug) ?? 1) - 1;
      if (n) this.busy.set(slug, n);
      else this.busy.delete(slug);
    }
  }

  private async runIn(cwd: string, turn: AgentTurn, systemPrompt: string, freshDir: boolean): Promise<AgentReply> {
    const prev = turn.agentSessionId ? decodeSessionId(turn.agentSessionId) : undefined;
    const resume = prev && (prev.dir !== undefined ? prev.dir === dirTag(cwd) : !freshDir) ? prev.id : undefined;
    const dir = mkdtempSync(join(tmpdir(), 'bridge-'));
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
    // Attachments live outside the repo; let Claude read their folder.
    for (const dir of new Set((turn.files ?? []).map((f) => dirname(f.path)))) args.push('--add-dir', dir);
    // Hard cap for this turn: whatever is left of the conversation budget.
    if (turn.budgetUsd !== undefined) args.push('--max-budget-usd', turn.budgetUsd.toFixed(2));
    if (this.cfg.model) args.push('--model', this.cfg.model);

    try {
      return await this.spawnTurn(cwd, args, turn);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  private spawnTurn(cwd: string, args: string[], turn: AgentTurn): Promise<AgentReply> {
    const signal = turn.signal;
    if (signal?.aborted) return Promise.reject(abortError(signal));
    return new Promise<AgentReply>((resolve, reject) => {
      // Its own process group, so stopping it also stops the tools it started.
      const child = spawn(this.cfg.command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
      let markClosed!: () => void;
      const closed = new Promise<void>((r) => (markClosed = r));
      this.running.set(child, closed);
      const onAbort = () => void this.terminate(child, closed);
      signal?.addEventListener('abort', onAbort, { once: true });

      let result: AgentReply | undefined;
      let sessionId: string | undefined;
      let stderr = '';
      let stdinError: Error | undefined;
      let spawnError: Error | undefined;
      const finish = () => {
        signal?.removeEventListener('abort', onAbort);
        this.running.delete(child);
        markClosed();
        if (signal?.aborted) reject(abortError(signal));
        else if (result) resolve(result);
        else if (spawnError) reject(spawnError);
        else reject(new Error(`claude exited${stderr ? `: ${stderr.trim()}` : stdinError ? ` before reading its prompt (${stdinError.message})` : ''}`));
      };
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
          turn.onSessionId?.(encodeSessionId(ev.session_id, cwd));
        }
        if (ev.type === 'assistant') {
          for (const block of ev.message?.content ?? []) {
            if (block.type === 'tool_use') turn.onProgress?.(describeToolUse(block.name, block.input));
          }
        } else if (ev.type === 'result') {
          const overBudget = /budget/i.test(String(ev.subtype ?? ''));
          const id: string | undefined = ev.session_id ?? sessionId;
          result = {
            text: overBudget
              ? `💸 Stopped: this turn reached the conversation's remaining budget ($${turn.budgetUsd?.toFixed(2)}). Send "reset" to start a new conversation with a fresh budget.`
              : ev.is_error
                ? `⚠️ ${ev.result ?? ev.subtype ?? 'Claude Code failed'}`
                : String(ev.result ?? ''),
            agentSessionId: id && encodeSessionId(id, cwd),
            costUsd: typeof ev.total_cost_usd === 'number' ? ev.total_cost_usd : undefined,
          };
        }
      });
      child.on('error', (err) => {
        spawnError = err;
        // A process that never started emits no 'close'.
        if (child.pid === undefined) finish();
      });
      child.on('close', finish);
      // EPIPE when claude exits without reading the prompt: 'close' reports it.
      child.stdin.on('error', (err) => (stdinError = err));
      child.stdin.end(withFiles(turn));
    });
  }

  /** SIGTERM the process group, SIGKILL it if still there after the grace period; resolves once closed. */
  private async terminate(child: ChildProcess, closed: Promise<void>) {
    signalGroup(child, 'SIGTERM');
    const timer = setTimeout(() => signalGroup(child, 'SIGKILL'), KILL_GRACE_MS);
    await closed;
    clearTimeout(timer);
  }

  /** Bridge shutdown: end running turns (and their tools) so they can't keep editing while a resumed turn starts. */
  async stop() {
    await Promise.all([...this.running].map(([child, closed]) => this.terminate(child, closed)));
  }
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals) {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    /* the group is gone */
  }
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new Error('aborted');
}

/** status / merge / discard for a conversation's `bridge/…` branch. */
class WorktreeWorkspace implements Workspace {
  private readonly opts: (sessionKey: string) => WorktreeOpts;
  /** Runs fn under the conversation's worktree lock. */
  private readonly locked: <T>(sessionKey: string, fn: () => Promise<T>) => Promise<T>;
  /** Runs fn under the slug's lock, unless a turn is running in that worktree. */
  private readonly pruneGuard: (slug: string, fn: () => Promise<void>) => Promise<void>;
  readonly previewPr?: Workspace['previewPr'];
  readonly pr?: Workspace['pr'];

  constructor(
    opts: (sessionKey: string) => WorktreeOpts,
    gitToken: string | undefined,
    locked: <T>(sessionKey: string, fn: () => Promise<T>) => Promise<T>,
    pruneGuard: (slug: string, fn: () => Promise<void>) => Promise<void>,
  ) {
    this.opts = opts;
    this.locked = locked;
    this.pruneGuard = pruneGuard;
    if (gitToken) {
      this.previewPr = (key) =>
        this.locked(key, async () => {
          const o = this.opts(key);
          const st = await worktreeStatus(o);
          if (!st) return { ok: false as const, reason: 'this conversation has no branch yet' };
          const blocker = await prBlocker(o, st);
          if (blocker) return { ok: false as const, reason: `can't open a PR: ${blocker}` };
          return {
            ok: true as const,
            summary: `Push \`${st.branch}\` (${st.commits?.length} commit(s)) to origin and open a pull request into \`${st.base}\`:\n${commitList(st)}`,
          };
        });
      this.pr = (key) =>
        this.locked(key, async () => {
          const { url, created } = await pushPullRequest(this.opts(key), resolveSecret(gitToken));
          return created ? `🔀 Opened ${url}` : `🔀 Pushed new commits to the open PR ${url}`;
        });
    }
  }

  status(key: string) {
    return this.locked(key, async () => {
      const st = await worktreeStatus(this.opts(key));
      return st && describe(st);
    });
  }

  previewMerge(key: string) {
    return this.locked(key, async () => {
      const o = this.opts(key);
      const st = await worktreeStatus(o);
      if (!st) return { ok: false as const, reason: 'this conversation has no branch yet' };
      const blocker = await mergeBlocker(o, st);
      if (blocker) return { ok: false as const, reason: `can't merge: ${blocker}` };
      return {
        ok: true as const,
        summary: `Squash ${st.commits?.length} commit(s) from \`${st.branch}\` into \`${st.base}\` as one commit:\n${commitList(st)}\n${fence(st.diffstat)}`,
      };
    });
  }

  merge(key: string) {
    return this.locked(key, async () => {
      const { commit, message } = await squashMerge(this.opts(key));
      return `✅ Merged into one commit \`${commit}\` — ${message.split('\n')[0]}. The branch and its worktree are removed; your next message starts fresh from the updated base.`;
    });
  }

  previewDiscard(key: string) {
    return this.locked(key, async () => {
      const st = await worktreeStatus(this.opts(key));
      if (!st) return undefined;
      const lost = [
        st.commits === undefined
          ? `the branch \`${st.branch}\`, whose unmerged commits can't be determined (${st.note})`
          : st.commits.length
            ? `${st.commits.length} unmerged commit(s):\n${commitList(st)}`
            : '',
        st.dirty.length ? `${st.dirty.length} uncommitted file(s)` : '',
      ].filter(Boolean);
      return lost.join('\n');
    });
  }

  prune(isIdle: (slug: string) => boolean) {
    return pruneIdle(this.opts(''), isIdle, this.pruneGuard);
  }

  discard(key: string) {
    return this.locked(key, async () => {
      const st = await worktreeStatus(this.opts(key));
      await removeWorktree(this.opts(key));
      return `🗑 Discarded ${st ? `\`${st.branch}\`` : 'the branch'}. Your next message starts fresh.`;
    });
  }
}

function describe(st: WorktreeStatus): string {
  const lines = [`🌿 \`${st.branch}\` (from \`${st.base}\`)`];
  if (st.commits === undefined) lines.push(`⚠️ Can't tell which commits are unmerged: ${st.note}.`);
  else {
    if (st.note) lines.push(`⚠️ Note: ${st.note}.`);
    lines.push(st.commits.length ? `${st.commits.length} commit(s) not in ${st.base}:\n${commitList(st)}` : `No commits beyond ${st.base} yet.`);
  }
  if (st.diffstat) lines.push(fence(st.diffstat));
  if (st.dirty.length) lines.push(`Uncommitted: ${st.dirty.map((d) => d.slice(3)).join(', ')}`);
  lines.push('Reply `merge` to squash it into the base branch, `pr` to open a pull request, or `discard` to throw it away.');
  return lines.join('\n');
}

function commitList(st: WorktreeStatus) {
  const commits = st.commits ?? [];
  const shown = commits.slice(0, 10).map((c) => `• ${c}`);
  if (commits.length > 10) shown.push(`• … and ${commits.length - 10} more`);
  return shown.join('\n');
}

function fence(s: string) {
  return s ? '```\n' + s + '\n```' : '';
}

/** The prompt, plus where the attached files are (Claude Code reads images and documents with Read). */
function withFiles(turn: AgentTurn): string {
  if (!turn.files?.length) return turn.text;
  const list = turn.files.map((f) => `- ${f.path} (${f.name}${f.mime ? `, ${f.mime}` : ''})`).join('\n');
  return `${turn.text || 'See the attached files.'}\n\n[Attached by the person — read them with the Read tool]\n${list}`;
}

function describeToolUse(name: string, input: any): string {
  const target = input?.file_path ?? input?.path ?? input?.pattern ?? input?.command ?? input?.url;
  const short = typeof target === 'string' ? ` ${target.length > 60 ? target.slice(0, 57) + '…' : target}` : '';
  return `${name.replace(/^mcp__bridge__/, '')}${short}`;
}

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { AgentConfig } from '../../config/schema.ts';
import type { AgentAdapter, AgentReply, AgentTurn } from './types.ts';

type ClaudeCodeConfig = Extract<AgentConfig, { type: 'claude-code' }>;

const BRIDGE_PROMPT = `You are being reached through agents-bridge. Messages come from people in a chat app (Slack, Telegram, …) or from other agents.
- Your final answer is posted back to the conversation automatically.
- Use the "bridge" MCP tools to post an interim update (send_message), ask the person a question and wait for the reply (ask_human), hand work to another agent (delegate), or call the external tools you were granted.
- Keep chat replies short and readable; the conversation is a chat thread, not a terminal.`;

/** Runs Claude Code headless (`claude -p`) per turn, resuming the same Claude session across turns of a thread. */
export class ClaudeCodeAgent implements AgentAdapter {
  readonly name: string;
  private readonly cfg: ClaudeCodeConfig;

  constructor(name: string, cfg: ClaudeCodeConfig) {
    this.name = name;
    this.cfg = cfg;
  }

  async run(turn: AgentTurn): Promise<AgentReply> {
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
      '--append-system-prompt', BRIDGE_PROMPT,
      '--permission-mode', this.cfg.permission_mode,
      '--allowedTools', ['mcp__bridge', ...this.cfg.allowed_tools].join(','),
    ];
    if (turn.agentSessionId) args.push('--resume', turn.agentSessionId);
    if (this.cfg.model) args.push('--model', this.cfg.model);

    try {
      return await new Promise<AgentReply>((resolve, reject) => {
        const child = spawn(this.cfg.command, args, {
          cwd: expandHome(this.cfg.cwd ?? process.cwd()),
          stdio: ['pipe', 'pipe', 'pipe'],
          signal: turn.signal,
        });
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
          if (ev.session_id) sessionId = ev.session_id;
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
}

function describeToolUse(name: string, input: any): string {
  const target = input?.file_path ?? input?.path ?? input?.pattern ?? input?.command ?? input?.url;
  const short = typeof target === 'string' ? ` ${target.length > 60 ? target.slice(0, 57) + '…' : target}` : '';
  return `${name.replace(/^mcp__bridge__/, '')}${short}`;
}

function expandHome(p: string) {
  return p.startsWith('~/') ? join(homedir(), p.slice(2)) : p;
}

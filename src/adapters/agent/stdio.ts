import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import type { AgentConfig } from '../../config/schema.ts';
import { resolveSecret } from '../../secrets.ts';
import type { AgentAdapter, AgentReply, AgentTurn } from './types.ts';

type StdioConfig = Extract<AgentConfig, { type: 'stdio' }>;

interface Pending {
  resolve: (r: AgentReply) => void;
  reject: (e: Error) => void;
  turn: AgentTurn;
}

/**
 * A long-running local process speaking JSON lines.
 *   bridge → agent  {"type":"turn","id":…,"text":…,"session_id":…,"envelope":{…},"mcp":{"url":…}}
 *   agent → bridge  {"type":"progress","id":…,"text":"…"}
 *                   {"type":"reply","id":…,"text":"…","session_id":"…","cost_usd":0}
 *                   {"type":"error","id":…,"message":"…"}
 */
export class StdioAgent implements AgentAdapter {
  readonly name: string;
  private readonly cfg: StdioConfig;
  private child?: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<string, Pending>();

  constructor(name: string, cfg: StdioConfig) {
    this.name = name;
    this.cfg = cfg;
  }

  run(turn: AgentTurn): Promise<AgentReply> {
    const child = this.ensureChild();
    const id = randomUUID();
    return new Promise<AgentReply>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, turn });
      turn.signal?.addEventListener('abort', () => {
        this.pending.delete(id);
        reject(new Error('aborted'));
      });
      child.stdin.write(
        JSON.stringify({
          type: 'turn',
          id,
          text: turn.text,
          session_id: turn.agentSessionId ?? null,
          budget_usd: turn.budgetUsd ?? null,
          envelope: turn.envelope,
          mcp: { url: turn.mcp.url },
        }) + '\n',
      );
    });
  }

  async stop() {
    this.child?.kill();
    this.child = undefined;
  }

  private ensureChild(): ChildProcessWithoutNullStreams {
    if (this.child && this.child.exitCode === null) return this.child;
    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    for (const [k, v] of Object.entries(this.cfg.env)) env[k] = resolveSecret(v);
    const child = spawn(this.cfg.command, this.cfg.args, { cwd: this.cfg.cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    child.stderr.on('data', (d) => process.stderr.write(`[${this.name}] ${d}`));
    createInterface({ input: child.stdout }).on('line', (line) => this.onLine(line));
    child.on('exit', (code) => {
      for (const p of this.pending.values()) p.reject(new Error(`${this.name} exited (code ${code})`));
      this.pending.clear();
      if (this.child === child) this.child = undefined;
    });
    child.on('error', (err) => {
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    });
    this.child = child;
    return child;
  }

  private onLine(line: string) {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const p = this.pending.get(msg?.id);
    if (!p) return;
    if (msg.type === 'progress') p.turn.onProgress?.(String(msg.text ?? ''));
    else if (msg.type === 'reply') {
      this.pending.delete(msg.id);
      p.resolve({
        text: String(msg.text ?? ''),
        agentSessionId: typeof msg.session_id === 'string' ? msg.session_id : p.turn.agentSessionId,
        costUsd: typeof msg.cost_usd === 'number' ? msg.cost_usd : undefined,
      });
    } else if (msg.type === 'error') {
      this.pending.delete(msg.id);
      p.reject(new Error(String(msg.message ?? 'agent error')));
    }
  }
}

import type { AgentConfig } from '../../config/schema.ts';
import { parseDuration } from '../../core/address.ts';
import { resolveSecret } from '../../secrets.ts';
import type { AgentAdapter, AgentReply, AgentTurn } from './types.ts';

type WebhookConfig = Extract<AgentConfig, { type: 'webhook' }>;

/**
 * Any HTTP service is an agent:
 *   POST <url>  {"type":"turn","text":…,"session_id":…,"envelope":{…},"mcp":{"url":…}}
 *   →  200      {"text":"…","session_id":"…","cost_usd":0.01}
 */
export class WebhookAgent implements AgentAdapter {
  readonly name: string;
  private readonly cfg: WebhookConfig;

  constructor(name: string, cfg: WebhookConfig) {
    this.name = name;
    this.cfg = cfg;
  }

  async run(turn: AgentTurn): Promise<AgentReply> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    for (const [k, v] of Object.entries(this.cfg.headers)) headers[k] = resolveSecret(v);
    const timeout = AbortSignal.timeout(parseDuration(this.cfg.timeout));
    const res = await fetch(this.cfg.url, {
      method: 'POST',
      headers,
      signal: turn.signal ? AbortSignal.any([turn.signal, timeout]) : timeout,
      body: JSON.stringify({
        type: 'turn',
        text: turn.text,
        session_id: turn.agentSessionId ?? null,
        budget_usd: turn.budgetUsd ?? null,
        envelope: turn.envelope,
        mcp: { url: turn.mcp.url },
      }),
    });
    if (!res.ok) throw new Error(`${this.name}: HTTP ${res.status} ${await res.text().catch(() => '')}`.trim());
    const body = (await res.json()) as { text?: unknown; session_id?: unknown; cost_usd?: unknown };
    if (typeof body.text !== 'string') throw new Error(`${this.name}: response has no "text" string`);
    return {
      text: body.text,
      agentSessionId: typeof body.session_id === 'string' ? body.session_id : turn.agentSessionId,
      costUsd: typeof body.cost_usd === 'number' ? body.cost_usd : undefined,
    };
  }
}

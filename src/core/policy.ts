import type { BridgeConfig, Policy } from '../config/schema.ts';
import { anyGlob, parseDuration } from './address.ts';

export interface ApprovalRule {
  approvers: string[];
  timeoutMs: number;
  policy: Policy;
}

/** Evaluates `policies:`. Every matching policy applies; the strictest value wins. */
export class PolicyEngine {
  private readonly cfg: BridgeConfig;
  constructor(cfg: BridgeConfig) {
    this.cfg = cfg;
  }

  maxHops(agent: string): number {
    const limits = this.forAgent(agent)
      .map((p) => p.max_hops)
      .filter((n): n is number => n !== undefined);
    return Math.min(this.cfg.defaults.max_hops, ...limits);
  }

  budgetUsd(agent: string): number | undefined {
    const b = this.forAgent(agent)
      .map((p) => p.budget_usd)
      .filter((n): n is number => n !== undefined);
    return b.length ? Math.min(...b) : undefined;
  }

  /** Approval needed before `tool` (as "server.tool") runs? Approvers are merged across matching policies. */
  approvalFor(tool: string, opts: { readOnly?: boolean } = {}): ApprovalRule | undefined {
    const hits = this.cfg.policies.filter(
      (p) => p.approve_by?.length && anyGlob(p.match.tool, tool) && !(p.match.writes && opts.readOnly),
    );
    if (!hits.length) return undefined;
    const approvers = [...new Set(hits.flatMap((p) => p.approve_by ?? []))];
    const timeouts = hits.map((p) => parseDuration(p.timeout ?? '10m'));
    return { approvers, timeoutMs: Math.min(...timeouts), policy: hits[0]! };
  }

  private forAgent(agent: string): Policy[] {
    return this.cfg.policies.filter((p) => anyGlob(p.match.agent, agent));
  }
}

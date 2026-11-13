import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { BridgeConfig } from './schema.ts';
import { parseAddress } from '../core/address.ts';

export class ConfigError extends Error {
  readonly issues: string[];
  constructor(issues: string[]) {
    super(`bridge.yaml is invalid:\n  - ${issues.join('\n  - ')}`);
    this.issues = issues;
  }
}

export function loadConfigFile(path: string): BridgeConfig {
  return parseConfig(readFileSync(path, 'utf8'));
}

export function parseConfig(text: string): BridgeConfig {
  const raw = parse(text) ?? {};
  const result = BridgeConfig.safeParse(raw);
  if (!result.success) {
    throw new ConfigError(result.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
  }
  const issues = semanticCheck(result.data);
  if (issues.length) throw new ConfigError(issues);
  return result.data;
}

/** Checks zod cannot express: references resolve, and local agents never take IM input from unnamed senders. */
export function semanticCheck(cfg: BridgeConfig): string[] {
  const issues: string[] = [];
  const agentNames = new Set(Object.keys(cfg.agents));
  const toolNames = new Set(Object.keys(cfg.tools));
  const people = new Set(Object.keys(cfg.people));

  for (const name of [...agentNames, ...toolNames]) {
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(name)) issues.push(`name "${name}" may only use letters, digits, "-" and "_"`);
  }
  for (const name of agentNames) {
    if (toolNames.has(name)) issues.push(`"${name}" is both an agent and a tool`);
  }

  cfg.routes.forEach((route, i) => {
    const where = `routes[${i}]`;
    const from = parseAddress(route.from);
    const targets = Array.isArray(route.to) ? route.to : [route.to];

    if (from.kind === 'im') {
      if (targets.length !== 1) issues.push(`${where}: a route from IM must go to exactly one agent`);
      const target = targets[0]!;
      const agent = Object.hasOwn(cfg.agents, target) ? cfg.agents[target] : undefined;
      if (!agent) {
        issues.push(`${where}: unknown agent "${target}"`);
        return;
      }
      if (from.platform !== 'local' && !Object.hasOwn(cfg.im, from.platform)) {
        issues.push(`${where}: IM "${from.platform}" is not configured under im:`);
      }
      // Agents running on this machine are only reachable by people named in the route.
      if ((agent.type === 'claude-code' || agent.type === 'stdio') && route.when.sender === undefined) {
        issues.push(
          `${where}: "${target}" runs on this machine, so the route needs when.sender (list people, or "anyone" to opt out)`,
        );
      }
      if (typeof route.when.mention === 'string' && route.when.mention !== target) {
        issues.push(`${where}: when.mention "${route.when.mention}" should name the route's agent "${target}"`);
      }
      const { mention, listen } = route.when;
      if ((listen === 'all' && mention !== undefined && mention !== false) || (listen === 'mention' && mention === false)) {
        issues.push(`${where}: when.listen "${listen}" contradicts when.mention ${JSON.stringify(mention)}`);
      }
    } else {
      if (!agentNames.has(from.name)) issues.push(`${where}: from "${route.from}" is not an agent`);
      if (route.when.mention !== undefined || route.when.listen !== undefined) {
        issues.push(`${where}: mention/listen only apply to routes from IM`);
      }
      for (const t of targets) {
        const head = t.split('.')[0]!;
        if (!agentNames.has(head) && !toolNames.has(head) && head !== '*') {
          issues.push(`${where}: unknown target "${t}"`);
        }
      }
    }

    if (Array.isArray(route.when.sender)) {
      for (const p of route.when.sender) if (!people.has(p)) issues.push(`${where}: unknown person "${p}"`);
    }
  });

  cfg.policies.forEach((p, i) => {
    const where = `policies[${i}]`;
    for (const who of p.approve_by ?? []) {
      if (who === 'initiator') continue;
      if (!people.has(who)) issues.push(`${where}: approve_by "${who}" is neither "initiator" nor a person`);
      else if (cfg.people[who]!.trust === 'external') issues.push(`${where}: approve_by "${who}" has trust external and can't approve`);
    }
    // Hop limits and budgets belong to an agent (and its conversation), not to a single tool call.
    if ((p.max_hops !== undefined || p.budget_usd !== undefined) && (p.match.tool !== undefined || p.match.writes !== undefined)) {
      issues.push(`${where}: max_hops / budget_usd apply per agent — match them by agent only, not by tool or writes`);
    }
  });

  return issues;
}

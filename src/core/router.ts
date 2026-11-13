import type { BridgeConfig, Route } from '../config/schema.ts';
import { anyGlob, globMatch, parseAddress } from './address.ts';

/** What an IM adapter hands to the bridge for every message it sees. */
export interface InboundMessage {
  platform: string;
  channelId: string;
  /** Human-readable channel name, without "#". */
  channelName: string;
  isDM: boolean;
  userId: string;
  userName?: string;
  /** Message text with the bot mention removed. */
  text: string;
  /** The bot was @-mentioned, or the message replies to the bot. */
  mentioned: boolean;
  /** Root message id of the thread this message belongs to (its own id if it starts one). */
  threadId: string;
  messageId: string;
  /** Attachments; the bridge downloads them before the turn is queued. */
  files?: InboundFile[];
}

export interface InboundFile {
  name: string;
  mime?: string;
  /** Bytes, when the platform says. */
  size?: number;
  download(): Promise<Buffer>;
}

export interface InboundMatch {
  route: Route;
  index: number;
  agent: string;
  /** Text with a leading agent name ("data-agent, please…") removed. */
  text: string;
}

export interface Explanation {
  match?: InboundMatch;
  /** One line per route that was checked, in order. */
  trace: string[];
}

export interface InboundContext {
  /** Person id from `people`, or undefined for someone unknown. */
  personId?: string;
  /** Agent already holding this thread; a reply in the thread continues it without a fresh mention. */
  threadAgent?: string;
}

export class Router {
  private readonly cfg: BridgeConfig;
  constructor(cfg: BridgeConfig) {
    this.cfg = cfg;
  }

  matchInbound(msg: InboundMessage, ctx: InboundContext): InboundMatch | undefined {
    return this.explainInbound(msg, ctx).match;
  }

  /** First-match routing for messages from IM, with a reason for every route that did not match. */
  explainInbound(msg: InboundMessage, ctx: InboundContext): Explanation {
    const trace: string[] = [];
    const { agent: addressed, rest } = this.leadingAgent(msg.text);

    for (const [index, route] of this.cfg.routes.entries()) {
      const from = parseAddress(route.from);
      const label = `routes[${index}] ${route.from} → ${String(route.to)}`;
      if (from.kind !== 'im') continue;
      const agent = Array.isArray(route.to) ? route.to[0]! : route.to;

      if (from.platform !== msg.platform) {
        trace.push(`${label}: different IM`);
        continue;
      }
      if (!channelMatches(from.channel, msg)) {
        trace.push(`${label}: channel does not match`);
        continue;
      }
      if (addressed && addressed !== agent) {
        trace.push(`${label}: message addresses "${addressed}"`);
        continue;
      }
      // A reply in a thread the agent already holds continues it without a fresh mention or address.
      const continuing = ctx.threadAgent === agent;
      const { mention, listen } = route.when;
      const needsMention = mention === undefined ? listen !== 'all' : mention !== false;
      if (needsMention && !(msg.isDM || msg.mentioned) && !continuing) {
        trace.push(`${label}: bot not mentioned`);
        continue;
      }
      if (typeof mention === 'string' && addressed !== mention && !continuing) {
        trace.push(`${label}: message does not address "${mention}" (start it with "${mention}")`);
        continue;
      }
      const sender = route.when.sender;
      if (Array.isArray(sender) && !(ctx.personId && sender.includes(ctx.personId))) {
        trace.push(`${label}: sender ${ctx.personId ?? `unknown (${msg.platform}:${msg.userId})`} not allowed`);
        continue;
      }
      trace.push(`${label}: MATCH`);
      return { trace, match: { route, index, agent, text: addressed ? rest : msg.text } };
    }
    trace.push('no route matched — message ignored (deny by default)');
    return { trace };
  }

  /** May agent `from` reach `target` (another agent, or a tool as "server.tool")? */
  allowsOutbound(from: string, target: string): Route | undefined {
    return this.cfg.routes.find((r) => {
      const a = parseAddress(r.from);
      return a.kind === 'agent' && globMatch(a.name, from) && anyGlob(r.to, target);
    });
  }

  /** Could any route let `from` call some tool on `server`? */
  mayReachServer(from: string, server: string): boolean {
    return this.cfg.routes.some((r) => {
      const a = parseAddress(r.from);
      if (a.kind !== 'agent' || !globMatch(a.name, from)) return false;
      return (Array.isArray(r.to) ? r.to : [r.to]).some((t) => globMatch(t.split('.')[0]!, server));
    });
  }

  private leadingAgent(text: string): { agent?: string; rest: string } {
    const m = /^\s*@?([A-Za-z0-9][\w-]*)[\s,:，：]+([\s\S]*)$/.exec(text);
    if (m && Object.hasOwn(this.cfg.agents, m[1]!)) return { agent: m[1]!, rest: m[2]! };
    const bare = text.trim().replace(/^@/, '');
    if (Object.hasOwn(this.cfg.agents, bare)) return { agent: bare, rest: '' };
    return { rest: text };
  }
}

function channelMatches(pattern: string, msg: InboundMessage): boolean {
  if (pattern === '*') return true;
  if (pattern === 'dm') return msg.isDM;
  if (msg.isDM) return false;
  const p = pattern.replace(/^#/, '');
  return globMatch(p, msg.channelName) || globMatch(p, msg.channelId);
}

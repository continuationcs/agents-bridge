import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { BridgeConfig, TrustLevel } from '../config/schema.ts';
import { createAgent } from '../adapters/agent/index.ts';
import type { AgentAdapter, AgentReply } from '../adapters/agent/types.ts';
import type { ImAdapter } from '../adapters/im/types.ts';
import { McpHub, type HubBackend, type SessionGrant, type ToolResult } from '../mcp/hub.ts';
import { ToolHub } from '../mcp/tools.ts';
import { parseDuration } from './address.ts';
import { minTrust, newEnvelope, type Envelope } from './envelope.ts';
import { PolicyEngine } from './policy.ts';
import { Router, type InboundMessage } from './router.ts';
import type { Store } from './store.ts';

interface ThreadRef {
  platform: string;
  channelId: string;
  threadId: string;
  isDM: boolean;
}

/** One agent turn in progress: who is running, for which thread, under which envelope. */
interface TurnCtx {
  sessionKey: string;
  /** The IM-facing session that started the chain; costs roll up here. */
  rootKey: string;
  agent: string;
  envelope: Envelope;
  thread: ThreadRef;
}

interface Job {
  sessionKey: string;
  agent: string;
  text: string;
  envelope: Envelope;
  thread: ThreadRef;
  /** How many times this turn was cut off by a bridge restart. */
  interrupted?: number;
}

/** A turn interrupted this many times is given up instead of resumed again. */
const MAX_RESUMES = 2;

interface Waiter {
  allowed: Set<string>;
  /** Does this text answer the waiter (whoever sent it)? */
  accepts(text: string): boolean;
  offer(personId: string, text: string): boolean;
}

export interface BridgeOptions {
  cfg: BridgeConfig;
  store: Store;
  ims: ImAdapter[];
  /** Pre-built agents (tests); anything missing is built from cfg.agents. */
  agents?: Map<string, AgentAdapter>;
  tools?: ToolHub;
  log?: (line: string) => void;
}

const APPROVE = /^(approve|approved|yes|y|ok|lgtm|批准|同意|可以)$/i;
const DENY = /^(deny|denied|no|n|reject|拒绝|不行)$/i;

export class Bridge implements HubBackend {
  private cfg: BridgeConfig;
  private router: Router;
  private policies: PolicyEngine;
  private readonly store: Store;
  private readonly ims = new Map<string, ImAdapter>();
  private readonly agents = new Map<string, AgentAdapter>();
  private readonly injectedAgents: Set<string>;
  private readonly tools: ToolHub;
  private readonly hub: McpHub;
  private readonly log: (line: string) => void;
  private readonly chains = new Map<string, Promise<void>>();
  private readonly active = new Map<string, TurnCtx>();
  private readonly waiters = new Map<string, Waiter[]>();
  private startedAt = 0;

  constructor(opts: BridgeOptions) {
    this.cfg = opts.cfg;
    this.router = new Router(opts.cfg);
    this.policies = new PolicyEngine(opts.cfg);
    this.store = opts.store;
    for (const im of opts.ims) this.ims.set(im.platform, im);
    for (const [k, v] of opts.agents ?? []) this.agents.set(k, v);
    this.injectedAgents = new Set(opts.agents?.keys() ?? []);
    this.tools = opts.tools ?? new ToolHub(opts.cfg.tools);
    this.hub = new McpHub(this);
    this.log = opts.log ?? ((l) => console.log(l));
  }

  async start(): Promise<{ mcpUrl: string }> {
    const mcpUrl = await this.hub.listen(this.cfg.server.host, this.cfg.server.port);
    for (const im of this.ims.values()) {
      await im.start((msg) => this.handleInbound(msg).catch((e) => this.log(`inbound error: ${e?.stack ?? e}`)));
      this.log(`connected ${im.platform}`);
    }
    this.startedAt = Date.now();
    this.replayQueue();
    return { mcpUrl };
  }

  async stop() {
    for (const im of this.ims.values()) await im.stop().catch(() => {});
    for (const a of this.agents.values()) await a.stop?.().catch(() => {});
    await this.tools.stop();
    await this.hub.close();
  }

  /** Apply a new bridge.yaml without dropping IM connections. IM credential changes need a restart. */
  reload(cfg: BridgeConfig) {
    this.cfg = cfg;
    this.router = new Router(cfg);
    this.policies = new PolicyEngine(cfg);
    for (const [name, agent] of this.agents) {
      if (this.injectedAgents.has(name)) continue;
      void agent.stop?.();
      this.agents.delete(name);
    }
    this.log('config reloaded');
  }

  /** Wait until every queued turn has finished (tests, graceful shutdown). */
  async idle() {
    while (this.chains.size) await Promise.allSettled([...this.chains.values()]);
  }

  // ───────────────────────── inbound ─────────────────────────

  async handleInbound(msg: InboundMessage) {
    const person = this.person(msg.platform, msg.userId);
    const thread: ThreadRef = { platform: msg.platform, channelId: msg.channelId, threadId: msg.threadId, isDM: msg.isDM };
    const key = msg.isDM ? `${msg.platform}:dm:${msg.userId}` : `${msg.platform}:${msg.channelId}:${msg.threadId}`;

    // A reply someone is waiting for (ask_human / approval) never starts a new turn.
    const waited = this.offerToWaiters(key, person?.id, msg.text);
    if (waited === 'consumed') return;
    if (waited) {
      await this.send(thread, `Only ${waited.join(', ')} can answer that.`);
      return;
    }

    let session = this.store.getSession(key);
    if (session && msg.isDM && Date.now() - session.last_active > parseDuration(this.cfg.defaults.dm_idle_reset)) {
      this.store.deleteSession(key);
      session = undefined;
    }

    const match = this.router.matchInbound(msg, { personId: person?.id, threadAgent: session?.agent });
    if (!match) {
      this.store.trace(key, 'ignored', person?.id ?? `${msg.platform}:${msg.userId}`, { text: msg.text });
      if (!person && (msg.isDM || msg.mentioned)) {
        this.log(`ignored ${msg.platform} user ${msg.userId} — not in people: (add  ${msg.platform}: ${msg.userId}  to a person)`);
      }
      return;
    }

    if (/^\/?(reset|new)$/i.test(match.text.trim())) {
      this.store.deleteSession(key);
      await this.send(thread, `🔄 Started a fresh ${match.agent} session.`);
      return;
    }

    const trust: TrustLevel = person?.trust ?? 'external';
    const envelope = newEnvelope({
      sender: {
        kind: 'person',
        id: person?.id ?? `${msg.platform}:${msg.userId}`,
        platform: msg.platform,
        platformUserId: msg.userId,
        displayName: msg.userName,
      },
      sessionKey: key,
      content: [{ type: 'text', text: match.text }],
      trust,
      initiator: person?.id ?? `${msg.platform}:${msg.userId}`,
      hops: 0,
      budgetUsd: this.policies.budgetUsd(match.agent),
      tainted: trust === 'external',
    });
    const job: Job = { sessionKey: key, agent: match.agent, text: match.text, envelope, thread };
    this.store.enqueue(envelope.id, key, job);
    this.store.trace(key, 'inbound', envelope.initiator, { route: match.index, agent: match.agent, text: match.text });
    this.schedule(key, () => this.runJob(job));
  }

  private schedule(key: string, fn: () => Promise<void>) {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn).finally(() => {
      if (this.chains.get(key) === next) this.chains.delete(key);
    });
    this.chains.set(key, next);
  }

  private replayQueue() {
    const ttl = parseDuration(this.cfg.defaults.offline_queue_ttl);
    for (const row of this.store.takePending(ttl)) {
      const job = JSON.parse(row.payload) as Job;
      if (row.status === 'pending') {
        this.log(`running queued message ${row.id} for ${job.agent}`);
        this.schedule(job.sessionKey, () => this.runJob(job));
        continue;
      }
      job.interrupted = (job.interrupted ?? 0) + 1;
      this.log(`resuming interrupted turn ${row.id} for ${job.agent} (attempt ${job.interrupted})`);
      this.schedule(job.sessionKey, async () => {
        if (job.interrupted! > MAX_RESUMES) {
          this.store.finish(job.envelope.id, 'failed');
          await this.send(job.thread, `⚠️ ${job.agent}'s turn was interrupted ${job.interrupted} times by bridge restarts, so I stopped retrying. Send the request again to restart it.`);
          return;
        }
        await this.send(job.thread, `🔁 The bridge restarted in the middle of ${job.agent}'s turn — resuming.`);
        await this.runJob(job);
      });
    }
  }

  private async runJob(job: Job) {
    const { sessionKey, agent, thread } = job;
    this.store.markRunning(job.envelope.id, job);
    let session = this.store.getSession(sessionKey);
    if (session && session.agent !== agent) {
      this.store.updateSession(sessionKey, { agent_session_id: null });
    }
    session = this.store.upsertSession({
      key: sessionKey,
      agent,
      agent_session_id: session?.agent === agent ? session.agent_session_id : null,
      platform: thread.platform,
      channel_id: thread.channelId,
      thread_id: thread.threadId,
      initiator: job.envelope.initiator,
    });

    const budget = job.envelope.budgetUsd;
    if (budget !== undefined && session.spent_usd >= budget) {
      await this.send(thread, `💸 ${agent} has used its $${budget} budget for this conversation. Send "reset" to start over.`);
      this.store.finish(job.envelope.id, 'failed');
      return;
    }

    const progress = this.cfg.defaults.progress;
    const im = this.ims.get(thread.platform);
    const placeholder = progress !== 'off' && im ? await this.send(thread, `⏳ ${agent} is working…`) : undefined;
    let lastEdit = 0;
    const onProgress = (line: string) => {
      this.store.trace(sessionKey, 'progress', agent, { line });
      if (!placeholder || !im?.edit || Date.now() - lastEdit < 1500) return;
      lastEdit = Date.now();
      void im.edit(thread.channelId, placeholder, `⏳ ${agent}: ${line}`).catch(() => {});
    };

    const ctx: TurnCtx = { sessionKey, rootKey: sessionKey, agent, envelope: job.envelope, thread };
    try {
      // Resuming a cut-off turn: the agent session already holds the request and any partial work.
      const text =
        job.interrupted && session.agent_session_id
          ? `[agents-bridge] Your previous turn was interrupted because the bridge restarted. Check what you had already done, then finish the original request:\n\n${job.text}`
          : job.text;
      const reply = await this.invoke(ctx, text, session.agent_session_id ?? undefined, onProgress);
      await this.post(thread, reply.text || '(no reply)', placeholder);
      this.store.finish(job.envelope.id, 'done');
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      this.store.trace(sessionKey, 'error', agent, { message });
      await this.post(thread, `⚠️ ${agent} failed: ${message}`, placeholder);
      this.store.finish(job.envelope.id, 'failed');
    }
  }

  /** Run one agent turn with a session-scoped MCP grant. */
  private async invoke(ctx: TurnCtx, text: string, agentSessionId: string | undefined, onProgress?: (l: string) => void): Promise<AgentReply> {
    const adapter = this.agent(ctx.agent);
    const grant = this.hub.grant({ sessionKey: ctx.sessionKey, agent: ctx.agent });
    this.active.set(ctx.sessionKey, ctx);
    try {
      const reply = await adapter.run({
        envelope: ctx.envelope,
        text,
        agentSessionId,
        mcp: { url: grant.url, token: grant.token },
        onProgress,
        onSessionId: (id) => this.store.updateSession(ctx.sessionKey, { agent_session_id: id }),
        onNotice: (note) => void this.send(ctx.thread, note).catch(() => {}),
      });
      this.store.updateSession(ctx.sessionKey, { agent_session_id: reply.agentSessionId ?? null });
      if (reply.costUsd) this.store.updateSession(ctx.rootKey, { addSpentUsd: reply.costUsd });
      this.store.trace(ctx.sessionKey, 'reply', ctx.agent, { text: reply.text, costUsd: reply.costUsd });
      return reply;
    } finally {
      grant.revoke();
      this.active.delete(ctx.sessionKey);
    }
  }

  // ───────────────────────── MCP backend ─────────────────────────

  async listTools(grant: SessionGrant): Promise<Tool[]> {
    const ctx = this.active.get(grant.sessionKey);
    if (!ctx) return [];
    const tools: Tool[] = [
      {
        name: 'send_message',
        description: 'Post an interim message to the conversation you are answering (only that thread).',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      },
      {
        name: 'ask_human',
        description: `Ask ${ctx.envelope.initiator} a question in the conversation and wait for their reply.`,
        inputSchema: {
          type: 'object',
          properties: {
            question: { type: 'string' },
            timeout_minutes: { type: 'number', description: 'Default 30.' },
          },
          required: ['question'],
        },
      },
    ];
    const peers = Object.keys(this.cfg.agents).filter((a) => a !== ctx.agent && this.router.allowsOutbound(ctx.agent, a));
    if (peers.length) {
      tools.push({
        name: 'delegate',
        description:
          'Hand a task to another agent and get its answer back. Available: ' +
          peers.map((p) => `${p}${this.cfg.agents[p]?.description ? ` (${this.cfg.agents[p]!.description})` : ''}`).join(', '),
        inputSchema: {
          type: 'object',
          properties: { agent: { type: 'string', enum: peers }, task: { type: 'string' } },
          required: ['agent', 'task'],
        },
      });
    }
    for (const server of this.tools.serverNames()) {
      if (!this.router.mayReachServer(ctx.agent, server)) continue; // don't spawn servers the agent can't use
      let list: Tool[];
      try {
        list = await this.tools.listTools(server);
      } catch (err) {
        this.log(`tool server ${server} unavailable: ${(err as Error).message}`);
        continue;
      }
      for (const t of list) {
        if (!this.router.allowsOutbound(ctx.agent, `${server}.${t.name}`)) continue;
        tools.push({ ...t, name: `${server}__${t.name}`, description: `[${server}] ${t.description ?? ''}`.trim() });
      }
    }
    return tools;
  }

  async callTool(grant: SessionGrant, name: string, args: Record<string, unknown>): Promise<ToolResult> {
    const ctx = this.active.get(grant.sessionKey);
    if (!ctx) return { text: 'this session is no longer active', isError: true };
    this.store.trace(ctx.sessionKey, 'tool_call', ctx.agent, { name, args });

    switch (name) {
      case 'send_message': {
        await this.send(ctx.thread, String(args.text ?? ''));
        return { text: 'sent' };
      }
      case 'ask_human': {
        const minutes = typeof args.timeout_minutes === 'number' ? args.timeout_minutes : 30;
        await this.send(ctx.thread, `❓ ${ctx.agent} asks: ${String(args.question ?? '')}`);
        const answer = await this.waitFor(ctx.rootKey, [ctx.envelope.initiator], minutes * 60e3, () => true);
        return answer ? { text: answer.text } : { text: `no answer within ${minutes} minutes`, isError: true };
      }
      case 'delegate':
        return this.delegate(ctx, String(args.agent ?? ''), String(args.task ?? ''));
    }

    const sep = name.indexOf('__');
    if (sep < 0) return { text: `unknown tool ${name}`, isError: true };
    const server = name.slice(0, sep);
    const tool = name.slice(sep + 2);
    const qualified = `${server}.${tool}`;
    if (!this.router.allowsOutbound(ctx.agent, qualified)) {
      return { text: `${ctx.agent} is not routed to ${qualified}`, isError: true };
    }
    const rule = this.policies.approvalFor(qualified);
    if (rule) {
      const approvers = rule.approvers.map((a) => (a === 'initiator' ? ctx.envelope.initiator : a));
      const preview = JSON.stringify(args).slice(0, 500);
      await this.send(
        ctx.thread,
        `🔐 ${ctx.agent} wants to run ${qualified} ${preview}\nReply "approve" or "deny" — ${approvers.join(', ')} can decide (expires in ${Math.round(rule.timeoutMs / 60e3)}m).`,
      );
      const decision = await this.waitFor(ctx.rootKey, approvers, rule.timeoutMs, (t) => APPROVE.test(t) || DENY.test(t));
      const approved = !!decision && APPROVE.test(decision.text);
      this.store.trace(ctx.sessionKey, 'approval', decision?.by ?? 'timeout', { tool: qualified, approved });
      if (!approved) {
        await this.send(ctx.thread, decision ? `🚫 Denied by ${decision.by}.` : '⌛ Approval expired.');
        return { text: decision ? `denied by ${decision.by}` : 'approval timed out', isError: true };
      }
      await this.send(ctx.thread, `✅ Approved by ${decision.by}.`);
    }
    const result = await this.tools.callTool(server, tool, args);
    const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
    const text = content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
    this.store.trace(ctx.sessionKey, 'tool_result', qualified, { text, isError: result.isError });
    return { text, isError: Boolean(result.isError) };
  }

  private async delegate(ctx: TurnCtx, target: string, task: string): Promise<ToolResult> {
    if (!this.cfg.agents[target]) return { text: `unknown agent "${target}"`, isError: true };
    if (!this.router.allowsOutbound(ctx.agent, target)) {
      return { text: `${ctx.agent} is not routed to ${target}`, isError: true };
    }
    const hops = ctx.envelope.hops + 1;
    const limit = Math.min(this.policies.maxHops(ctx.agent), this.policies.maxHops(target));
    if (hops > limit) return { text: `delegation stopped: ${hops} hops exceeds the limit of ${limit}`, isError: true };

    const childKey = `${ctx.sessionKey}>${target}`;
    const existing = this.store.getSession(childKey);
    this.store.upsertSession({
      key: childKey,
      agent: target,
      agent_session_id: existing?.agent_session_id ?? null,
      platform: ctx.thread.platform,
      channel_id: ctx.thread.channelId,
      thread_id: ctx.thread.threadId,
      initiator: ctx.envelope.initiator,
    });
    const envelope = newEnvelope({
      sender: { kind: 'agent', name: ctx.agent },
      sessionKey: childKey,
      content: [{ type: 'text', text: task }],
      trust: minTrust(ctx.envelope.trust, 'agent'),
      initiator: ctx.envelope.initiator,
      hops,
      budgetUsd: ctx.envelope.budgetUsd,
      tainted: ctx.envelope.tainted,
    });
    await this.send(ctx.thread, `↪️ ${ctx.agent} → ${target}: ${task.length > 200 ? task.slice(0, 197) + '…' : task}`);
    this.store.trace(childKey, 'delegate', ctx.agent, { target, task, hops });
    const reply = await this.invoke(
      { sessionKey: childKey, rootKey: ctx.rootKey, agent: target, envelope, thread: ctx.thread },
      task,
      existing?.agent_session_id ?? undefined,
    );
    return { text: reply.text };
  }

  status() {
    return {
      startedAt: this.startedAt,
      ims: [...this.ims.keys()],
      agents: Object.keys(this.cfg.agents),
      tools: Object.keys(this.cfg.tools),
      activeTurns: [...this.active.values()].map((c) => ({ session: c.sessionKey, agent: c.agent })),
      sessions: this.store.listSessions(20).map((s) => ({ key: s.key, agent: s.agent, lastActive: s.last_active, spentUsd: s.spent_usd })),
    };
  }

  // ───────────────────────── helpers ─────────────────────────

  private agent(name: string): AgentAdapter {
    let a = this.agents.get(name);
    if (!a) {
      const cfg = this.cfg.agents[name];
      if (!cfg) throw new Error(`unknown agent "${name}"`);
      a = createAgent(name, cfg);
      this.agents.set(name, a);
    }
    return a;
  }

  private person(platform: string, userId: string): { id: string; trust: TrustLevel } | undefined {
    if (platform === 'local') {
      const p = this.cfg.people[userId];
      return p ? { id: userId, trust: p.trust } : undefined;
    }
    for (const [id, p] of Object.entries(this.cfg.people)) {
      if ((p as Record<string, unknown>)[platform] === userId) return { id, trust: p.trust };
    }
    return undefined;
  }

  private waitFor(
    key: string,
    allowed: string[],
    timeoutMs: number,
    accepts: (text: string) => boolean,
  ): Promise<{ by: string; text: string } | undefined> {
    return new Promise((resolve) => {
      const list = this.waiters.get(key) ?? [];
      const waiter: Waiter = {
        allowed: new Set(allowed),
        accepts: (text) => accepts(text.trim()),
        offer: (personId, text) => {
          if (!waiter.allowed.has(personId) || !accepts(text.trim())) return false;
          done({ by: personId, text: text.trim() });
          return true;
        },
      };
      const timer = setTimeout(() => done(undefined), timeoutMs);
      const done = (v: { by: string; text: string } | undefined) => {
        clearTimeout(timer);
        const l = this.waiters.get(key) ?? [];
        const i = l.indexOf(waiter);
        if (i >= 0) l.splice(i, 1);
        if (!l.length) this.waiters.delete(key);
        resolve(v);
      };
      list.push(waiter);
      this.waiters.set(key, list);
    });
  }

  /** 'consumed' when a waiter took the message; the allowed people when someone else tried to answer. */
  private offerToWaiters(key: string, personId: string | undefined, text: string): 'consumed' | string[] | undefined {
    const list = [...(this.waiters.get(key) ?? [])];
    if (personId) for (const w of list) if (w.offer(personId, text)) return 'consumed';
    // Approval words from the wrong person are answered, not turned into a new agent turn.
    const t = text.trim();
    if (!APPROVE.test(t) && !DENY.test(t)) return undefined;
    const blocked = list.find((w) => w.accepts(t));
    return blocked ? [...blocked.allowed] : undefined;
  }

  private async send(thread: ThreadRef, text: string): Promise<string | undefined> {
    const im = this.ims.get(thread.platform);
    if (!im) return undefined;
    let last: string | undefined;
    for (const chunk of split(text, im.maxTextLength)) {
      last = await im.send({ channelId: thread.channelId, threadId: thread.threadId, isDM: thread.isDM, text: chunk });
    }
    return last;
  }

  /** Final reply: replace the progress placeholder when the IM can edit, otherwise post fresh. */
  private async post(thread: ThreadRef, text: string, placeholder?: string) {
    const im = this.ims.get(thread.platform);
    if (!im) return;
    const chunks = split(text, im.maxTextLength);
    let start = 0;
    if (placeholder && im.edit) {
      try {
        await im.edit(thread.channelId, placeholder, chunks[0]!);
        start = 1;
      } catch {
        /* fall back to posting */
      }
    }
    for (const chunk of chunks.slice(start)) {
      await im.send({ channelId: thread.channelId, threadId: thread.threadId, isDM: thread.isDM, text: chunk });
    }
  }
}

/** Split long replies at line breaks; a code fence cut in two is closed and reopened. */
export function split(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const out: string[] = [];
  let rest = text;
  let reopen = '';
  while (rest.length) {
    const room = max - reopen.length - 4;
    let cut = rest.length;
    if (rest.length > room) {
      cut = rest.lastIndexOf('\n', room);
      if (cut < room * 0.5) cut = room;
    }
    let chunk = reopen + rest.slice(0, cut);
    rest = rest.slice(cut).replace(/^\n/, '');
    const fences = chunk.split('\n').filter((l) => /^\s*(```|~~~)/.test(l));
    const open = fences.length % 2 === 1;
    if (open && rest.length) {
      chunk += '\n```';
      reopen = '```\n';
    } else reopen = '';
    out.push(chunk);
  }
  return out;
}

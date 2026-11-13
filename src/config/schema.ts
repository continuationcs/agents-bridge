import { z } from 'zod';
import { MAX_TIMER_MS, parseDuration } from '../core/address.ts';

export const TRUST_LEVELS = ['owner', 'trusted', 'member', 'agent', 'external'] as const;
export type TrustLevel = (typeof TRUST_LEVELS)[number];

/** A credential reference: `secret:<name>` (OS keychain), `env:<NAME>`, or a literal (discouraged). */
const SecretRef = z.string().min(1);

const parses = (s: string) => {
  try {
    parseDuration(s);
    return true;
  } catch {
    return false;
  }
};
/** A length of time such as 30s, 10m, 2h, 7d. */
const Duration = z.string().refine(parses, { message: 'expected a duration such as 30s, 10m, 2h or 7d' });
/** A duration that drives a timer, so it must fit setTimeout (under ~24.8 days). */
const TimerDuration = Duration.refine((s) => !parses(s) || parseDuration(s) <= MAX_TIMER_MS, {
  message: 'too long for a timer (at most 24d)',
});

const Person = z
  .object({
    trust: z.enum(TRUST_LEVELS).default('member'),
    slack: z.string().optional(),
    telegram: z.string().optional(),
    discord: z.string().optional(),
    feishu: z.string().optional(),
  })
  .strict();

const SlackConfig = z
  .object({ app_token: SecretRef, bot_token: SecretRef })
  .strict();
const TelegramConfig = z.object({ bot_token: SecretRef }).strict();
const FeishuConfig = z
  .object({
    app_id: z.string().min(1),
    app_secret: SecretRef,
    /** feishu = open.feishu.cn (China), lark = open.larksuite.com (international). */
    domain: z.enum(['feishu', 'lark']).default('feishu'),
  })
  .strict();

const ImConfig = z
  .object({
    slack: SlackConfig.optional(),
    telegram: TelegramConfig.optional(),
    feishu: FeishuConfig.optional(),
  })
  .strict()
  .default({});

const ClaudeCodeAgent = z
  .object({
    type: z.literal('claude-code'),
    cwd: z.string().optional(),
    /** Path to the `claude` executable. */
    command: z.string().default('claude'),
    permission_mode: z.enum(['default', 'acceptEdits', 'plan', 'bypassPermissions']).default('default'),
    allowed_tools: z.array(z.string()).default([]),
    model: z.string().optional(),
    /** Give every conversation its own git worktree + branch so parallel threads never touch the same checkout. */
    worktree: z.boolean().default(false),
    worktree_dir: z.string().default('~/.bridge/worktrees'),
    /** Untracked paths linked into each worktree from the main checkout (e.g. node_modules, .env). */
    worktree_links: z.array(z.string()).default([]),
    /** Token used to push conversation branches and open PRs (the `pr` command). */
    git_token: SecretRef.optional(),
    description: z.string().optional(),
  })
  .strict();

const WebhookAgent = z
  .object({
    type: z.literal('webhook'),
    url: z.string().url(),
    headers: z.record(z.string(), SecretRef).default({}),
    timeout: TimerDuration.default('10m'),
    description: z.string().optional(),
  })
  .strict();

const StdioAgent = z
  .object({
    type: z.literal('stdio'),
    command: z.string(),
    args: z.array(z.string()).default([]),
    cwd: z.string().optional(),
    env: z.record(z.string(), SecretRef).default({}),
    /** A turn without a reply after this long fails (the agent is sent a cancel for it). */
    timeout: TimerDuration.default('30m'),
    description: z.string().optional(),
  })
  .strict();

export const AgentConfig = z.discriminatedUnion('type', [ClaudeCodeAgent, WebhookAgent, StdioAgent]);
export type AgentConfig = z.infer<typeof AgentConfig>;

/** An external tool server the bridge proxies: a local MCP process (stdio)… */
const StdioToolServer = z
  .object({
    type: z.literal('mcp').default('mcp'),
    command: z.string(),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), SecretRef).default({}),
    /** How long one tool call may run (progress notifications extend it). */
    timeout: TimerDuration.default('5m'),
    description: z.string().optional(),
  })
  .strict();

/** …or a remote one over HTTP. Header values may be "secret:x", "env:X" or contain ${secret:x} / ${env:X}. */
const HttpToolServer = z
  .object({
    type: z.literal('mcp').default('mcp'),
    url: z.url(),
    /** streamable-http (current spec) or sse (older servers); auto tries streamable-http, then sse. */
    transport: z.enum(['auto', 'streamable-http', 'sse']).default('auto'),
    headers: z.record(z.string(), z.string()).default({}),
    /**
     * Sign in with OAuth (run `bridge auth <server>` once). `true` uses dynamic client
     * registration; servers without it need a pre-registered `client_id` (+ `client_secret`).
     */
    oauth: z
      .union([
        z.literal(true),
        z
          .object({
            scopes: z.array(z.string()).optional(),
            client_id: z.string().optional(),
            client_secret: SecretRef.optional(),
          })
          .strict(),
      ])
      .optional(),
    /** How long one tool call may run (progress notifications extend it). */
    timeout: TimerDuration.default('5m'),
    description: z.string().optional(),
  })
  .strict();

const ToolServer = z.union([StdioToolServer, HttpToolServer]);
export type ToolServerConfig = z.infer<typeof ToolServer>;
export type HttpToolServerConfig = z.infer<typeof HttpToolServer>;

const OneOrMany = z.union([z.string(), z.array(z.string()).min(1)]);

const RouteWhen = z
  .object({
    /**
     * `true`: the bot must be @-mentioned (DMs always count as mentioned). `<agent>`: the bot is mentioned and
     * the message starts with this agent's name. `false`: no mention needed, like `listen: all`.
     * Unset: mention needed in channels unless `listen: all`. Thread replies to the agent never need one.
     */
    mention: z.union([z.boolean(), z.string()]).optional(),
    /** `all`: every message in the channel goes to the agent, no mention needed. */
    listen: z.enum(['all', 'mention']).optional(),
    /** Person ids from `people`, or `anyone`. */
    sender: z.union([z.literal('anyone'), z.array(z.string()).min(1)]).optional(),
  })
  .strict();

export const Route = z
  .object({
    from: z.string().min(1),
    when: RouteWhen.default({}),
    to: OneOrMany,
  })
  .strict();
export type Route = z.infer<typeof Route>;

export const Policy = z
  .object({
    match: z
      .object({
        tool: OneOrMany.optional(),
        /** Only tools that may change something (the MCP server doesn't mark them readOnlyHint). */
        writes: z.boolean().optional(),
        agent: OneOrMany.optional(),
      })
      .strict(),
    approve_by: z.array(z.string()).optional(),
    timeout: TimerDuration.optional(),
    max_hops: z.number().int().positive().optional(),
    budget_usd: z.number().positive().optional(),
  })
  .strict();
export type Policy = z.infer<typeof Policy>;

const Defaults = z
  .object({
    dm_idle_reset: Duration.default('2h'),
    offline_queue_ttl: Duration.default('24h'),
    progress: z.enum(['collapsed', 'verbose', 'off']).default('collapsed'),
    max_hops: z.number().int().positive().default(4),
    /** Attachments larger than this are not downloaded. */
    max_file_mb: z.number().positive().default(20),
    /** Downloaded attachments are deleted after this long. */
    files_ttl: Duration.default('7d'),
    /** Idle conversation worktrees with nothing unmerged are removed after this long ("off" to keep). */
    worktree_prune_after: z.union([z.literal('off'), Duration]).default('7d'),
    /** Trace entries and conversations idle for longer than this are deleted ("off" to keep them forever). */
    retention: z.union([z.literal('off'), Duration]).default('30d'),
  })
  .strict()
  .default({
    dm_idle_reset: '2h',
    offline_queue_ttl: '24h',
    progress: 'collapsed',
    max_hops: 4,
    max_file_mb: 20,
    files_ttl: '7d',
    worktree_prune_after: '7d',
    retention: '30d',
  });

const Server = z
  .object({
    host: z.string().default('127.0.0.1'),
    port: z.number().int().default(7377),
    data_dir: z.string().default('.bridge'),
  })
  .strict()
  .default({ host: '127.0.0.1', port: 7377, data_dir: '.bridge' });

export const BridgeConfig = z
  .object({
    version: z.literal(1).default(1),
    server: Server,
    people: z.record(z.string(), Person).default({}),
    im: ImConfig,
    agents: z.record(z.string(), AgentConfig).default({}),
    tools: z.record(z.string(), ToolServer).default({}),
    routes: z.array(Route).default([]),
    policies: z.array(Policy).default([]),
    defaults: Defaults,
  })
  .strict();
export type BridgeConfig = z.infer<typeof BridgeConfig>;

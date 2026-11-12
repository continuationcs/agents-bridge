import { z } from 'zod';

export const TRUST_LEVELS = ['owner', 'trusted', 'member', 'agent', 'external'] as const;
export type TrustLevel = (typeof TRUST_LEVELS)[number];

/** A credential reference: `secret:<name>` (OS keychain), `env:<NAME>`, or a literal (discouraged). */
const SecretRef = z.string().min(1);

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

const ImConfig = z
  .object({
    slack: SlackConfig.optional(),
    telegram: TelegramConfig.optional(),
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
    worktree_dir: z.string().default('~/.agents-bridge/worktrees'),
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
    timeout: z.string().default('10m'),
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
    description: z.string().optional(),
  })
  .strict();

export const AgentConfig = z.discriminatedUnion('type', [ClaudeCodeAgent, WebhookAgent, StdioAgent]);
export type AgentConfig = z.infer<typeof AgentConfig>;

/** An external tool server the bridge proxies (MCP over stdio). */
const ToolServer = z
  .object({
    type: z.literal('mcp').default('mcp'),
    command: z.string(),
    args: z.array(z.string()).default([]),
    env: z.record(z.string(), SecretRef).default({}),
    description: z.string().optional(),
  })
  .strict();
export type ToolServerConfig = z.infer<typeof ToolServer>;

const OneOrMany = z.union([z.string(), z.array(z.string()).min(1)]);

const RouteWhen = z
  .object({
    /** `true`: the bot must be @-mentioned. `<agent>`: bot mentioned and the message addresses this agent. */
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
    timeout: z.string().optional(),
    max_hops: z.number().int().positive().optional(),
    budget_usd: z.number().positive().optional(),
  })
  .strict();
export type Policy = z.infer<typeof Policy>;

const Defaults = z
  .object({
    dm_idle_reset: z.string().default('2h'),
    offline_queue_ttl: z.string().default('24h'),
    progress: z.enum(['collapsed', 'verbose', 'off']).default('collapsed'),
    max_hops: z.number().int().positive().default(4),
  })
  .strict()
  .default({ dm_idle_reset: '2h', offline_queue_ttl: '24h', progress: 'collapsed', max_hops: 4 });

const Server = z
  .object({
    host: z.string().default('127.0.0.1'),
    port: z.number().int().default(7377),
    data_dir: z.string().default('.agents-bridge'),
  })
  .strict()
  .default({ host: '127.0.0.1', port: 7377, data_dir: '.agents-bridge' });

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

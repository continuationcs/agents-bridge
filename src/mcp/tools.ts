import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpError, type Tool } from '@modelcontextprotocol/sdk/types.js';
import type { HttpToolServerConfig, ToolServerConfig } from '../config/schema.ts';
import { parseDuration } from '../core/address.ts';
import { resolveSecret, resolveTemplate } from '../secrets.ts';
import { BridgeOAuthProvider, NeedsSignIn, type OAuthStorage } from './oauth.ts';

export interface ToolHubOptions {
  /** Needed for tool servers with `oauth`: where tokens live and the redirect URL they were issued for. */
  oauth?: { storage: OAuthStorage; redirectUrl: string };
}

/**
 * External tool servers (MCP over stdio or HTTP). The bridge connects with its own service
 * credentials and re-exposes the tools each agent's routes allow.
 */
export class ToolHub {
  private servers: Record<string, ToolServerConfig>;
  private readonly opts: ToolHubOptions;
  private readonly clients = new Map<string, Promise<Client>>();
  private readonly toolCache = new Map<string, Tool[]>();
  /** Bumped whenever a server's connection is discarded, so late results of an old connection are not cached. */
  private readonly generation = new Map<string, number>();

  constructor(servers: Record<string, ToolServerConfig>, opts: ToolHubOptions = {}) {
    this.servers = servers;
    this.opts = opts;
  }

  config(server: string): ToolServerConfig | undefined {
    return Object.hasOwn(this.servers, server) ? this.servers[server] : undefined;
  }

  serverNames(): string[] {
    return Object.keys(this.servers);
  }

  /** Forget the connection and cached tool list (e.g. after signing in again). */
  async reset(server: string) {
    await this.discard(server);
  }

  /** Config reload: new servers become available; changed or removed ones are disconnected. */
  async update(servers: Record<string, ToolServerConfig>) {
    const old = this.servers;
    this.servers = servers;
    for (const name of Object.keys(old)) {
      if (JSON.stringify(old[name]) !== JSON.stringify(servers[name])) await this.discard(name);
    }
  }

  async listTools(server: string): Promise<Tool[]> {
    const cached = this.toolCache.get(server);
    if (cached) return cached;
    const gen = this.generation.get(server) ?? 0;
    const { tools } = await this.withClient(server, true, (c) => c.listTools());
    if ((this.generation.get(server) ?? 0) === gen) this.toolCache.set(server, tools);
    return tools;
  }

  /** Did the server mark this tool read-only? Unknown tools count as writes. */
  async isReadOnly(server: string, tool: string): Promise<boolean> {
    const t = (await this.listTools(server)).find((x) => x.name === tool);
    return t?.annotations?.readOnlyHint === true;
  }

  async callTool(server: string, tool: string, args: Record<string, unknown>) {
    const cfg = this.mustConfig(server);
    // Replaying a write after an ambiguous failure could run it twice; only read-only tools are retried freely.
    const idempotent = await this.isReadOnly(server, tool);
    return this.withClient(server, idempotent, (c) =>
      c.callTool({ name: tool, arguments: args }, undefined, { timeout: parseDuration(cfg.timeout), resetTimeoutOnProgress: true }),
    );
  }

  async stop() {
    const all = [...this.clients.values()];
    this.clients.clear();
    await Promise.all(all.map((p) => closeQuietly(p)));
  }

  /**
   * Run `fn` on the server's connection. When the connection turns out to be dead, reconnect once and
   * retry — always if the request never reached the server, otherwise only when `idempotent`.
   */
  private async withClient<T>(server: string, idempotent: boolean, fn: (c: Client) => Promise<T>): Promise<T> {
    const p = this.connection(server);
    const client = await p;
    try {
      return await fn(client);
    } catch (err) {
      if (err instanceof McpError) throw err; // the server answered: bad arguments, unknown tool, timeout…
      await this.forget(server, p);
      if (!idempotent && !neverSent(err)) throw err;
      return fn(await this.connection(server));
    }
  }

  private mustConfig(server: string): ToolServerConfig {
    const cfg = this.config(server);
    if (!cfg) throw new Error(`unknown tool server "${server}"`);
    return cfg;
  }

  private connection(server: string): Promise<Client> {
    const existing = this.clients.get(server);
    if (existing) return existing;
    const cfg = this.mustConfig(server);
    const p = 'url' in cfg ? connectHttp(server, cfg, this.opts) : connectStdio(server, cfg);
    this.clients.set(server, p);
    // A failed connect is forgotten so the next call tries again — but only if it is still the current one.
    p.catch(() => {
      if (this.clients.get(server) === p) this.clients.delete(server);
    });
    return p;
  }

  /** Drop this particular connection (not whatever replaced it in the meantime). */
  private async forget(server: string, p: Promise<Client>) {
    if (this.clients.get(server) === p) {
      this.clients.delete(server);
      this.generation.set(server, (this.generation.get(server) ?? 0) + 1);
      this.toolCache.delete(server);
    }
    await closeQuietly(p);
  }

  private async discard(server: string) {
    this.generation.set(server, (this.generation.get(server) ?? 0) + 1);
    this.toolCache.delete(server);
    const p = this.clients.get(server);
    this.clients.delete(server);
    if (p) await closeQuietly(p);
  }
}

async function closeQuietly(p: Promise<Client>) {
  try {
    await (await p).close();
  } catch {
    /* never connected, or already closed */
  }
}

/** Failures where the request cannot have reached the server, so sending it again is safe. */
function neverSent(err: unknown): boolean {
  if (err instanceof StreamableHTTPError && err.code === 404) return true; // session expired: rejected before running
  const code = (err as { cause?: { code?: string } })?.cause?.code;
  if (code === 'ECONNREFUSED') return true;
  return /^Not connected$/.test((err as Error)?.message ?? '');
}

function newClient() {
  return new Client({ name: 'bridge', version: '0.1.0' });
}

/** A local server as a child process. It gets a minimal environment plus its own `env`, never the bridge's secrets. */
async function connectStdio(name: string, cfg: Extract<ToolServerConfig, { command: string }>): Promise<Client> {
  const env = getDefaultEnvironment();
  for (const [k, v] of Object.entries(cfg.env)) env[k] = resolveSecret(v);
  const transport = new StdioClientTransport({ command: cfg.command, args: cfg.args, env, stderr: 'pipe' });
  // Keep the end of stderr so a server that dies at startup can say why.
  let tail = '';
  transport.stderr?.on('data', (chunk: Buffer) => {
    tail = (tail + chunk.toString()).slice(-2000);
  });
  const client = newClient();
  try {
    await client.connect(transport);
    return client;
  } catch (err) {
    const why = tail.trim() ? `\n${tail.trim().split('\n').slice(-5).join('\n')}` : '';
    throw new Error(`${name}: ${(err as Error).message}${why}`);
  }
}

async function connectHttp(name: string, cfg: HttpToolServerConfig, opts: ToolHubOptions): Promise<Client> {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(cfg.headers)) headers[k] = resolveTemplate(v);
  const url = new URL(cfg.url);
  let authProvider: BridgeOAuthProvider | undefined;
  if (cfg.oauth) {
    if (!opts.oauth) throw new Error(`${name}: OAuth tool servers need the bridge's OAuth storage`);
    if (!opts.oauth.storage.get(name).tokens) throw new NeedsSignIn(name);
    authProvider = new BridgeOAuthProvider(name, cfg, opts.oauth.storage, opts.oauth.redirectUrl);
  }
  const init = { requestInit: { headers }, authProvider };
  if (cfg.transport !== 'sse') {
    const client = newClient();
    try {
      await client.connect(new StreamableHTTPClientTransport(url, init));
      return client;
    } catch (err) {
      const e = describe(err, cfg.url);
      if (cfg.transport === 'streamable-http' || err instanceof NeedsSignIn || /unauthorized/.test(e.message)) throw e;
      // auto: older servers only speak SSE (GET /sse + POST /messages).
    }
  }
  const client = newClient();
  try {
    const eventSourceInit = {
      fetch: (u: string | URL, i?: RequestInit) => fetch(u, { ...i, headers: { ...headers, ...(i?.headers as Record<string, string>) } }),
    };
    await client.connect(new SSEClientTransport(url, { ...init, eventSourceInit }));
    return client;
  } catch (err) {
    throw describe(err, cfg.url);
  }
}

function describe(err: unknown, url: string): Error {
  if (err instanceof NeedsSignIn) return err;
  const msg = (err as Error)?.message ?? String(err);
  if (/\b401\b|unauthori[sz]ed/i.test(msg)) return new Error(`${url}: unauthorized — check the headers (API key / bearer token)`);
  return new Error(`${url}: ${msg}`);
}

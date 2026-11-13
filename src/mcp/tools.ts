import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpError, type Tool } from '@modelcontextprotocol/sdk/types.js';
import type { HttpToolServerConfig, ToolServerConfig } from '../config/schema.ts';
import { resolveSecret, resolveTemplate } from '../secrets.ts';

export interface ProxiedTool {
  server: string;
  tool: Tool;
}

/**
 * External tool servers (MCP over stdio or HTTP). The bridge connects with its own service
 * credentials and re-exposes the tools each agent's routes allow.
 */
export class ToolHub {
  private readonly servers: Record<string, ToolServerConfig>;
  private readonly clients = new Map<string, Promise<Client>>();
  private readonly toolCache = new Map<string, Tool[]>();

  constructor(servers: Record<string, ToolServerConfig>) {
    this.servers = servers;
  }

  serverNames(): string[] {
    return Object.keys(this.servers);
  }

  async listTools(server: string): Promise<Tool[]> {
    const cached = this.toolCache.get(server);
    if (cached) return cached;
    const { tools } = await this.retry(server, (c) => c.listTools());
    this.toolCache.set(server, tools);
    return tools;
  }

  /** Did the server mark this tool read-only? Unknown tools count as writes. */
  async isReadOnly(server: string, tool: string): Promise<boolean> {
    const t = (await this.listTools(server)).find((x) => x.name === tool);
    return t?.annotations?.readOnlyHint === true;
  }

  async callTool(server: string, tool: string, args: Record<string, unknown>) {
    return this.retry(server, (c) => c.callTool({ name: tool, arguments: args }));
  }

  /** One reconnect on failure: remote sessions expire, local servers crash. */
  private async retry<T>(server: string, fn: (c: Client) => Promise<T>): Promise<T> {
    try {
      return await fn(await this.client(server));
    } catch (err) {
      if (isToolError(err)) throw err;
      await this.drop(server);
      return fn(await this.client(server));
    }
  }

  private async drop(server: string) {
    const p = this.clients.get(server);
    this.clients.delete(server);
    try {
      await (await p)?.close();
    } catch {
      /* already gone */
    }
  }

  async stop() {
    for (const p of this.clients.values()) {
      try {
        await (await p).close();
      } catch {
        /* already gone */
      }
    }
    this.clients.clear();
  }

  private client(server: string): Promise<Client> {
    let p = this.clients.get(server);
    if (!p) {
      const cfg = this.servers[server];
      if (!cfg) throw new Error(`unknown tool server "${server}"`);
      p = 'url' in cfg ? connectHttp(cfg) : (async () => {
        const env: Record<string, string> = { ...(process.env as Record<string, string>) };
        for (const [k, v] of Object.entries(cfg.env)) env[k] = resolveSecret(v);
        const client = newClient();
        await client.connect(new StdioClientTransport({ command: cfg.command, args: cfg.args, env, stderr: 'ignore' }));
        return client;
      })();
      p.catch(() => this.clients.delete(server));
      this.clients.set(server, p);
    }
    return p;
  }
}

function newClient() {
  return new Client({ name: 'agents-bridge', version: '0.1.0' });
}

async function connectHttp(cfg: HttpToolServerConfig): Promise<Client> {
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(cfg.headers)) headers[k] = resolveTemplate(v);
  const url = new URL(cfg.url);
  const init = { requestInit: { headers } };
  if (cfg.transport !== 'sse') {
    const client = newClient();
    try {
      await client.connect(new StreamableHTTPClientTransport(url, init));
      return client;
    } catch (err) {
      const e = describe(err, cfg.url);
      if (cfg.transport === 'streamable-http' || /unauthorized/.test(e.message)) throw e;
      // auto: older servers only speak SSE (GET /sse + POST /messages).
    }
  }
  const client = newClient();
  try {
    await client.connect(new SSEClientTransport(url, { ...init, eventSourceInit: { fetch: (u, i) => fetch(u, { ...i, headers: { ...headers, ...(i?.headers as Record<string, string>) } }) } }));
    return client;
  } catch (err) {
    throw describe(err, cfg.url);
  }
}

function describe(err: unknown, url: string): Error {
  const msg = (err as Error)?.message ?? String(err);
  if (/\b401\b|unauthori[sz]ed/i.test(msg)) return new Error(`${url}: unauthorized — check the headers (API key / bearer token)`);
  return new Error(`${url}: ${msg}`);
}

/** Errors the server returned on purpose (bad arguments, unknown tool) — reconnecting won't help. */
function isToolError(err: unknown): boolean {
  // McpError = a JSON-RPC error reply. Transport errors (HTTP 404 for an expired session, ECONNRESET…) are not.
  return err instanceof McpError;
}

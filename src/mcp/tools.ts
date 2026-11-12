import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolServerConfig } from '../config/schema.ts';
import { resolveSecret } from '../secrets.ts';

export interface ProxiedTool {
  server: string;
  tool: Tool;
}

/**
 * External tool servers (MCP over stdio). The bridge connects with its own service
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
    const client = await this.client(server);
    const { tools } = await client.listTools();
    this.toolCache.set(server, tools);
    return tools;
  }

  async callTool(server: string, tool: string, args: Record<string, unknown>) {
    const client = await this.client(server);
    return client.callTool({ name: tool, arguments: args });
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
      p = (async () => {
        const env: Record<string, string> = { ...(process.env as Record<string, string>) };
        for (const [k, v] of Object.entries(cfg.env)) env[k] = resolveSecret(v);
        const client = new Client({ name: 'agents-bridge', version: '0.1.0' });
        await client.connect(new StdioClientTransport({ command: cfg.command, args: cfg.args, env, stderr: 'ignore' }));
        return client;
      })();
      p.catch(() => this.clients.delete(server));
      this.clients.set(server, p);
    }
    return p;
  }
}

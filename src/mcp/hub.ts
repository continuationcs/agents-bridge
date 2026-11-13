import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';

/** What one agent turn is allowed to do, keyed by the token in its MCP URL. */
export interface SessionGrant {
  sessionKey: string;
  agent: string;
}

export interface ToolResult {
  text: string;
  isError?: boolean;
}

/** The bridge-side behaviour behind each MCP tool. */
export interface HubBackend {
  listTools(grant: SessionGrant): Promise<Tool[]>;
  callTool(grant: SessionGrant, name: string, args: Record<string, unknown>): Promise<ToolResult>;
  status(): unknown;
  /** Other local routes (dashboard, OAuth); return false to fall through. */
  handleHttp?(req: IncomingMessage, res: import('node:http').ServerResponse, url: URL): Promise<boolean>;
}

/**
 * One local HTTP server. Each agent turn gets its own URL (`/mcp/<token>`), so every
 * tool call is tied to the session that made it and nothing else.
 */
export class McpHub {
  private readonly grants = new Map<string, SessionGrant>();
  private readonly backend: HubBackend;
  private http?: HttpServer;
  private baseUrl = '';

  constructor(backend: HubBackend) {
    this.backend = backend;
  }

  async listen(host: string, port: number): Promise<string> {
    this.http = createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String(err?.message ?? err) }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.http!.once('error', reject);
      this.http!.listen(port, host, () => resolve());
    });
    const addr = this.http.address();
    const actualPort = typeof addr === 'object' && addr ? addr.port : port;
    this.baseUrl = `http://${host}:${actualPort}`;
    return this.baseUrl;
  }

  grant(g: SessionGrant): { url: string; token: string; revoke: () => void } {
    const token = randomBytes(18).toString('base64url');
    this.grants.set(token, g);
    return { url: `${this.baseUrl}/mcp/${token}`, token, revoke: () => this.grants.delete(token) };
  }

  async close() {
    await new Promise<void>((resolve) => (this.http ? this.http.close(() => resolve()) : resolve()));
  }

  private async handle(req: IncomingMessage, res: import('node:http').ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/api/status' && req.method === 'GET') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(this.backend.status()));
      return;
    }
    if (!url.pathname.startsWith('/mcp/') && this.backend.handleHttp && (await this.backend.handleHttp(req, res, url))) return;
    const m = /^\/mcp\/([A-Za-z0-9_-]+)$/.exec(url.pathname);
    const grant = m ? this.grants.get(m[1]!) : undefined;
    if (!grant) {
      res.writeHead(404).end();
      return;
    }
    const body = req.method === 'POST' ? await readJson(req) : undefined;

    // Stateless: a fresh MCP server per request, bound to this grant.
    const server = new Server({ name: 'agents-bridge', version: '0.1.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await this.backend.listTools(grant) }));
    server.setRequestHandler(CallToolRequestSchema, async (r) => {
      try {
        const out = await this.backend.callTool(grant, r.params.name, r.params.arguments ?? {});
        return { content: [{ type: 'text', text: out.text }], isError: out.isError ?? false };
      } catch (err) {
        return { content: [{ type: 'text', text: `error: ${(err as Error).message}` }], isError: true };
      }
    });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const s = Buffer.concat(chunks).toString('utf8');
  return s ? JSON.parse(s) : undefined;
}

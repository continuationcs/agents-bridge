import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { parseConfig } from '../src/config/load.ts';
import { ToolHub } from '../src/mcp/tools.ts';

/** A remote-style MCP server: Streamable HTTP with sessions, bearer auth. */
async function httpToolServer(token: string) {
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  const server: Server = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401).end('unauthorized');
      return;
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
    const sid = req.headers['mcp-session-id'] as string | undefined;
    let transport = sid ? sessions.get(sid) : undefined;
    if (!transport) {
      if (sid) {
        res.writeHead(404).end('session expired');
        return;
      }
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized: (id) => void sessions.set(id, transport!),
      });
      const mcp = new McpServer({ name: 'remote', version: '0.0.0' });
      mcp.registerTool(
        'lookup',
        { description: 'look up', inputSchema: { q: z.string() }, annotations: { readOnlyHint: true } },
        async ({ q }) => ({ content: [{ type: 'text', text: `found ${q}` }] }),
      );
      await mcp.connect(transport);
    }
    await transport.handleRequest(req, res, body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  return { url, sessions, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test('HTTP tool servers: bearer from a secret, list/call, reconnect after the session expires', async () => {
  process.env.AGENTS_BRIDGE_SECRET_REMOTE_TOKEN = 's3cret';
  const srv = await httpToolServer('s3cret');
  const cfg = parseConfig(`
version: 1
tools:
  remote:
    url: ${srv.url}
    headers: { Authorization: "Bearer \${secret:remote_token}" }
`);
  const hub = new ToolHub(cfg.tools);
  try {
    const tools = await hub.listTools('remote');
    assert.deepEqual(tools.map((t) => t.name), ['lookup']);
    assert.equal(await hub.isReadOnly('remote', 'lookup'), true);
    const r1 = (await hub.callTool('remote', 'lookup', { q: 'a' })) as any;
    assert.equal(r1.content[0].text, 'found a');

    srv.sessions.clear(); // server forgot the session → 404 → hub reconnects once
    const r2 = (await hub.callTool('remote', 'lookup', { q: 'b' })) as any;
    assert.equal(r2.content[0].text, 'found b');
  } finally {
    await hub.stop();
    await srv.close();
  }
});

test('HTTP tool servers: a wrong token is reported as unauthorized', async () => {
  const srv = await httpToolServer('right');
  const cfg = parseConfig(`
version: 1
tools:
  remote: { url: ${srv.url}, transport: streamable-http, headers: { Authorization: Bearer wrong } }
`);
  const hub = new ToolHub(cfg.tools);
  try {
    await assert.rejects(hub.listTools('remote'), /unauthorized/);
  } finally {
    await hub.stop();
    await srv.close();
  }
});

test('tool server config: stdio or url, not both', () => {
  assert.throws(() => parseConfig(`
version: 1
tools:
  bad: { command: x, url: "http://localhost/mcp" }
`));
});

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { parseConfig } from '../config/load.ts';
import { ToolHub } from '../mcp/tools.ts';

/** A remote-style MCP server: Streamable HTTP with sessions, bearer auth. */
async function httpToolServer(token: string) {
  const sessions = new Map<string, StreamableHTTPServerTransport>();
  /** Tool runs per name; `dropAfterRun` cuts the connection once the next tool has run, before it answers. */
  const runs: Record<string, number> = {};
  const state = { dropAfterRun: false, socket: undefined as import('node:net').Socket | undefined };
  const ran = (name: string) => {
    runs[name] = (runs[name] ?? 0) + 1;
    if (state.dropAfterRun) {
      state.dropAfterRun = false;
      state.socket?.destroy();
    }
  };
  const server: Server = createServer(async (req, res) => {
    state.socket = req.socket;
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
        async ({ q }) => {
          ran('lookup');
          return { content: [{ type: 'text', text: `found ${q}` }] };
        },
      );
      mcp.registerTool('write', { description: 'changes something', inputSchema: { q: z.string() } }, async ({ q }) => {
        ran('write');
        return { content: [{ type: 'text', text: `wrote ${q}` }] };
      });
      await mcp.connect(transport);
    }
    await transport.handleRequest(req, res, body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  return { url, sessions, runs, state, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test('HTTP tool servers: bearer from a secret, list/call, reconnect after the session expires', async () => {
  process.env.BRIDGE_SECRET_REMOTE_TOKEN = 's3cret';
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
    assert.deepEqual(tools.map((t) => t.name), ['lookup', 'write']);
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

test('config reload adds new tool servers and drops removed ones', async () => {
  const srv = await httpToolServer('t');
  const hub = new ToolHub({});
  try {
    assert.deepEqual(hub.serverNames(), []);
    const cfg = parseConfig(`
version: 1
tools:
  remote: { url: ${srv.url}, headers: { Authorization: Bearer t } }
`);
    await hub.update(cfg.tools);
    assert.equal((await hub.listTools('remote')).length, 2);
    await hub.update({});
    assert.deepEqual(hub.serverNames(), []);
    await assert.rejects(hub.listTools('remote'), /unknown tool server/);
  } finally {
    await hub.stop();
    await srv.close();
  }
});

test('a dropped connection retries read-only tools but never replays a write', async () => {
  const srv = await httpToolServer('t');
  const cfg = parseConfig(`
version: 1
tools:
  remote: { url: ${srv.url}, transport: streamable-http, headers: { Authorization: Bearer t } }
`);
  const hub = new ToolHub(cfg.tools);
  try {
    await hub.listTools('remote');
    srv.state.dropAfterRun = true;
    await assert.rejects(hub.callTool('remote', 'write', { q: 'x' }));
    assert.equal(srv.runs.write, 1, 'the write ran once and was not sent again');

    srv.state.dropAfterRun = true;
    const r = (await hub.callTool('remote', 'lookup', { q: 'y' })) as any;
    assert.equal(r.content[0].text, 'found y');
    assert.equal(srv.runs.lookup, 2, 'the read-only call was retried on a new connection');
  } finally {
    await hub.stop();
    await srv.close();
  }
});

test('a stdio tool server that dies at startup reports its stderr, and gets no bridge secrets', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'bridge-tool-'));
  const script = join(dir, 'crash.mjs');
  writeFileSync(script, `console.error('boom: ' + (process.env.BRIDGE_SECRET_SLACK_BOT_TOKEN ?? 'no secret')); process.exit(3);`);
  process.env.BRIDGE_SECRET_SLACK_BOT_TOKEN = 'xoxb-should-not-leak';
  const cfg = parseConfig(`
version: 1
tools:
  crashy: { command: ${JSON.stringify(process.execPath)}, args: [${JSON.stringify(script)}] }
`);
  const hub = new ToolHub(cfg.tools);
  try {
    await assert.rejects(hub.listTools('crashy'), (err: Error) => {
      assert.match(err.message, /boom: no secret/);
      return true;
    });
  } finally {
    delete process.env.BRIDGE_SECRET_SLACK_BOT_TOKEN;
    await hub.stop();
  }
});

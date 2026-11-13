import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { parseConfig } from '../src/config/load.ts';
import { memoryStorage, OAuthFlows } from '../src/mcp/oauth.ts';
import { ToolHub } from '../src/mcp/tools.ts';

/** A remote MCP server behind its own OAuth authorization server (discovery, DCR, PKCE, refresh). */
async function oauthServer() {
  let base = '';
  const codes = new Map<string, string>(); // code → PKCE challenge
  const valid = new Set<string>(); // access tokens
  const refresh = new Set<string>();
  let n = 0;
  const issue = () => {
    const access = `a${++n}`;
    const r = `r${n}`;
    valid.add(access);
    refresh.add(r);
    return { access_token: access, token_type: 'Bearer', expires_in: 3600, refresh_token: r };
  };
  const body = async (req: IncomingMessage) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return Buffer.concat(chunks).toString();
  };
  const json = (res: any, status: number, v: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(v));

  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, base);
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
      return json(res, 200, { resource: `${base}/mcp`, authorization_servers: [base] });
    }
    if (url.pathname.startsWith('/.well-known/oauth-authorization-server') || url.pathname.startsWith('/.well-known/openid-configuration')) {
      return json(res, 200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      });
    }
    if (url.pathname === '/register' && req.method === 'POST') {
      return json(res, 201, { ...JSON.parse(await body(req)), client_id: 'client-1' });
    }
    if (url.pathname === '/authorize') {
      // The "user" approves at once.
      const code = randomUUID();
      codes.set(code, url.searchParams.get('code_challenge')!);
      const back = new URL(url.searchParams.get('redirect_uri')!);
      back.searchParams.set('code', code);
      back.searchParams.set('state', url.searchParams.get('state')!);
      return res.writeHead(302, { location: back.toString() }).end();
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      const p = new URLSearchParams(await body(req));
      if (p.get('grant_type') === 'authorization_code') {
        const challenge = codes.get(p.get('code')!);
        const s256 = createHash('sha256').update(p.get('code_verifier') ?? '').digest('base64url');
        if (!challenge || challenge !== s256) return json(res, 400, { error: 'invalid_grant' });
        codes.delete(p.get('code')!);
        return json(res, 200, issue());
      }
      if (p.get('grant_type') === 'refresh_token' && refresh.delete(p.get('refresh_token')!)) return json(res, 200, issue());
      return json(res, 400, { error: 'invalid_grant' });
    }
    if (url.pathname === '/mcp') {
      const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
      if (!token || !valid.has(token)) {
        res.writeHead(401, { 'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` });
        return res.end();
      }
      const raw = await body(req);
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      const mcp = new McpServer({ name: 'oauthy', version: '0.0.0' });
      mcp.registerTool('whoami', { description: 'who', annotations: { readOnlyHint: true } }, async () => ({
        content: [{ type: 'text', text: `token ${token}` }],
      }));
      await mcp.connect(transport);
      await transport.handleRequest(req, res, raw ? JSON.parse(raw) : undefined);
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, valid, refresh, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test('OAuth tool servers: sign in through the browser flow, call tools, refresh, and ask to sign in again', async () => {
  const srv = await oauthServer();
  const cfg = parseConfig(`
version: 1
tools:
  remote: { url: "${srv.base}/mcp", transport: streamable-http, oauth: true }
`);
  const storage = memoryStorage();
  const redirectUrl = 'http://127.0.0.1:7377/oauth/callback';
  const hub = new ToolHub(cfg.tools, { oauth: { storage, redirectUrl } });
  const signedIn: string[] = [];
  const flows = new OAuthFlows(() => cfg.tools, storage, redirectUrl, (s) => {
    signedIn.push(s);
    void hub.reset(s);
  });
  try {
    assert.equal(flows.status('remote'), 'signed-out');
    await assert.rejects(hub.listTools('remote'), /not signed in to "remote" — run: agents-bridge auth remote/);

    // Browser: start → provider's /authorize → back to our callback with code + state.
    const authorize = await flows.start('remote');
    assert.equal(authorize.searchParams.get('client_id'), 'client-1'); // registered dynamically
    assert.equal(authorize.searchParams.get('redirect_uri'), redirectUrl);
    const back = await fetch(authorize, { redirect: 'manual' });
    const callback = new URL(back.headers.get('location')!);
    assert.equal(callback.pathname, '/oauth/callback');
    assert.equal(await flows.finish(callback.searchParams), 'remote');
    assert.deepEqual(signedIn, ['remote']);
    assert.equal(flows.status('remote'), 'signed-in');
    assert.equal(storage.get('remote').verifier, undefined);

    const r1 = (await hub.callTool('remote', 'whoami', {})) as any;
    assert.equal(r1.content[0].text, 'token a1');

    // Access token revoked → the SDK refreshes with the refresh token and retries.
    srv.valid.clear();
    const r2 = (await hub.callTool('remote', 'whoami', {})) as any;
    assert.equal(r2.content[0].text, 'token a2');

    // Refresh token revoked too → no browser from a tool call; a clear "sign in" error instead.
    srv.valid.clear();
    srv.refresh.clear();
    await hub.reset('remote');
    await assert.rejects(hub.callTool('remote', 'whoami', {}), /not signed in to "remote"/);

    // A replayed or forged callback is refused.
    await assert.rejects(flows.finish(callback.searchParams), /state mismatch/);
  } finally {
    await hub.stop();
    await srv.close();
  }
});

test('OAuth: sign-in is refused for servers without oauth', async () => {
  const cfg = parseConfig(`
version: 1
tools:
  plain: { url: "http://127.0.0.1:9/mcp" }
`);
  const flows = new OAuthFlows(() => cfg.tools, memoryStorage(), 'http://127.0.0.1:7377/oauth/callback');
  assert.equal(flows.status('plain'), 'not-oauth');
  await assert.rejects(flows.start('plain'), /does not use OAuth/);
});

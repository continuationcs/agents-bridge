import type { IncomingMessage, ServerResponse } from 'node:http';
import type { OAuthFlows } from '../mcp/oauth.ts';
import { PAGE } from './page.ts';

export interface WebSession {
  key: string;
  agent: string;
  platform: string;
  initiator: string;
  createdAt: number;
  lastActive: number;
  spentUsd: number;
  busy: boolean;
  /** The conversation branch, or undefined when the agent has no workspace / no branch yet. */
  branch?: string;
  /** The branch has commits that can be squash-merged now. */
  canMerge?: boolean;
}

export interface WebChoice {
  id: string;
  key: string;
  text: string;
  choices: { label: string; value: string; style?: string }[];
  allowed: string[];
  createdAt: number;
}

export interface WebTool {
  name: string;
  kind: 'stdio' | 'http';
  target: string;
  oauth: 'signed-in' | 'signed-out' | 'not-oauth';
  tools?: number;
  error?: string;
}

/** What the dashboard needs from the bridge. */
export interface WebBackend {
  status(): unknown;
  webSessions(): Promise<WebSession[]>;
  webTrace(sessionKey: string | undefined, limit: number): { ts: number; session: string; kind: string; actor: string; detail: string }[];
  webChoices(): WebChoice[];
  /** Decide a pending choice as the bridge owner; throws when the owner may not decide it. */
  webDecide(id: string, value: string): string;
  /** preview: what would happen; otherwise do it (queued behind the conversation's turns). */
  webWorkspace(key: string, action: 'merge' | 'discard', preview: boolean): Promise<string>;
  webTools(): Promise<WebTool[]>;
  oauth: OAuthFlows;
}

/**
 * The local dashboard: GET / (page), /api/* (JSON), /oauth/* (sign-in).
 * Loopback only. Requests must name this host (no DNS rebinding), and writes must be same-origin JSON
 * (other sites can't send that without a CORS preflight, which this server never grants).
 */
export async function handleWeb(b: WebBackend, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const path = url.pathname;
  const ours = path === '/' || path.startsWith('/api/') || path.startsWith('/oauth/');
  if (!ours) return false;

  if (!isLoopback(req.socket.remoteAddress)) return deny(res, 403, 'the dashboard is only served to this machine');
  const port = req.socket.localPort;
  const host = req.headers.host ?? '';
  if (!['127.0.0.1', 'localhost', '[::1]'].some((h) => host === `${h}:${port}`)) return deny(res, 403, 'unexpected Host header');

  if (path.startsWith('/oauth/')) return b.oauth.handle(req, res, url);

  if (req.method === 'POST') {
    const origin = req.headers.origin;
    if (origin && origin !== `http://${host}`) return deny(res, 403, 'cross-origin request');
    if (!(req.headers['content-type'] ?? '').startsWith('application/json')) return deny(res, 415, 'send application/json');
  }

  try {
    if (path === '/' && req.method === 'GET') {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': "default-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-ancestors 'none'",
        'x-frame-options': 'DENY',
      });
      res.end(PAGE);
      return true;
    }
    if (path === '/api/status' && req.method === 'GET') return json(res, 200, b.status());
    const signIn = /^\/api\/oauth\/([\w.-]+)$/.exec(path);
    if (signIn && req.method === 'GET') {
      return json(res, 200, { status: b.oauth.status(signIn[1]!), last: b.oauth.lastResult(signIn[1]!) ?? null });
    }
    if (path === '/api/overview' && req.method === 'GET') {
      return json(res, 200, { status: b.status(), sessions: await b.webSessions(), choices: b.webChoices() });
    }
    if (path === '/api/trace' && req.method === 'GET') {
      const limit = Math.min(Number(url.searchParams.get('limit') ?? 200) || 200, 2000);
      return json(res, 200, b.webTrace(url.searchParams.get('session') ?? undefined, limit));
    }
    if (path === '/api/tools' && req.method === 'GET') return json(res, 200, await b.webTools());

    if (req.method === 'POST') {
      const body = (await readJson(req)) as Record<string, unknown>;
      const choice = /^\/api\/choices\/([\w-]+)$/.exec(path);
      if (choice) return json(res, 200, { outcome: b.webDecide(choice[1]!, String(body.value ?? '')) });
      const ws = /^\/api\/sessions\/(merge|discard)$/.exec(path);
      if (ws) {
        const key = String(body.key ?? '');
        return json(res, 200, { text: await b.webWorkspace(key, ws[1] as 'merge' | 'discard', body.preview === true) });
      }
      if (path === '/api/oauth/sign-out') {
        b.oauth.signOut(String(body.server ?? ''));
        return json(res, 200, { ok: true });
      }
    }
    return deny(res, 404, 'not found');
  } catch (err) {
    return json(res, 400, { error: (err as Error).message });
  }
}

function isLoopback(addr: string | undefined) {
  return !!addr && (addr === '::1' || addr.startsWith('127.') || addr.startsWith('::ffff:127.'));
}

function json(res: ServerResponse, status: number, v: unknown) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(v));
  return true;
}

function deny(res: ServerResponse, status: number, error: string) {
  return json(res, status, { error });
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 64 * 1024) throw new Error('request too large');
    chunks.push(c as Buffer);
  }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
}

/** The base URL for this machine's browser (a wildcard bind address isn't one). */
export function localBaseUrl(server: { host: string; port: number }) {
  const host = ['0.0.0.0', '::', ''].includes(server.host) ? '127.0.0.1' : server.host;
  return `http://${host.includes(':') ? `[${host}]` : host}:${server.port}`;
}

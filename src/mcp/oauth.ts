import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { auth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { HttpToolServerConfig } from '../config/schema.ts';
import { deleteSecret, readSecret, resolveSecret, setSecret } from '../secrets.ts';

/** Where OAuth state lives. Default: the OS keychain, one item per server (`oauth.<server>`). */
export interface OAuthStorage {
  get(server: string): StoredAuth;
  set(server: string, value: StoredAuth): void;
  delete(server: string): void;
}

export interface StoredAuth {
  /** Registered client (dynamic registration), tied to the redirect URL it was registered with. */
  client?: OAuthClientInformationMixed;
  clientRedirect?: string;
  tokens?: OAuthTokens;
  /** When the access token expires (ms epoch), if the server said. */
  expiresAt?: number;
  verifier?: string;
}

export const keychainStorage: OAuthStorage = {
  get(server) {
    const raw = readSecret(`oauth.${server}`);
    if (!raw) return {};
    try {
      return JSON.parse(raw) as StoredAuth;
    } catch {
      return {};
    }
  },
  set(server, value) {
    setSecret(`oauth.${server}`, JSON.stringify(value));
  },
  delete(server) {
    deleteSecret(`oauth.${server}`);
  },
};

export function memoryStorage(): OAuthStorage {
  const m = new Map<string, StoredAuth>();
  return {
    get: (s) => structuredClone(m.get(s) ?? {}),
    set: (s, v) => void m.set(s, structuredClone(v)),
    delete: (s) => void m.delete(s),
  };
}

export class NeedsSignIn extends Error {
  constructor(server: string) {
    super(`not signed in to "${server}" — run: agents-bridge auth ${server}  (or use Connect in the web UI)`);
  }
}

/**
 * The SDK's OAuth hooks, backed by OAuthStorage. Without `onRedirect` (normal tool calls) it never
 * starts a browser flow: tokens are used and refreshed, and a missing/revoked grant raises NeedsSignIn.
 */
export class BridgeOAuthProvider implements OAuthClientProvider {
  private pendingState?: string;
  private readonly server: string;
  private readonly cfg: HttpToolServerConfig;
  private readonly storage: OAuthStorage;
  readonly redirectUrl: string;
  private readonly onRedirect?: (url: URL) => void;

  constructor(server: string, cfg: HttpToolServerConfig, storage: OAuthStorage, redirectUrl: string, onRedirect?: (url: URL) => void) {
    this.server = server;
    this.cfg = cfg;
    this.storage = storage;
    this.redirectUrl = redirectUrl;
    this.onRedirect = onRedirect;
  }

  private get opts() {
    return typeof this.cfg.oauth === 'object' ? this.cfg.oauth : {};
  }

  get clientMetadata(): OAuthClientMetadata {
    const secret = !!this.opts.client_secret;
    return {
      client_name: 'agents-bridge',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: secret ? 'client_secret_post' : 'none',
      ...(this.opts.scopes?.length ? { scope: this.opts.scopes.join(' ') } : {}),
    };
  }

  state() {
    this.pendingState = randomBytes(16).toString('base64url');
    return this.pendingState;
  }

  get lastState() {
    return this.pendingState;
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    if (this.opts.client_id) {
      return {
        client_id: this.opts.client_id,
        ...(this.opts.client_secret ? { client_secret: resolveSecret(this.opts.client_secret) } : {}),
      };
    }
    const s = this.storage.get(this.server);
    // Registered for another redirect URL (the port changed): register again.
    return s.client && s.clientRedirect === this.redirectUrl ? s.client : undefined;
  }

  saveClientInformation(client: OAuthClientInformationMixed) {
    this.update({ client, clientRedirect: this.redirectUrl });
  }

  tokens(): OAuthTokens | undefined {
    return this.storage.get(this.server).tokens;
  }

  saveTokens(tokens: OAuthTokens) {
    this.update({ tokens, expiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined });
  }

  redirectToAuthorization(url: URL) {
    if (!this.onRedirect) throw new NeedsSignIn(this.server);
    this.onRedirect(url);
  }

  saveCodeVerifier(verifier: string) {
    this.update({ verifier });
  }

  codeVerifier(): string {
    const v = this.storage.get(this.server).verifier;
    if (!v) throw new Error('no PKCE verifier saved — start the sign-in again');
    return v;
  }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery') {
    const s = this.storage.get(this.server);
    if (scope === 'all' || scope === 'client') delete s.client, delete s.clientRedirect;
    if (scope === 'all' || scope === 'tokens') delete s.tokens, delete s.expiresAt;
    if (scope === 'all' || scope === 'verifier') delete s.verifier;
    this.storage.set(this.server, s);
  }

  private update(patch: Partial<StoredAuth>) {
    this.storage.set(this.server, { ...this.storage.get(this.server), ...patch });
  }
}

export type OAuthStatus = 'signed-in' | 'signed-out' | 'not-oauth';

/**
 * Browser sign-in flows: GET /oauth/start/<server> redirects to the provider, which comes back to
 * GET /oauth/callback. Served by the bridge's local HTTP server (or a temporary one from the CLI).
 */
export class OAuthFlows {
  private readonly pending = new Map<string, { server: string; provider: BridgeOAuthProvider; at: number }>();

  private readonly servers: () => Record<string, unknown>;
  readonly storage: OAuthStorage;
  readonly redirectUrl: string;
  /** Called after a sign-in or sign-out (e.g. to reconnect the tool server). */
  private readonly onSignedIn: (server: string) => void;

  constructor(servers: () => Record<string, unknown>, storage: OAuthStorage, redirectUrl: string, onSignedIn: (server: string) => void = () => {}) {
    this.servers = servers;
    this.storage = storage;
    this.redirectUrl = redirectUrl;
    this.onSignedIn = onSignedIn;
  }

  private config(server: string): HttpToolServerConfig {
    const cfg = this.servers()[server] as HttpToolServerConfig | undefined;
    if (!cfg) throw new Error(`unknown tool server "${server}"`);
    if (!('url' in cfg) || !cfg.oauth) throw new Error(`tool server "${server}" does not use OAuth (add  oauth: true  to it)`);
    return cfg;
  }

  status(server: string): OAuthStatus {
    const cfg = this.servers()[server] as HttpToolServerConfig | undefined;
    if (!cfg || !('url' in cfg) || !cfg.oauth) return 'not-oauth';
    return this.storage.get(server).tokens ? 'signed-in' : 'signed-out';
  }

  /** Begin a sign-in; returns the provider URL to send the browser to. */
  async start(server: string): Promise<URL> {
    const cfg = this.config(server);
    let target: URL | undefined;
    const provider = new BridgeOAuthProvider(server, cfg, this.storage, this.redirectUrl, (u) => (target = u));
    provider.invalidateCredentials('tokens'); // an explicit sign-in always asks again
    const scope = typeof cfg.oauth === 'object' ? cfg.oauth.scopes?.join(' ') : undefined;
    const result = await auth(provider, { serverUrl: cfg.url, scope });
    if (result !== 'REDIRECT' || !target) throw new Error(`sign-in to "${server}" did not ask for authorization (${result})`);
    const state = target.searchParams.get('state') ?? provider.lastState;
    if (!state) throw new Error('the authorization URL has no state parameter');
    for (const [k, v] of this.pending) if (Date.now() - v.at > 15 * 60e3) this.pending.delete(k);
    this.pending.set(state, { server, provider, at: Date.now() });
    return target;
  }

  /** The provider redirected back; exchange the code. Returns the server name. */
  async finish(params: URLSearchParams): Promise<string> {
    const error = params.get('error');
    const state = params.get('state') ?? '';
    const flow = this.pending.get(state);
    if (!flow) throw new Error('unknown or expired sign-in (state mismatch) — start again');
    this.pending.delete(state);
    if (error) throw new Error(`${flow.server}: ${error}${params.get('error_description') ? ` — ${params.get('error_description')}` : ''}`);
    const code = params.get('code');
    if (!code) throw new Error('the provider sent no authorization code');
    const cfg = this.config(flow.server);
    const result = await auth(flow.provider, { serverUrl: cfg.url, authorizationCode: code });
    if (result !== 'AUTHORIZED') throw new Error(`token exchange for "${flow.server}" failed`);
    this.storage.set(flow.server, { ...this.storage.get(flow.server), verifier: undefined });
    this.onSignedIn(flow.server);
    return flow.server;
  }

  signOut(server: string) {
    this.config(server);
    this.storage.delete(server);
    this.onSignedIn(server);
  }

  /** Handles /oauth/start/<server> and /oauth/callback; false for other paths. */
  async handle(req: IncomingMessage, res: ServerResponse, url: URL, done?: (server: string, err?: Error) => void): Promise<boolean> {
    if (req.method !== 'GET') return false;
    const start = /^\/oauth\/start\/([\w.-]+)$/.exec(url.pathname);
    if (start) {
      try {
        const target = await this.start(start[1]!);
        res.writeHead(302, { location: target.toString() }).end();
      } catch (err) {
        page(res, 400, 'Sign-in failed', (err as Error).message);
        done?.(start[1]!, err as Error);
      }
      return true;
    }
    if (url.pathname === '/oauth/callback') {
      try {
        const server = await this.finish(url.searchParams);
        page(res, 200, `Signed in to ${server}`, 'You can close this tab. The bridge uses the new token from its next tool call.');
        done?.(server);
      } catch (err) {
        page(res, 400, 'Sign-in failed', (err as Error).message);
        done?.('', err as Error);
      }
      return true;
    }
    return false;
  }
}

function page(res: ServerResponse, status: number, title: string, body: string) {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  res.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
  res.end(
    `<!doctype html><meta charset="utf-8"><title>${esc(title)}</title>` +
      `<body style="font:16px system-ui;max-width:36rem;margin:4rem auto;padding:0 1rem">` +
      `<h1 style="font-size:1.3rem">${status === 200 ? '✅' : '⚠️'} ${esc(title)}</h1><p>${esc(body)}</p>` +
      `<p><a href="/">Open the bridge dashboard</a></p></body>`,
  );
}

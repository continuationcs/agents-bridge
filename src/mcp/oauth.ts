import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { auth, type OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { HttpToolServerConfig } from '../config/schema.ts';
import { registerSecret } from '../core/redact.ts';
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
}

/**
 * Keychain-backed storage with an in-memory copy: the SDK asks for tokens on every request, and
 * reading the keychain spawns a process. Writes go through to the keychain immediately.
 */
export function keychainStorage(): OAuthStorage {
  const cache = new Map<string, StoredAuth>();
  const load = (server: string): StoredAuth => {
    const hit = cache.get(server);
    if (hit) return hit;
    const raw = readSecret(`oauth.${server}`);
    let value: StoredAuth = {};
    if (raw) {
      try {
        value = JSON.parse(raw) as StoredAuth;
      } catch {
        throw new Error(`the stored sign-in for "${server}" is unreadable — run: bridge auth ${server} --sign-out, then sign in again`);
      }
    }
    registerTokens(value);
    cache.set(server, value);
    return value;
  };
  return {
    get: (server) => structuredClone(load(server)),
    set(server, value) {
      setSecret(`oauth.${server}`, JSON.stringify(value));
      registerTokens(value);
      cache.set(server, structuredClone(value));
    },
    delete(server) {
      deleteSecret(`oauth.${server}`);
      cache.delete(server);
    },
  };
}

function registerTokens(value: StoredAuth) {
  for (const t of [value.tokens?.access_token, value.tokens?.refresh_token]) if (t) registerSecret(t);
}

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
    super(`not signed in to "${server}" — run: bridge auth ${server}  (or use Connect in the web UI)`);
  }
}

/**
 * The SDK's OAuth hooks for one tool server.
 *
 * Normal use (no `flow`): stored tokens are used and refreshed; a missing or revoked grant raises
 * NeedsSignIn — a tool call never opens a browser.
 *
 * Sign-in (`flow`): starts from no tokens and keeps the PKCE verifier and any new client registration in
 * memory, so an abandoned or concurrent sign-in never disturbs the stored grant. Only a successful token
 * exchange replaces what is stored.
 */
export class BridgeOAuthProvider implements OAuthClientProvider {
  private readonly server: string;
  private readonly cfg: HttpToolServerConfig;
  private readonly storage: OAuthStorage;
  readonly redirectUrl: string;
  private readonly flow?: { onRedirect: (url: URL) => void };
  private verifier?: string;
  private flowClient?: OAuthClientInformationMixed;
  private flowTokens?: OAuthTokens;

  constructor(
    server: string,
    cfg: HttpToolServerConfig,
    storage: OAuthStorage,
    redirectUrl: string,
    flow?: { onRedirect: (url: URL) => void },
  ) {
    this.server = server;
    this.cfg = cfg;
    this.storage = storage;
    this.redirectUrl = redirectUrl;
    this.flow = flow;
  }

  private get opts() {
    return typeof this.cfg.oauth === 'object' ? this.cfg.oauth : {};
  }

  get clientMetadata(): OAuthClientMetadata {
    const secret = !!this.opts.client_secret;
    return {
      client_name: 'bridge',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: secret ? 'client_secret_post' : 'none',
      ...(this.opts.scopes?.length ? { scope: this.opts.scopes.join(' ') } : {}),
    };
  }

  state() {
    return randomBytes(16).toString('base64url');
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    if (this.opts.client_id) {
      return {
        client_id: this.opts.client_id,
        ...(this.opts.client_secret ? { client_secret: resolveSecret(this.opts.client_secret) } : {}),
      };
    }
    if (this.flowClient) return this.flowClient;
    const s = this.storage.get(this.server);
    // Registered for another redirect URL (the port changed): register again.
    return s.client && s.clientRedirect === this.redirectUrl ? s.client : undefined;
  }

  saveClientInformation(client: OAuthClientInformationMixed) {
    if (this.flow) this.flowClient = client;
    else this.update({ client, clientRedirect: this.redirectUrl });
  }

  tokens(): OAuthTokens | undefined {
    return this.flow ? this.flowTokens : this.storage.get(this.server).tokens;
  }

  saveTokens(tokens: OAuthTokens) {
    if (this.flow) this.flowTokens = tokens;
    // A sign-in stores its client together with the tokens it was issued for.
    this.update({ tokens, ...(this.flowClient ? { client: this.flowClient, clientRedirect: this.redirectUrl } : {}) });
  }

  redirectToAuthorization(url: URL) {
    if (!this.flow) throw new NeedsSignIn(this.server);
    this.flow.onRedirect(url);
  }

  saveCodeVerifier(verifier: string) {
    this.verifier = verifier;
  }

  codeVerifier(): string {
    if (!this.verifier) throw new Error('no sign-in in progress — start it again');
    return this.verifier;
  }

  invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery') {
    if (scope === 'discovery') return;
    if (scope === 'verifier') {
      this.verifier = undefined;
      return;
    }
    if (this.flow) {
      if (scope !== 'tokens') this.flowClient = undefined;
      if (scope !== 'client') this.flowTokens = undefined;
      return;
    }
    const s = this.storage.get(this.server);
    if (scope === 'all' || scope === 'client') delete s.client, delete s.clientRedirect;
    if (scope === 'all' || scope === 'tokens') delete s.tokens;
    this.storage.set(this.server, s);
  }

  private update(patch: Partial<StoredAuth>) {
    this.storage.set(this.server, { ...this.storage.get(this.server), ...patch });
  }
}

export type OAuthStatus = 'signed-in' | 'signed-out' | 'not-oauth';

export interface SignInResult {
  at: number;
  ok: boolean;
  error?: string;
}

/**
 * Browser sign-in flows: GET /oauth/start/<server> redirects to the provider, which comes back to
 * GET /oauth/callback. Served by the bridge's local HTTP server (or a temporary one from the CLI).
 */
export class OAuthFlows {
  private readonly pending = new Map<string, { server: string; provider: BridgeOAuthProvider; at: number }>();
  private readonly results = new Map<string, SignInResult>();
  private readonly servers: () => Record<string, unknown>;
  readonly storage: OAuthStorage;
  readonly redirectUrl: string;
  /** Called after a sign-in or sign-out (e.g. to reconnect the tool server). */
  private readonly onChange: (server: string) => void;

  constructor(servers: () => Record<string, unknown>, storage: OAuthStorage, redirectUrl: string, onChange: (server: string) => void = () => {}) {
    this.servers = servers;
    this.storage = storage;
    this.redirectUrl = redirectUrl;
    this.onChange = onChange;
  }

  private oauthConfig(server: string): HttpToolServerConfig | undefined {
    const all = this.servers();
    const cfg = Object.hasOwn(all, server) ? (all[server] as HttpToolServerConfig) : undefined;
    return cfg && 'url' in cfg && cfg.oauth ? cfg : undefined;
  }

  private config(server: string): HttpToolServerConfig {
    const cfg = this.oauthConfig(server);
    if (!cfg) {
      if (!Object.hasOwn(this.servers(), server)) throw new Error(`unknown tool server "${server}"`);
      throw new Error(`tool server "${server}" does not use OAuth (add  oauth: true  to it)`);
    }
    return cfg;
  }

  status(server: string): OAuthStatus {
    if (!this.oauthConfig(server)) return 'not-oauth';
    return this.storage.get(server).tokens ? 'signed-in' : 'signed-out';
  }

  /** How the latest sign-in to this server ended, if one ended since the bridge started. */
  lastResult(server: string): SignInResult | undefined {
    return this.results.get(server);
  }

  /** Begin a sign-in; returns the provider URL to send the browser to. Stored tokens stay until it succeeds. */
  async start(server: string): Promise<URL> {
    const cfg = this.config(server);
    let target: URL | undefined;
    const provider = new BridgeOAuthProvider(server, cfg, this.storage, this.redirectUrl, { onRedirect: (u) => (target = u) });
    const scope = typeof cfg.oauth === 'object' ? cfg.oauth.scopes?.join(' ') : undefined;
    const result = await auth(provider, { serverUrl: cfg.url, scope });
    if (result !== 'REDIRECT' || !target) throw new Error(`sign-in to "${server}" did not ask for authorization (${result})`);
    const state = target.searchParams.get('state');
    if (!state) throw new Error('the authorization URL has no state parameter');
    for (const [k, v] of this.pending) if (Date.now() - v.at > 15 * 60e3) this.pending.delete(k);
    this.pending.set(state, { server, provider, at: Date.now() });
    return target;
  }

  /** The provider redirected back; exchange the code. Returns the server name. */
  async finish(params: URLSearchParams): Promise<string> {
    const state = params.get('state') ?? '';
    const flow = this.pending.get(state);
    if (!flow) throw new Error('unknown or expired sign-in (state mismatch) — start again');
    this.pending.delete(state);
    try {
      const error = params.get('error');
      if (error) throw new Error(`${flow.server}: ${error}${params.get('error_description') ? ` — ${params.get('error_description')}` : ''}`);
      const code = params.get('code');
      if (!code) throw new Error('the provider sent no authorization code');
      const result = await auth(flow.provider, { serverUrl: this.config(flow.server).url, authorizationCode: code });
      if (result !== 'AUTHORIZED') throw new Error(`token exchange for "${flow.server}" failed`);
    } catch (err) {
      this.results.set(flow.server, { at: Date.now(), ok: false, error: (err as Error).message });
      throw err;
    }
    this.results.set(flow.server, { at: Date.now(), ok: true });
    this.onChange(flow.server);
    return flow.server;
  }

  signOut(server: string) {
    this.config(server);
    this.storage.delete(server);
    this.onChange(server);
  }

  /**
   * Handles /oauth/start/<server> and /oauth/callback; false for other paths.
   * Starting is only allowed from a navigation the user made (address bar, `bridge auth`, or the
   * dashboard): another site embedding the URL must not be able to begin flows.
   */
  async handle(req: IncomingMessage, res: ServerResponse, url: URL, done?: (server: string, err?: Error) => void): Promise<boolean> {
    if (req.method !== 'GET') return false;
    const start = /^\/oauth\/start\/([\w.-]+)$/.exec(url.pathname);
    if (start) {
      const site = req.headers['sec-fetch-site'];
      if (site !== 'same-origin' && site !== 'none') {
        page(res, 403, 'Sign-in not started', 'Open the sign-in from the bridge dashboard or with `bridge auth <server>`.');
        return true;
      }
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

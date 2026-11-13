#!/usr/bin/env node
import { existsSync, watch, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve, join, dirname, basename } from 'node:path';
import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { ConfigError, loadConfigFile } from './config/load.ts';
import type { BridgeConfig } from './config/schema.ts';
import { Bridge } from './core/bridge.ts';
import { Router } from './core/router.ts';
import { Store } from './core/store.ts';
import { LocalConsoleAdapter } from './adapters/im/local.ts';
import { SlackAdapter } from './adapters/im/slack.ts';
import { TelegramAdapter } from './adapters/im/telegram.ts';
import { FeishuAdapter } from './adapters/im/feishu.ts';
import type { ImAdapter } from './adapters/im/types.ts';
import { ToolHub } from './mcp/tools.ts';
import { keychainStorage, OAuthFlows } from './mcp/oauth.ts';
import { localBaseUrl } from './web/api.ts';
import { createServer } from 'node:http';
import { envRefs, keychainRead, resolveSecret, setSecret } from './secrets.ts';
import { TEMPLATE } from './template.ts';
import { slackManifest } from './slack-manifest.ts';
import { expandHome, listWorktrees, removeAt, sessionSlug, statusAt } from './adapters/agent/worktree.ts';
import { parseDuration } from './core/address.ts';
import { installService, restartService, serviceStatus, uninstallService } from './service.ts';

const HELP = `bridge — connect agents to IM, to each other, and to tools

Usage: bridge <command> [options]

  init                     write a starter bridge.yaml
  up                       connect IMs and start routing
  chat --as <person>       talk to your routes from this terminal (routes from local:*)
  doctor                   check config, secrets, agents and tool servers
  routes explain           show which route a message would take
                             --from slack:#dev --sender alice [--text "..."] [--mention] [--dm]
  slack manifest [name]    print a Slack app manifest (Socket Mode, DMs, channels)
  feishu setup             how to create the Feishu / Lark app, with the scopes to import
  secret set <name>        store a secret in the OS keychain (value read from stdin)
  service install|uninstall|restart|status
                           run the bridge in the background via launchd (macOS)
  worktrees                list conversation branches (claude-code agents with worktree: true)
  worktrees prune          remove idle worktrees with nothing unmerged  [--older-than 7d] [--force]
  auth [<server>]          sign in to an OAuth tool server in the browser (no name: list them)
                             [--sign-out]
  dashboard                open the local web dashboard (http://127.0.0.1:7377)
  status                   show the running bridge
  sessions                 list recent sessions
  trace [--session <key>]  show the audit trail

Options: -c, --config <path>   (default ./bridge.yaml)
`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      config: { type: 'string', short: 'c', default: 'bridge.yaml' },
      as: { type: 'string' },
      from: { type: 'string' },
      sender: { type: 'string' },
      text: { type: 'string', default: '' },
      mention: { type: 'boolean', default: false },
      dm: { type: 'boolean', default: false },
      session: { type: 'string' },
      limit: { type: 'string', short: 'n', default: '50' },
      force: { type: 'boolean', default: false },
      'sign-out': { type: 'boolean', default: false },
      'older-than': { type: 'string', default: '7d' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [cmd, sub, arg] = positionals;
  const configPath = resolve(values.config!);

  if (!cmd || values.help) return void process.stdout.write(HELP);

  switch (cmd) {
    case 'init': {
      if (existsSync(configPath) && !values.force) fail(`${configPath} exists (use --force to overwrite)`);
      writeFileSync(configPath, TEMPLATE);
      console.log(`wrote ${configPath}\nnext: edit it, then run "bridge doctor" and "bridge chat --as me"`);
      return;
    }
    case 'up':
      return run(configPath, (cfg) => buildIms(cfg, resolve(configPath, '..', cfg.server.data_dir)));
    case 'chat': {
      if (!values.as) fail('chat needs --as <person id from people:>');
      return run(configPath, () => [new LocalConsoleAdapter({ as: values.as! })], { quiet: true });
    }
    case 'doctor':
      return doctor(configPath);
    case 'routes': {
      if (sub !== 'explain') fail('usage: bridge routes explain --from <im:channel> --sender <person>');
      const cfg = load(configPath);
      const from = values.from ?? fail('--from is required, e.g. --from slack:#dev');
      const i = from.indexOf(':');
      const platform = from.slice(0, i);
      const channel = from.slice(i + 1).replace(/^#/, '');
      const sender = values.sender;
      const userId = sender ? ((cfg.people[sender] as Record<string, string> | undefined)?.[platform] ?? sender) : 'unknown';
      const { trace } = new Router(cfg).explainInbound(
        {
          platform,
          channelId: channel,
          channelName: channel,
          isDM: values.dm || channel === 'dm',
          userId,
          text: values.text!,
          mentioned: values.mention!,
          threadId: '1',
          messageId: '1',
        },
        { personId: sender && cfg.people[sender] ? sender : undefined },
      );
      for (const line of trace) console.log(line);
      return;
    }
    case 'service': {
      // launchd opens the log itself, and it can't write into TCC-protected folders like ~/Documents.
      const logFile = join(homedir(), 'Library', 'Logs', 'bridge', 'bridge.log');
      if (sub === 'install') {
        checkServiceSecrets(load(configPath)); // refuse a config the service couldn't start with
        const plist = installService({ configPath, logFile });
        console.log(`installed ${plist}\nlogs: ${logFile}`);
      } else if (sub === 'uninstall') {
        uninstallService();
        console.log('service removed');
      } else if (sub === 'restart') {
        restartService();
        console.log('restarted');
      } else if (sub === 'status') {
        console.log(JSON.stringify(serviceStatus(), null, 2));
      } else fail('usage: bridge service install|uninstall|restart|status');
      return;
    }
    case 'worktrees': {
      const cfg = load(configPath);
      const store = openStore(cfg, configPath);
      const sessions = new Map(store.listSessions(10_000).map((s) => [sessionSlug(s.key), s]));
      const prune = sub === 'prune';
      if (sub && !prune) fail('usage: bridge worktrees [prune [--older-than 7d] [--force]]');
      const cutoff = Date.now() - parseDuration(values['older-than']!);
      let count = 0;
      for (const [name, agent] of Object.entries(cfg.agents)) {
        if (agent.type !== 'claude-code' || !agent.worktree) continue;
        for (const wt of await listWorktrees(expandHome(agent.cwd ?? process.cwd()))) {
          const session = sessions.get(wt.branch.replace(/^bridge\//, ''));
          const last = session?.last_active;
          if (prune && last && last > cutoff) continue;
          try {
            const st = await statusAt(wt.root, wt.path, wt.branch, agent.worktree_links);
            // Unknown (base branch gone, git failing) counts as unmerged.
            const commits = st ? (st.commits ? String(st.commits.length) : 'unknown') : '0';
            const unmerged = !!st && (!st.commits || st.commits.length > 0 || st.dirty.length > 0);
            if (prune) {
              if (unmerged && !values.force) {
                console.log(`kept    ${wt.branch}  (${commits} unmerged commits, ${st?.dirty.length ?? 0} uncommitted files; --force to remove)`);
                continue;
              }
              await removeAt(wt.root, wt.path, wt.branch);
              if (session) store.deleteSession(session.key);
              console.log(`removed ${wt.branch}`);
              count++;
              continue;
            }
            count++;
            console.log(
              `${wt.branch}  [${name}]  base ${st?.base ?? '?'}  ${commits} commits  ${st?.dirty.length ?? 0} uncommitted  ` +
                `last active ${last ? new Date(last).toISOString() : 'unknown'}\n  ${wt.path}${session ? `\n  session ${session.key}` : ''}` +
                (st?.note ? `\n  note: ${st.note}` : ''),
            );
          } catch (err) {
            console.log(`error   ${wt.branch}  ${(err as Error).message}`);
          }
        }
      }
      if (!count) console.log(prune ? 'nothing to prune' : 'no conversation worktrees');
      return;
    }
    case 'feishu': {
      if (sub !== 'setup') fail('usage: bridge feishu setup');
      process.stdout.write(FEISHU_SETUP);
      return;
    }
    case 'slack': {
      if (sub !== 'manifest') fail('usage: bridge slack manifest [app name]');
      process.stdout.write(slackManifest(arg));
      return;
    }
    case 'secret': {
      if (sub !== 'set' || !arg) fail('usage: bridge secret set <name>');
      const value = await readSecretValue(`value for ${arg}: `);
      setSecret(arg, value);
      console.log(`stored secret:${arg}`);
      return;
    }
    case 'auth': {
      await auth(load(configPath), sub, values['sign-out']!);
      return;
    }
    case 'dashboard': {
      const base = localBaseUrl(load(configPath).server);
      if (!(await reachable(base))) fail('bridge is not running (start it with "bridge up" or "bridge service install")');
      openBrowser(`${base}/`);
      console.log(`${base}/`);
      return;
    }
    case 'status': {
      const cfg = load(configPath);
      try {
        const res = await fetch(`${localBaseUrl(cfg.server)}/api/status`);
        console.log(JSON.stringify(await res.json(), null, 2));
      } catch {
        fail('bridge is not running (start it with "bridge up")');
      }
      return;
    }
    case 'sessions': {
      const store = openStore(load(configPath), configPath);
      for (const s of store.listSessions(Number(values.limit))) {
        console.log(`${new Date(s.last_active).toISOString()}  ${s.agent.padEnd(16)} $${s.spent_usd.toFixed(3)}  ${s.key}`);
      }
      return;
    }
    case 'trace': {
      const store = openStore(load(configPath), configPath);
      for (const t of store.readTrace({ sessionKey: values.session, limit: Number(values.limit) })) {
        console.log(`${new Date(t.ts).toISOString()}  ${t.kind.padEnd(11)} ${t.actor.padEnd(16)} ${t.session_key}  ${t.detail}`);
      }
      return;
    }
    default:
      fail(`unknown command "${cmd}"\n\n${HELP}`);
  }
}

async function run(configPath: string, ims: (cfg: BridgeConfig) => ImAdapter[], opts: { quiet?: boolean } = {}) {
  const cfg = load(configPath);
  const store = openStore(cfg, configPath);
  const log = opts.quiet ? (l: string) => void (l.startsWith('inbound error') && console.error(l)) : (l: string) => console.log(l);
  const filesDir = join(resolve(configPath, '..', cfg.server.data_dir), 'files');
  const bridge = new Bridge({ cfg, store, ims: ims(cfg), filesDir, log });
  const { mcpUrl } = await bridge.start();
  log(`bridge up — MCP hub ${mcpUrl}, ${Object.keys(cfg.agents).length} agents, ${cfg.routes.length} routes`);
  log(`dashboard: ${localBaseUrl(cfg.server)}/`);

  let timer: NodeJS.Timeout | undefined;
  // Watch the directory: editors that replace the file would orphan a file watcher.
  watch(dirname(configPath), (_event, file) => {
    if (file && file !== basename(configPath)) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        bridge.reload(loadConfigFile(configPath));
      } catch (err) {
        console.error(`config not reloaded: ${(err as Error).message}`);
      }
    }, 300);
  });

  const shutdown = async () => {
    await bridge.stop();
    store.close();
    process.exit(0);
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

function buildIms(cfg: BridgeConfig, dataDir: string): ImAdapter[] {
  const ims: ImAdapter[] = [];
  if (cfg.im.slack) {
    ims.push(new SlackAdapter({ appToken: resolveSecret(cfg.im.slack.app_token), botToken: resolveSecret(cfg.im.slack.bot_token) }));
  }
  if (cfg.im.telegram) {
    ims.push(new TelegramAdapter({ botToken: resolveSecret(cfg.im.telegram.bot_token), stateFile: join(dataDir, 'telegram.json') }));
  }
  if (cfg.im.feishu) {
    ims.push(
      new FeishuAdapter({ appId: cfg.im.feishu.app_id, appSecret: resolveSecret(cfg.im.feishu.app_secret), domain: cfg.im.feishu.domain }),
    );
  }
  if (!ims.length) fail('no IM configured under im: — add one, or try "bridge chat --as <person>"');
  return ims;
}

async function doctor(configPath: string) {
  let ok = true;
  const check = async (label: string, fn: () => unknown | Promise<unknown>) => {
    try {
      const detail = await fn();
      console.log(`✓ ${label}${typeof detail === 'string' && detail ? ` — ${detail}` : ''}`);
    } catch (err) {
      ok = false;
      console.log(`✗ ${label} — ${(err as Error).message}`);
    }
  };
  let cfg: BridgeConfig | undefined;
  await check(`config ${configPath}`, () => {
    cfg = load(configPath, false);
    return `${Object.keys(cfg.agents).length} agents, ${Object.keys(cfg.tools).length} tool servers, ${cfg.routes.length} routes`;
  });
  if (!cfg) process.exit(1);
  const c = cfg;
  for (const [im, conf] of Object.entries(c.im)) {
    for (const [field, ref] of Object.entries(conf as Record<string, string>)) {
      await check(`${im}.${field}`, () => void resolveSecret(ref));
    }
  }
  for (const [name, a] of Object.entries(c.agents)) {
    if (a.type === 'claude-code') {
      await check(`agent ${name}`, () => execFileSync(a.command, ['--version'], { encoding: 'utf8' }).trim());
    } else if (a.type === 'stdio') {
      await check(`agent ${name}`, () => execFileSync('which', [a.command], { encoding: 'utf8' }).trim());
    } else {
      await check(`agent ${name}`, async () => {
        const res = await fetch(a.url, { method: 'OPTIONS', signal: AbortSignal.timeout(3000) }).catch((e) => {
          throw new Error(`unreachable (${e.cause?.code ?? e.message})`);
        });
        return `HTTP ${res.status}`;
      });
    }
  }
  const hub = new ToolHub(c.tools, { oauth: { storage: keychainStorage(), redirectUrl: `${localBaseUrl(c.server)}/oauth/callback` } });
  for (const name of Object.keys(c.tools)) {
    await check(`tool server ${name}`, async () => `${(await hub.listTools(name)).length} tools`);
  }
  await hub.stop();
  process.exit(ok ? 0 : 1);
}

function load(path: string, exitOnError = true): BridgeConfig {
  if (!existsSync(path)) {
    const msg = `no config at ${path} — run "bridge init"`;
    if (exitOnError) fail(msg);
    throw new Error(msg);
  }
  try {
    return loadConfigFile(path);
  } catch (err) {
    if (!exitOnError) throw err;
    fail(err instanceof ConfigError ? err.message : String(err));
  }
}

function openStore(cfg: BridgeConfig, configPath: string): Store {
  const dir = resolve(configPath, '..', cfg.server.data_dir);
  return new Store(join(dir, 'bridge.db'));
}

function readSecretValue(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    return new Promise((res) => {
      let s = '';
      process.stdin.on('data', (d) => (s += d)).on('end', () => res(s.trim()));
    });
  }
  return new Promise((res) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s) => {
      if (s.includes(prompt)) process.stdout.write(prompt);
    };
    rl.question(prompt, (v) => {
      rl.close();
      process.stdout.write('\n');
      res(v.trim());
    });
  });
}

const FEISHU_SETUP = `Feishu (open.feishu.cn/app) or Lark (open.larksuite.com/app) → Create custom app, then:

1. Add features → Bot.
2. Permissions & Scopes → batch import (批量导入/导出权限), paste:
${JSON.stringify(
  {
    scopes: {
      tenant: [
        'im:message',
        'im:message:send_as_bot',
        'im:message.p2p_msg:readonly',
        'im:message.group_at_msg:readonly',
        'im:message.group_msg',
        'im:resource',
        'im:chat:readonly',
      ],
      user: [],
    },
  },
  null,
  2,
)}
   (im:message.group_msg is only needed for routes with \`listen: all\`.)
3. Events & Callbacks:
   - Event configuration → subscription mode: "Receive events through persistent connection" (长连接),
     add event im.message.receive_v1.
   - Callback configuration → same persistent-connection mode, add card.action.trigger.
   (Start "bridge up" first: the console only saves long-connection mode while a client is connected.)
4. Version Management & Release → create a version and publish it (an admin may need to approve).
5. Credentials & Basic Info → copy App ID and App Secret:
     bridge secret set feishu_app_secret
   and in bridge.yaml:
     im:
       feishu: { app_id: cli_xxx, app_secret: secret:feishu_app_secret, domain: feishu }   # or lark
`;

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

main().catch((err) => fail(err?.stack ?? String(err)));

async function reachable(base: string): Promise<boolean> {
  try {
    return (await fetch(`${base}/api/status`, { signal: AbortSignal.timeout(1500) })).ok;
  } catch {
    return false;
  }
}

function openBrowser(url: string) {
  try {
    execFileSync(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { stdio: 'ignore' });
  } catch {
    /* printed anyway */
  }
}

/** Sign in to an OAuth tool server: through the running bridge, or a temporary local listener. */
async function auth(cfg: BridgeConfig, server: string | undefined, signOut: boolean) {
  const base = localBaseUrl(cfg.server);
  const flows = new OAuthFlows(() => cfg.tools, keychainStorage(), `${base}/oauth/callback`);
  const oauthServers = Object.keys(cfg.tools).filter((n) => flows.status(n) !== 'not-oauth');
  if (!server) {
    if (!oauthServers.length) return void console.log('No tool servers use OAuth (add  oauth: true  to an HTTP tool server).');
    for (const n of oauthServers) console.log(`${flows.status(n) === 'signed-in' ? '✓' : '✗'} ${n}  ${flows.status(n)}`);
    return;
  }
  if (flows.status(server) === 'not-oauth') fail(`"${server}" is not an OAuth tool server (${oauthServers.length ? `OAuth servers: ${oauthServers.join(', ')}` : 'none configured'})`);
  const running = await reachable(base);
  if (signOut) {
    // The running bridge owns its copy of the tokens; otherwise forget them here.
    if (running) {
      const res = await fetch(`${base}/api/oauth/sign-out`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ server }) });
      if (!res.ok) fail(`sign-out failed: ${((await res.json()) as { error?: string }).error ?? res.status}`);
    } else flows.signOut(server);
    return void console.log(`signed out of ${server}`);
  }

  const start = `${base}/oauth/start/${encodeURIComponent(server)}`;
  if (running) {
    // The running bridge handles the callback; wait for this sign-in's outcome.
    const begun = Date.now();
    console.log(`Opening ${start}\nFinish signing in in the browser…`);
    openBrowser(start);
    const until = begun + 10 * 60e3;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 1000));
      const res = await fetch(`${base}/api/oauth/${encodeURIComponent(server)}`).catch(() => undefined);
      if (!res?.ok) continue;
      const { last } = (await res.json()) as { last: { at: number; ok: boolean; error?: string } | null };
      if (!last || last.at < begun) continue;
      if (last.ok) return void console.log(`✓ signed in to ${server}`);
      fail(`sign-in failed: ${last.error ?? 'unknown error'}`);
    }
    fail('timed out waiting for the sign-in (10 minutes)');
  }

  // Bridge not running: serve the callback ourselves on the same address.
  await new Promise<void>((resolveDone, reject) => {
    const http = createServer((req, res) => {
      const url = new URL(req.url ?? '/', base);
      void flows.handle(req, res, url, (name, err) => {
        if (err) reject(err);
        else if (name) resolveDone();
      }).then((handled) => handled || res.writeHead(404).end());
    });
    http.once('error', reject);
    http.listen(cfg.server.port, new URL(base).hostname.replace(/^\[|\]$/g, ''), () => {
      console.log(`Opening ${start}\nFinish signing in in the browser…`);
      openBrowser(start);
    });
    setTimeout(() => reject(new Error('timed out waiting for the sign-in (10 minutes)')), 10 * 60e3).unref();
  }).then(
    () => console.log(`✓ signed in to ${server}`),
    (err) => fail(`sign-in failed: ${(err as Error).message}`),
  );
  process.exit(0);
}

/**
 * launchd starts the bridge with a bare environment: every secret must be in the keychain.
 * Fail now rather than leave a service that restarts forever.
 */
function checkServiceSecrets(cfg: BridgeConfig) {
  const problems: string[] = [];
  const visit = (v: unknown, path: string) => {
    if (typeof v === 'string') {
      for (const name of envRefs(v)) problems.push(`${path}: env:${name} is not available to the service — store it with "bridge secret set" and use secret:`);
      for (const m of v.matchAll(/(?:^|\$\{)secret:([^}\s]+)/g)) {
        try {
          if (keychainRead(m[1]!) === undefined) problems.push(`${path}: secret "${m[1]}" is not in the keychain — run: bridge secret set ${m[1]}`);
        } catch (err) {
          problems.push(`${path}: ${(err as Error).message}`);
        }
      }
    } else if (Array.isArray(v)) v.forEach((x, i) => visit(x, `${path}[${i}]`));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) visit(x, path ? `${path}.${k}` : k);
  };
  visit(cfg, '');
  if (problems.length) fail(`the service could not start with this config:\n  ${problems.join('\n  ')}`);
}

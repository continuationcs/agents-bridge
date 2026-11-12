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
import type { ImAdapter } from './adapters/im/types.ts';
import { ToolHub } from './mcp/tools.ts';
import { resolveSecret, setSecret } from './secrets.ts';
import { TEMPLATE } from './template.ts';
import { slackManifest } from './slack-manifest.ts';
import { installService, restartService, serviceStatus, uninstallService } from './service.ts';

const HELP = `agents-bridge — connect agents to IM, to each other, and to tools

Usage: agents-bridge <command> [options]

  init                     write a starter bridge.yaml
  up                       connect IMs and start routing
  chat --as <person>       talk to your routes from this terminal (routes from local:*)
  doctor                   check config, secrets, agents and tool servers
  routes explain           show which route a message would take
                             --from slack:#dev --sender alice [--text "..."] [--mention] [--dm]
  slack manifest [name]    print a Slack app manifest (Socket Mode, DMs, channels)
  secret set <name>        store a secret in the OS keychain (value read from stdin)
  service install|uninstall|restart|status
                           run the bridge in the background via launchd (macOS)
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
      console.log(`wrote ${configPath}\nnext: edit it, then run "agents-bridge doctor" and "agents-bridge chat --as me"`);
      return;
    }
    case 'up':
      return run(configPath, (cfg) => buildIms(cfg));
    case 'chat': {
      if (!values.as) fail('chat needs --as <person id from people:>');
      return run(configPath, () => [new LocalConsoleAdapter({ as: values.as! })], { quiet: true });
    }
    case 'doctor':
      return doctor(configPath);
    case 'routes': {
      if (sub !== 'explain') fail('usage: agents-bridge routes explain --from <im:channel> --sender <person>');
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
      load(configPath); // refuse to install a service with a broken config
      // launchd opens the log itself, and it can't write into TCC-protected folders like ~/Documents.
      const logFile = join(homedir(), 'Library', 'Logs', 'agents-bridge', 'bridge.log');
      if (sub === 'install') {
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
      } else fail('usage: agents-bridge service install|uninstall|restart|status');
      return;
    }
    case 'slack': {
      if (sub !== 'manifest') fail('usage: agents-bridge slack manifest [app name]');
      process.stdout.write(slackManifest(arg));
      return;
    }
    case 'secret': {
      if (sub !== 'set' || !arg) fail('usage: agents-bridge secret set <name>');
      const value = await readSecretValue(`value for ${arg}: `);
      setSecret(arg, value);
      console.log(`stored secret:${arg}`);
      return;
    }
    case 'status': {
      const cfg = load(configPath);
      try {
        const res = await fetch(`http://${cfg.server.host}:${cfg.server.port}/api/status`);
        console.log(JSON.stringify(await res.json(), null, 2));
      } catch {
        fail('bridge is not running (start it with "agents-bridge up")');
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
  const bridge = new Bridge({ cfg, store, ims: ims(cfg), tools: new ToolHub(cfg.tools), log });
  const { mcpUrl } = await bridge.start();
  log(`agents-bridge up — MCP hub ${mcpUrl}, ${Object.keys(cfg.agents).length} agents, ${cfg.routes.length} routes`);

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

function buildIms(cfg: BridgeConfig): ImAdapter[] {
  const ims: ImAdapter[] = [];
  if (cfg.im.slack) {
    ims.push(new SlackAdapter({ appToken: resolveSecret(cfg.im.slack.app_token), botToken: resolveSecret(cfg.im.slack.bot_token) }));
  }
  if (cfg.im.telegram) ims.push(new TelegramAdapter({ botToken: resolveSecret(cfg.im.telegram.bot_token) }));
  if (!ims.length) fail('no IM configured under im: — add one, or try "agents-bridge chat --as <person>"');
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
  const hub = new ToolHub(c.tools);
  for (const name of Object.keys(c.tools)) {
    await check(`tool server ${name}`, async () => `${(await hub.listTools(name)).length} tools`);
  }
  await hub.stop();
  process.exit(ok ? 0 : 1);
}

function load(path: string, exitOnError = true): BridgeConfig {
  if (!existsSync(path)) {
    const msg = `no config at ${path} — run "agents-bridge init"`;
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

function fail(msg: string): never {
  console.error(msg);
  process.exit(1);
}

main().catch((err) => fail(err?.stack ?? String(err)));

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Run the bridge as a macOS LaunchAgent: starts at login, restarted by launchd if it exits. */
const LABEL = 'dev.agents-bridge';
const PLIST = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const domain = () => `gui/${process.getuid!()}`;

export function installService(opts: { configPath: string; logFile: string }) {
  assertMac();
  const cli = join(dirname(fileURLToPath(import.meta.url)), 'cli.js');
  if (!existsSync(cli)) throw new Error(`${cli} not found — run "npm run build" first`);
  mkdirSync(dirname(PLIST), { recursive: true });
  mkdirSync(dirname(opts.logFile), { recursive: true });
  writeFileSync(
    PLIST,
    plist({
      Label: LABEL,
      ProgramArguments: [process.execPath, cli, 'up', '--config', opts.configPath],
      WorkingDirectory: dirname(opts.configPath),
      // launchd starts with a bare PATH; keep the one that found node and claude.
      EnvironmentVariables: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
      RunAtLoad: true,
      KeepAlive: true,
      ThrottleInterval: 10,
      StandardOutPath: opts.logFile,
      StandardErrorPath: opts.logFile,
    }),
  );
  launchctl(['bootout', `${domain()}/${LABEL}`], true);
  launchctl(['bootstrap', domain(), PLIST]);
  return PLIST;
}

export function uninstallService() {
  assertMac();
  launchctl(['bootout', `${domain()}/${LABEL}`], true);
  if (existsSync(PLIST)) unlinkSync(PLIST);
}

export function restartService() {
  assertMac();
  launchctl(['kickstart', '-k', `${domain()}/${LABEL}`]);
}

export function serviceStatus(): { installed: boolean; state?: string; pid?: number; lastExit?: string } {
  assertMac();
  if (!existsSync(PLIST)) return { installed: false };
  const out = launchctl(['print', `${domain()}/${LABEL}`], true);
  if (!out) return { installed: true, state: 'not loaded' };
  const field = (name: string) => new RegExp(`^\\s*${name} = (.+)$`, 'm').exec(out)?.[1]?.trim();
  return { installed: true, state: field('state'), pid: Number(field('pid')) || undefined, lastExit: field('last exit code') };
}

function launchctl(args: string[], tolerateFailure = false): string {
  try {
    return execFileSync('launchctl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    if (tolerateFailure) return '';
    const e = err as { stderr?: string; message: string };
    throw new Error(`launchctl ${args[0]} failed: ${(e.stderr ?? e.message).trim()}`);
  }
}

function assertMac() {
  if (process.platform !== 'darwin') throw new Error('service commands use launchd and only work on macOS for now');
}

function plist(obj: Record<string, unknown>): string {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const val = (v: unknown, pad: string): string => {
    if (typeof v === 'boolean') return `${pad}<${v}/>`;
    if (typeof v === 'number') return `${pad}<integer>${v}</integer>`;
    if (typeof v === 'string') return `${pad}<string>${esc(v)}</string>`;
    if (Array.isArray(v)) return `${pad}<array>\n${v.map((x) => val(x, pad + '  ')).join('\n')}\n${pad}</array>`;
    const entries = Object.entries(v as Record<string, unknown>)
      .map(([k, x]) => `${pad}  <key>${esc(k)}</key>\n${val(x, pad + '  ')}`)
      .join('\n');
    return `${pad}<dict>\n${entries}\n${pad}</dict>`;
  };
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
${val(obj, '')}
</plist>
`;
}

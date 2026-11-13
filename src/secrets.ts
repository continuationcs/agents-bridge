import { execFileSync } from 'node:child_process';
import { registerSecret } from './core/redact.ts';

/** Keychain service name for every secret the bridge stores. */
const SERVICE = 'dev.bridge';
/** `security` exits with this when the item does not exist. */
const NOT_FOUND = 44;

/** Resolve `secret:<name>` (OS keychain, falling back to BRIDGE_SECRET_<NAME>), `env:<NAME>`, or a literal. */
export function resolveSecret(ref: string): string {
  const value = lookup(ref);
  // Anything that came from a secret store or the environment is kept out of the audit trail.
  if (value !== ref) registerSecret(value);
  return value;
}

function lookup(ref: string): string {
  if (ref.startsWith('env:')) {
    const name = ref.slice(4);
    const v = process.env[name];
    if (!v) throw new Error(`environment variable ${name} is not set`);
    return v;
  }
  if (ref.startsWith('secret:')) {
    const name = ref.slice(7);
    const v = process.env[envName(name)] || keychainRead(name);
    if (v === undefined) throw new Error(`secret "${name}" not found — run: bridge secret set ${name}  (or set ${envName(name)})`);
    return v;
  }
  return ref;
}

/** A value that is a secret ref ("secret:x" / "env:X"), or a string with ${secret:x} / ${env:X} inside. */
export function resolveTemplate(value: string): string {
  if (/\$\{(secret|env):[^}]+\}/.test(value)) {
    return value.replace(/\$\{((?:secret|env):[^}]+)\}/g, (_, ref: string) => resolveSecret(ref));
  }
  return resolveSecret(value);
}

/** Every `env:` reference in a value (whole ref or ${env:X} inside a template). */
export function envRefs(value: string): string[] {
  if (value.startsWith('env:')) return [value.slice(4)];
  return [...value.matchAll(/\$\{env:([^}]+)\}/g)].map((m) => m[1]!);
}

export function setSecret(name: string, value: string) {
  if (process.platform !== 'darwin') {
    throw new Error(`no keychain support on ${process.platform} yet — export ${envName(name)} instead`);
  }
  // `security -i` takes one command per line; a line break would end the value and start another command.
  if (/[\r\n]/.test(value)) throw new Error('secrets must be a single line');
  if (!value) throw new Error('empty secret');
  // `security -i` reads the command from stdin, so the value never appears in argv (visible to `ps`).
  const q = (v: string) => `"${v.replace(/(["\\])/g, '\\$1')}"`;
  const out = execFileSync('security', ['-i'], {
    input: `add-generic-password -U -s ${q(SERVICE)} -a ${q(name)} -w ${q(value)}\n`,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  // `security -i` exits 0 even when a command fails, so check that the value really landed.
  if (keychainRead(name) !== value) {
    throw new Error(`the keychain did not store "${name}"${out.trim() ? `: ${out.trim()}` : ''}`);
  }
}

/** Read a stored secret, or undefined when there is none. Keychain failures (locked, denied) throw. */
export function readSecret(name: string): string | undefined {
  return process.env[envName(name)] || keychainRead(name);
}

export function deleteSecret(name: string) {
  if (process.platform !== 'darwin') return;
  try {
    execFileSync('security', ['delete-generic-password', '-s', SERVICE, '-a', name], { stdio: 'ignore' });
  } catch (err) {
    if ((err as { status?: number }).status !== NOT_FOUND) throw new Error(`could not delete "${name}" from the keychain`);
  }
}

/** The keychain alone (no environment fallback): what a background service will find. */
export function keychainRead(name: string): string | undefined {
  if (process.platform !== 'darwin') return undefined;
  try {
    return execFileSync('security', ['find-generic-password', '-s', SERVICE, '-a', name, '-w'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).replace(/\n$/, '');
  } catch (err) {
    if ((err as { status?: number }).status === NOT_FOUND) return undefined;
    const why = String((err as { stderr?: string }).stderr ?? '').trim();
    throw new Error(`could not read "${name}" from the keychain${why ? `: ${why}` : ''}`);
  }
}

function envName(name: string) {
  return `BRIDGE_SECRET_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

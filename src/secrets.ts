import { execFileSync } from 'node:child_process';

const SERVICE = 'agents-bridge';

/** Resolve `secret:<name>` (OS keychain, falling back to AGENTS_BRIDGE_SECRET_<NAME>), `env:<NAME>`, or a literal. */
export function resolveSecret(ref: string): string {
  if (ref.startsWith('env:')) {
    const name = ref.slice(4);
    const v = process.env[name];
    if (!v) throw new Error(`environment variable ${name} is not set`);
    return v;
  }
  if (ref.startsWith('secret:')) {
    const name = ref.slice(7);
    const fromEnv = process.env[envName(name)];
    if (fromEnv) return fromEnv;
    if (process.platform === 'darwin') {
      try {
        return execFileSync('security', ['find-generic-password', '-s', SERVICE, '-a', name, '-w'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
      } catch {
        /* fall through */
      }
    }
    throw new Error(`secret "${name}" not found — run: agents-bridge secret set ${name}  (or set ${envName(name)})`);
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

export function setSecret(name: string, value: string) {
  if (process.platform !== 'darwin') {
    throw new Error(`no keychain support on ${process.platform} yet — export ${envName(name)} instead`);
  }
  // `security -i` reads the command from stdin, so the value never appears in argv (visible to `ps`).
  const q = (v: string) => `"${v.replace(/(["\\])/g, '\\$1')}"`;
  execFileSync('security', ['-i'], {
    input: `add-generic-password -U -s ${q(SERVICE)} -a ${q(name)} -w ${q(value)}\n`,
    stdio: ['pipe', 'ignore', 'pipe'],
  });
}

function envName(name: string) {
  return `AGENTS_BRIDGE_SECRET_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
}

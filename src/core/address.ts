/**
 * Endpoint addresses as written in bridge.yaml:
 *   slack:#dev      IM channel by name      telegram:*   any chat on that IM
 *   slack:dm        direct messages         local:*      the `agents-bridge chat` console
 *   claude-code     an agent                github.push  tool `push` on tool server `github`
 */
export type Address =
  | { kind: 'im'; platform: string; channel: string }
  | { kind: 'agent'; name: string };

export const IM_PLATFORMS = new Set(['slack', 'telegram', 'discord', 'feishu', 'local']);

export function parseAddress(s: string): Address {
  const i = s.indexOf(':');
  if (i > 0 && IM_PLATFORMS.has(s.slice(0, i))) {
    return { kind: 'im', platform: s.slice(0, i), channel: s.slice(i + 1) || '*' };
  }
  return { kind: 'agent', name: s };
}

/** Glob match where `*` matches any run of characters (including dots). */
export function globMatch(pattern: string, value: string): boolean {
  if (pattern === '*') return true;
  const re = new RegExp('^' + pattern.split('*').map(escapeRe).join('.*') + '$', 'i');
  return re.test(value);
}

export function anyGlob(patterns: string | string[] | undefined, value: string): boolean {
  if (patterns === undefined) return false;
  return (Array.isArray(patterns) ? patterns : [patterns]).some((p) => globMatch(p, value));
}

function escapeRe(s: string) {
  return s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

/** "90s", "10m", "2h", "1d" → milliseconds. */
export function parseDuration(s: string): number {
  const m = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/.exec(s.trim());
  if (!m) throw new Error(`bad duration "${s}" (use e.g. 30s, 10m, 2h)`);
  const n = Number(m[1]);
  const unit = { ms: 1, s: 1e3, m: 60e3, h: 3600e3, d: 86400e3 }[m[2] as 'ms' | 's' | 'm' | 'h' | 'd'];
  return n * unit;
}

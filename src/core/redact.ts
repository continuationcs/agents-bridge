/** Keeping credentials out of the audit trail. */

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/xox[abposr]-[A-Za-z0-9-]{10,}/g, '[redacted]'], // Slack tokens
  [/xapp-[A-Za-z0-9-]{10,}/g, '[redacted]'], // Slack app tokens
  [/\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g, '[redacted]'], // Telegram bot tokens
  [/\bsk-[A-Za-z0-9_-]{16,}/g, '[redacted]'], // API keys
  [/\bgh[pousr]_[A-Za-z0-9]{20,}/g, '[redacted]'], // GitHub tokens
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, '[redacted]'], // GitHub fine-grained tokens
  [/\bya29\.[A-Za-z0-9._-]{20,}/g, '[redacted]'], // Google OAuth access tokens
  [/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, '[redacted]'], // AWS access key ids
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[redacted]'], // JWTs
  [/\b[tua]-[A-Za-z0-9]{30,}\b/g, '[redacted]'], // Feishu / Lark tenant, user and app access tokens
  [/\b(Bearer|Basic|token)\s+[A-Za-z0-9._~+/-]{16,}=*/gi, '$1 [redacted]'], // Authorization header schemes
  // JSON fields that name a credential: "app_secret": "…", "access_token": "…", "password": "…"
  [/("[\w-]*(?:secret|token|password|passwd|api[_-]?key)[\w-]*"\s*:\s*")(?:[^"\\]|\\.){8,}"/gi, '$1[redacted]"'],
];

/** Exact credential values the bridge resolved (IM tokens, header and env secrets, OAuth tokens). */
const knownSecrets = new Set<string>();

/**
 * Redact this exact value from everything written to the trace from now on. Call it for every credential
 * the process resolves; values shorter than 8 characters are ignored (they would redact ordinary words).
 */
export function registerSecret(value: string): void {
  if (value.length >= 8) knownSecrets.add(value);
}

/** The audit log keeps everything except credentials. */
export function redact(s: string): string {
  // Longest first, so a secret that contains another is removed whole.
  let out = s;
  for (const secret of [...knownSecrets].sort((a, b) => b.length - a.length)) {
    out = out.split(secret).join('[redacted]');
    // The trace stores JSON, where a secret with quotes, backslashes or control characters appears escaped.
    const escaped = JSON.stringify(secret).slice(1, -1);
    if (escaped !== secret) out = out.split(escaped).join('[redacted]');
  }
  return SECRET_PATTERNS.reduce((acc, [re, to]) => acc.replace(re, to), out);
}

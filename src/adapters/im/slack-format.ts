/**
 * Standard Markdown (what agents write) → Slack mrkdwn.
 * Slack has no headings or tables and uses *bold*, _italic_, ~strike~, <url|text>.
 * Tables become aligned monospace blocks; code is left untouched.
 */
export function toSlackMrkdwn(md: string): string {
  const out: string[] = [];
  const lines = md.replace(/\r\n/g, '\n').split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    // Fenced code: copy verbatim, drop the language tag Slack would print.
    const fence = /^(\s*)(```|~~~)/.exec(line);
    if (fence) {
      const marker = fence[2]!;
      out.push('```');
      i++;
      while (i < lines.length && !lines[i]!.trimStart().startsWith(marker)) out.push(lines[i++]!);
      out.push('```');
      continue;
    }

    // Table: header row, then a |---|---| separator.
    if (isTableRow(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1]!)) {
      const rows = [cells(line)];
      i += 2;
      while (i < lines.length && isTableRow(lines[i]!)) rows.push(cells(lines[i++]!));
      i--;
      out.push(renderTable(rows));
      continue;
    }

    const heading = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      // The whole heading is bold already; inner bold markers would nest badly.
      out.push(`*${inline(heading[1]!.replace(/\*\*|__/g, ''))}*`);
      continue;
    }
    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push('──────────');
      continue;
    }
    const quote = /^(\s*>+\s?)(.*)$/.exec(line);
    if (quote) {
      out.push(`> ${inline(quote[2]!)}`);
      continue;
    }
    const bullet = /^(\s*)[-*+]\s+(\[[ xX]\]\s+)?(.*)$/.exec(line);
    if (bullet) {
      const indent = ' '.repeat(Math.floor(bullet[1]!.length / 2) * 4);
      const box = bullet[2] ? (/x/i.test(bullet[2]) ? '☑ ' : '☐ ') : '';
      out.push(`${indent}• ${box}${inline(bullet[3]!)}`);
      continue;
    }
    out.push(inline(line));
  }
  return out.join('\n');
}

/** Inline spans, with `code` protected from every other rule. */
function inline(text: string): string {
  return text
    .split(/(`[^`\n]+`)/)
    .map((part, idx) => (idx % 2 === 1 ? part : inlinePlain(part)))
    .join('');
}

const BOLD = '\u0001';

function inlinePlain(s: string): string {
  s = s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // Links and images: [text](url) → <url|text>
  s = s.replace(/!?\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (_m, label: string, url: string) =>
    label ? `<${url}|${label}>` : `<${url}>`,
  );
  // Bold first (into a placeholder), so single-* italics don't eat it.
  s = s.replace(/\*\*(?=\S)([^*]+?)(?<=\S)\*\*/g, `${BOLD}$1${BOLD}`);
  s = s.replace(/__(?=\S)([^_]+?)(?<=\S)__/g, `${BOLD}$1${BOLD}`);
  s = s.replace(/(^|[^\w*])\*(?=\S)([^*\n]+?)(?<=\S)\*(?!\w)/g, '$1_$2_');
  s = s.replace(/~~(?=\S)([^~]+?)(?<=\S)~~/g, '~$1~');
  return s.replaceAll(BOLD, '*');
}

export function isTableRow(line: string) {
  const t = line.trim();
  return t.startsWith('|') && t.length > 1;
}

export function isTableSeparator(line: string) {
  return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
}

export function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, '|'));
}

/** Table cells go into a code block, so strip markdown that would show literally. */
export function plain(s: string): string {
  return s
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/<br\s*\/?>/gi, ' ');
}

/** Wider than this (in monospace columns) and a table would wrap in Slack, so rows become records. */
const MAX_TABLE_WIDTH = 60;

function renderTable(raw: string[][]): string {
  const rows = raw.map((r) => r.map(plain));
  const cols = Math.max(...rows.map((r) => r.length));
  const total = Array.from({ length: cols }, (_, c) => Math.max(...rows.map((r) => width(r[c] ?? '')))).reduce(
    (a, b) => a + b + 2,
    0,
  );
  return total > MAX_TABLE_WIDTH ? renderRecords(raw) : renderGrid(rows);
}

/** One block per row: the first cell as a bold title, the rest as "header: value" bullets. */
function renderRecords(rows: string[][]): string {
  const [header, ...body] = rows;
  const head = header!.map((h) => plain(h));
  return body
    .map((r) => {
      const title = `*${inline(r[0] ?? '').replace(/\*/g, '')}*`;
      const items = r.slice(1).flatMap((cell, i) => {
        const parts = cell.split(/<br\s*\/?>/i).map((p) => inline(p.trim())).filter(Boolean);
        const label = head[i + 1] ? `${head[i + 1]}: ` : '';
        if (parts.length <= 1) return [`• ${label}${parts[0] ?? '—'}`];
        return [`• ${label}`, ...parts.map((p) => `    ◦ ${p}`)];
      });
      return [title, ...items].join('\n');
    })
    .join('\n\n');
}

function renderGrid(rows: string[][]): string {
  const cols = Math.max(...rows.map((r) => r.length));
  const widths = Array.from({ length: cols }, (_, c) => Math.max(...rows.map((r) => width(r[c] ?? ''))));
  const fmt = (r: string[]) =>
    widths
      .map((w, c) => pad(r[c] ?? '', w))
      .join('  ')
      .trimEnd();
  const lines = [fmt(rows[0]!), widths.map((w) => '─'.repeat(w)).join('  '), ...rows.slice(1).map(fmt)];
  return ['```', ...lines, '```'].join('\n');
}

function pad(s: string, w: number) {
  return s + ' '.repeat(Math.max(0, w - width(s)));
}

/** Display width in a monospace font: CJK and full-width characters take two columns. */
export function width(s: string): number {
  let n = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    n +=
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe4f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1faff) ||
      (cp >= 0x20000 && cp <= 0x3fffd)
        ? 2
        : 1;
  }
  return n;
}

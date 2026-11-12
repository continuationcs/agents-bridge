import { cells, isTableRow, isTableSeparator, plain } from './slack-format.ts';

/**
 * Standard Markdown (what agents write) → Feishu/Lark card markdown.
 * Cards render **bold**, *italic*, ~~strike~~, links, lists and code, but not headings or tables:
 * headings become bold lines, and each table row becomes a bold title with "column: value" bullets.
 */
export function toFeishuMarkdown(md: string): string {
  const out: string[] = [];
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    const fence = /^\s*(```|~~~)/.exec(line);
    if (fence) {
      out.push(line);
      i++;
      while (i < lines.length && !lines[i]!.trimStart().startsWith(fence[1]!)) out.push(lines[i++]!);
      if (i < lines.length) out.push(lines[i]!);
      continue;
    }

    if (isTableRow(line) && i + 1 < lines.length && isTableSeparator(lines[i + 1]!)) {
      const head = cells(line).map(plain);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && isTableRow(lines[i]!)) rows.push(cells(lines[i++]!));
      i--;
      out.push(
        rows
          .map((r) => {
            const items = r.slice(1).flatMap((cell, c) => {
              const parts = cell.split(/<br\s*\/?>/i).map((p) => p.trim()).filter(Boolean);
              const label = head[c + 1] ? `${head[c + 1]}: ` : '';
              if (parts.length <= 1) return [`- ${label}${parts[0] ?? '—'}`];
              return [`- ${label}`, ...parts.map((p) => `    - ${p}`)];
            });
            return [`**${plain(r[0] ?? '')}**`, ...items].join('\n');
          })
          .join('\n\n'),
      );
      continue;
    }

    const heading = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      out.push(`**${heading[1]!.replace(/\*\*|__/g, '')}**`);
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toSlackMrkdwn, width } from '../src/adapters/im/slack-format.ts';
import { split } from '../src/core/bridge.ts';

test('inline formatting', () => {
  assert.equal(toSlackMrkdwn('**bold** and *it* and ~~gone~~'), '*bold* and _it_ and ~gone~');
  assert.equal(toSlackMrkdwn('see [docs](https://x.dev/a?b=1&c=2)'), 'see <https://x.dev/a?b=1&amp;c=2|docs>');
  assert.equal(toSlackMrkdwn('a < b && `x **not bold** <y>`'), 'a &lt; b &amp;&amp; `x **not bold** <y>`');
  assert.equal(toSlackMrkdwn('2 * 3 * 4'), '2 * 3 * 4');
});

test('block formatting', () => {
  assert.equal(toSlackMrkdwn('## Summary **now**'), '*Summary now*');
  assert.equal(toSlackMrkdwn('- one\n  - two\n- [x] done'), '• one\n    • two\n• ☑ done');
  assert.equal(toSlackMrkdwn('> quoted **x**'), '> quoted *x*');
  assert.equal(toSlackMrkdwn('---'), '──────────');
});

test('code fences are untouched and lose the language tag', () => {
  assert.equal(toSlackMrkdwn('```ts\nconst a = **b**;\n```'), '```\nconst a = **b**;\n```');
});

test('tables become aligned monospace, CJK counted double', () => {
  const md = '| 文件 | 作用 |\n|---|---|\n| `bridge.ts` | **总调度** |\n| a.ts | 路由 |';
  assert.equal(
    toSlackMrkdwn(md),
    ['```', '文件       作用', '─────────  ──────', 'bridge.ts  总调度', 'a.ts       路由', '```'].join('\n'),
  );
  assert.equal(width('文件'), 4);
});

test('split keeps code fences balanced', () => {
  const text = 'intro\n```\n' + Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n') + '\n```\nend';
  const parts = split(text, 120);
  assert.ok(parts.length > 1);
  for (const p of parts) assert.equal((p.match(/^```/gm) ?? []).length % 2, 0, p);
  assert.ok(parts.every((p) => p.length <= 120));
});

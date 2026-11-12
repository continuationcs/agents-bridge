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

test('wide tables become one record per row', () => {
  const md = [
    '| 维度 | router.ts | policy.ts |',
    '|---|---|---|',
    '| 匹配方式 | 按顺序取第一个匹配（first-match），没有匹配就拒绝 | **所有**匹配的策略都生效，冲突时取最严格的值 |',
    '| 公开方法 | `matchInbound`<br>`allowsOutbound` | `maxHops` |',
  ].join('\n');
  assert.equal(
    toSlackMrkdwn(md),
    [
      '*匹配方式*',
      '• router.ts: 按顺序取第一个匹配（first-match），没有匹配就拒绝',
      '• policy.ts: *所有*匹配的策略都生效，冲突时取最严格的值',
      '',
      '*公开方法*',
      '• router.ts: ',
      '    ◦ `matchInbound`',
      '    ◦ `allowsOutbound`',
      '• policy.ts: `maxHops`',
    ].join('\n'),
  );
});

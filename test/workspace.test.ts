import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureWorktree, listWorktrees, mergeBlocker, removeWorktree, squashMerge, worktreeStatus, type WorktreeOpts,
} from '../src/adapters/agent/worktree.ts';
import { parseConfig } from '../src/config/load.ts';
import { Bridge } from '../src/core/bridge.ts';
import { Store } from '../src/core/store.ts';
import type { AgentAdapter, Workspace } from '../src/adapters/agent/types.ts';
import { FakeIm } from './helpers.ts';

function repo() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ab-ws-')));
  const g = (cwd: string, ...a: string[]) =>
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
  g(root, 'init', '-q', '-b', 'main');
  writeFileSync(join(root, 'a.txt'), 'one\n');
  g(root, 'add', '.');
  g(root, 'commit', '-qm', 'init');
  const opts = (key: string): WorktreeOpts => ({ baseCwd: root, sessionKey: key, dir: join(root, '..', `wts-${Date.now()}-${key.length}`) });
  return { root, g, opts };
}

test('status, merge blockers, squash merge, cleanup', () => {
  const { root, g, opts } = repo();
  const o = opts('slack:C1:T1');
  const wt = ensureWorktree(o);
  assert.equal(worktreeStatus(o)?.base, 'main');
  assert.match(mergeBlocker(o, worktreeStatus(o)!)!, /nothing to merge/);

  writeFileSync(join(wt.path, 'b.txt'), 'new\n');
  assert.match(mergeBlocker(o, worktreeStatus(o)!)!, /uncommitted/);
  g(wt.path, 'add', '.');
  g(wt.path, 'commit', '-qm', 'add b');
  writeFileSync(join(wt.path, 'a.txt'), 'two\n');
  g(wt.path, 'commit', '-qam', 'change a');

  const st = worktreeStatus(o)!;
  assert.deepEqual(st.commits.map((c) => c.replace(/^\S+ /, '')), ['change a', 'add b']);
  assert.match(st.diffstat, /2 files changed/);

  g(root, 'switch', '-qc', 'other');
  assert.match(mergeBlocker(o, st)!, /on other, not main/);
  g(root, 'switch', '-q', 'main');
  writeFileSync(join(root, 'a.txt'), 'dirty\n');
  assert.match(mergeBlocker(o, st)!, /main checkout .* uncommitted/);
  g(root, 'checkout', '-q', 'a.txt');

  const { message } = squashMerge(o);
  assert.match(message, /^add b\n\nSquashed from bridge\//);
  assert.equal(g(root, 'log', '--format=%s', '-1'), 'add b');
  assert.equal(g(root, 'rev-list', '--count', 'HEAD'), '2', 'one squashed commit on top of init');
  assert.ok(existsSync(join(root, 'b.txt')));
  assert.ok(!existsSync(wt.path), 'worktree removed');
  assert.equal(listWorktrees(root).length, 0);
});

test('a conflicting merge changes nothing', () => {
  const { root, g, opts } = repo();
  const o = opts('slack:C1:T2');
  const wt = ensureWorktree(o);
  writeFileSync(join(wt.path, 'a.txt'), 'theirs\n');
  g(wt.path, 'commit', '-qam', 'theirs');
  writeFileSync(join(root, 'a.txt'), 'ours\n');
  g(root, 'commit', '-qam', 'ours');
  assert.throws(() => squashMerge(o), /merge conflicts with main in: a.txt/);
  assert.equal(g(root, 'status', '--porcelain'), '');
  assert.equal(worktreeStatus(o)?.commits.length, 1, 'branch kept');
  removeWorktree(o);
  assert.equal(g(root, 'branch', '--list', 'bridge/*'), '');
});

test('thread commands: status, merge needs yes, discard confirms only when work would be lost', async () => {
  const calls: string[] = [];
  let hasWork = true;
  const ws: Workspace = {
    status: () => '🌿 bridge/x: 2 commits',
    previewMerge: () => ({ ok: true, summary: 'Squash 2 commits' }),
    merge: () => (calls.push('merge'), '✅ merged'),
    previewDiscard: () => (hasWork ? '2 unmerged commits' : ''),
    discard: () => (calls.push('discard'), '🗑 discarded'),
  };
  const runs: string[] = [];
  const cc: AgentAdapter = { name: 'cc', workspace: ws, async run(t) { runs.push(t.text); return { text: 'ok' }; } };
  const cfg = parseConfig(`
server: { port: 0 }
people: { alice: { slack: U1 } }
im: { slack: { app_token: env:A, bot_token: env:B } }
agents: { cc: { type: stdio, command: "true" } }
routes: [ { from: "slack:*", when: { sender: [alice] }, to: cc } ]
`);
  const im = new FakeIm();
  const bridge = new Bridge({ cfg, store: new Store(':memory:'), ims: [im], agents: new Map([['cc', cc]]), log: () => {} });
  await bridge.start();
  const answers: string[] = [];
  im.onSend((m) => {
    if (m.text.includes('Reply `yes`')) setTimeout(() => im.receive({ userId: 'U1', text: answers.shift()!, mentioned: false }), 5);
  });
  try {
    im.receive({ userId: 'U1', text: 'status' });
    await bridge.idle();
    answers.push('no');
    im.receive({ userId: 'U1', text: 'merge' });
    await bridge.idle();
    answers.push('yes');
    im.receive({ userId: 'U1', text: '合并' });
    await bridge.idle();
    hasWork = false;
    im.receive({ userId: 'U1', text: 'discard' });
    await bridge.idle();
    im.receive({ userId: 'U1', text: 'merge the two branches please' });
    await bridge.idle();

    const t = im.transcript().join('\n');
    assert.match(t, /🌿 bridge\/x: 2 commits/);
    assert.match(t, /Cancelled by alice\./);
    assert.match(t, /✅ merged/);
    assert.match(t, /🗑 discarded/);
    assert.deepEqual(calls, ['merge', 'discard']);
    assert.deepEqual(runs, ['merge the two branches please'], 'only non-command text reaches the agent');
  } finally {
    await bridge.stop();
  }
});

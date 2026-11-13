import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureWorktree, listWorktrees, mergeBlocker, prBlocker, pruneIdle, pushPullRequest, removeWorktree, squashMerge, worktreeStatus, type WorktreeOpts,
} from '../adapters/agent/worktree.ts';
import { parseConfig } from '../config/load.ts';
import { Bridge } from '../core/bridge.ts';
import { Store } from '../core/store.ts';
import type { AgentAdapter, Workspace } from '../adapters/agent/types.ts';
import { FakeIm } from './helpers.ts';

let seq = 0;
function repo(branch = 'main') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ab-ws-')));
  const g = (cwd: string, ...a: string[]) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim();
  g(root, 'init', '-q', '-b', branch);
  // Identity in the repo config (shared by its worktrees), so nothing depends on the user's global config.
  g(root, 'config', 'user.email', 't@t');
  g(root, 'config', 'user.name', 't');
  writeFileSync(join(root, 'a.txt'), 'one\n');
  g(root, 'add', '.');
  g(root, 'commit', '-qm', 'init');
  const dir = join(root, '..', `wts-${process.pid}-${seq++}`);
  const opts = (key: string, extra: Partial<WorktreeOpts> = {}): WorktreeOpts => ({ baseCwd: root, sessionKey: key, dir, ...extra });
  return { root, g, opts, dir };
}

test('status, merge blockers, squash merge, cleanup', async () => {
  const { root, g, opts } = repo();
  const o = opts('slack:C1:T1');
  const wt = await ensureWorktree(o);
  assert.equal((await worktreeStatus(o))?.base, 'main');
  assert.match((await mergeBlocker(o, (await worktreeStatus(o))!))!, /nothing to merge/);

  writeFileSync(join(wt.path, 'b.txt'), 'new\n');
  assert.match((await mergeBlocker(o, (await worktreeStatus(o))!))!, /uncommitted/);
  g(wt.path, 'add', '.');
  g(wt.path, 'commit', '-qm', 'add b');
  writeFileSync(join(wt.path, 'a.txt'), 'two\n');
  g(wt.path, 'commit', '-qam', 'change a');

  const st = (await worktreeStatus(o))!;
  assert.deepEqual(st.commits?.map((c) => c.replace(/^\S+ /, '')), ['change a', 'add b']);
  assert.match(st.diffstat, /2 files changed/);

  g(root, 'switch', '-qc', 'other');
  assert.match((await mergeBlocker(o, st))!, /on other, not main/);
  g(root, 'switch', '-q', 'main');
  writeFileSync(join(root, 'a.txt'), 'dirty\n');
  assert.match((await mergeBlocker(o, st))!, /main checkout .* uncommitted/);
  g(root, 'checkout', '-q', 'a.txt');

  const { message } = await squashMerge(o);
  assert.match(message, /^add b\n\nSquashed from bridge\//);
  assert.equal(g(root, 'log', '--format=%s', '-1'), 'add b');
  assert.equal(g(root, 'rev-list', '--count', 'HEAD'), '2', 'one squashed commit on top of init');
  assert.ok(existsSync(join(root, 'b.txt')));
  assert.equal(g(root, 'status', '--porcelain'), '', 'index and worktree match the new commit');
  assert.ok(!existsSync(wt.path), 'worktree removed');
  assert.equal((await listWorktrees(root)).length, 0);
});

test('a conflicting merge changes nothing', async () => {
  const { root, g, opts } = repo();
  const o = opts('slack:C1:T2');
  const wt = await ensureWorktree(o);
  writeFileSync(join(wt.path, 'a.txt'), 'theirs\n');
  g(wt.path, 'commit', '-qam', 'theirs');
  writeFileSync(join(root, 'a.txt'), 'ours\n');
  g(root, 'commit', '-qam', 'ours');
  await assert.rejects(squashMerge(o), /merge conflicts with main in: a.txt/);
  assert.equal(g(root, 'status', '--porcelain'), '');
  assert.equal((await worktreeStatus(o))?.commits?.length, 1, 'branch kept');
  await removeWorktree(o);
  assert.equal(g(root, 'branch', '--list', 'bridge/*'), '');
});

test('a squash merge whose commit fails (signing) leaves the main checkout untouched', async () => {
  const { root, g, opts } = repo();
  const o = opts('slack:C1:sign');
  const wt = await ensureWorktree(o);
  writeFileSync(join(wt.path, 'b.txt'), 'b\n');
  g(wt.path, 'add', '.');
  g(wt.path, 'commit', '-qm', 'add b');
  const head = g(root, 'rev-parse', 'HEAD');
  g(root, 'config', 'commit.gpgSign', 'true');
  g(root, 'config', 'gpg.program', 'false');

  await assert.rejects(squashMerge(o), /commit-tree/);
  assert.equal(g(root, 'rev-parse', 'HEAD'), head);
  assert.equal(g(root, 'status', '--porcelain'), '', 'nothing staged or written in the main checkout');
  assert.ok(!existsSync(join(root, 'b.txt')));
  assert.equal((await worktreeStatus(o))?.commits?.length, 1, 'branch kept');
});

test('linked paths are excluded, and a branch that commits one (or an ignored path) is not merged or proposed', async () => {
  const { root, g, opts } = repo();
  writeFileSync(join(root, '.gitignore'), 'node_modules/\n');
  g(root, 'add', '.gitignore');
  g(root, 'commit', '-qm', 'ignore');
  mkdirSync(join(root, 'node_modules', 'dep'), { recursive: true });
  writeFileSync(join(root, 'node_modules', 'dep', 'index.js'), 'x');
  writeFileSync(join(root, '.env'), 'SECRET=1');
  const o = opts('slack:C1:links', { links: ['node_modules', './.env'] });
  const wt = await ensureWorktree(o);

  assert.equal(g(wt.path, 'status', '--porcelain'), '', 'symlinks do not show up as untracked');
  assert.match(readFileSync(join(g(root, 'rev-parse', '--path-format=absolute', '--git-common-dir'), 'info', 'exclude'), 'utf8'), /^\/node_modules$/m);
  await ensureWorktree(o);
  const exclude = readFileSync(join(root, '.git', 'info', 'exclude'), 'utf8');
  assert.equal(exclude.match(/^\/node_modules$/gm)?.length, 1, 'added once');

  writeFileSync(join(wt.path, 'b.txt'), 'b\n');
  g(wt.path, 'add', '-A');
  g(wt.path, 'commit', '-qm', 'add b');
  assert.deepEqual(g(wt.path, 'show', '--name-only', '--format=', 'HEAD').split('\n'), ['b.txt'], '`git add -A` leaves the links alone');
  assert.equal(await mergeBlocker(o, (await worktreeStatus(o))!), undefined);

  g(wt.path, 'add', '-f', 'node_modules');
  g(wt.path, 'commit', '-qm', 'oops');
  const st = (await worktreeStatus(o))!;
  assert.match((await mergeBlocker(o, st))!, /changes node_modules, which your main checkout links or ignores/);
  g(root, 'remote', 'add', 'origin', root);
  assert.match((await prBlocker(o, st))!, /changes node_modules/);
  assert.ok(existsSync(join(root, 'node_modules', 'dep', 'index.js')), 'the real directory is untouched');

  // Without the link configured, the ignored path is still caught.
  assert.match((await mergeBlocker({ ...o, links: [] }, st))!, /changes node_modules/);
});

test('a deleted base branch is never read as "nothing unmerged"', async () => {
  const { root, g, opts, dir } = repo('master');
  const o = opts('slack:C1:base');
  const wt = await ensureWorktree(o);
  writeFileSync(join(wt.path, 'w.txt'), 'w\n');
  g(wt.path, 'add', '.');
  g(wt.path, 'commit', '-qm', 'work');
  g(root, 'switch', '-qc', 'dev');
  g(root, 'branch', '-D', 'master');

  // The start commit is recorded, so the work is still counted.
  const st = (await worktreeStatus(o))!;
  assert.equal(st.commits?.length, 1);
  assert.match(st.note!, /base branch master no longer exists; commits are counted from/);
  assert.match((await mergeBlocker(o, st))!, /can't merge into master/);
  assert.deepEqual((await pruneIdle({ baseCwd: root, dir }, () => true)).removed, []);

  // Without it (older branches, or a lost config), the work is unknown: kept, and discarding asks first.
  g(root, 'config', '--unset', `branch.${wt.branch}.bridgeBaseSha`);
  const unknown = (await worktreeStatus(o))!;
  assert.equal(unknown.commits, undefined);
  assert.match((await mergeBlocker(o, unknown))!, /can't tell what/);
  assert.deepEqual(await pruneIdle({ baseCwd: root, dir }, () => true), { removed: [], errors: [] });
  assert.ok(existsSync(wt.path), 'kept');
});

test('a symlinked cwd maps into the worktree', async () => {
  const { root, g, opts } = repo();
  mkdirSync(join(root, 'pkg'));
  writeFileSync(join(root, 'pkg', 'p.txt'), 'p');
  g(root, 'add', '.');
  g(root, 'commit', '-qm', 'pkg');
  const link = join(mkdtempSync(join(tmpdir(), 'ab-link-')), 'repo');
  symlinkSync(root, link);
  const wt = await ensureWorktree(opts('slack:C1:sym', { baseCwd: join(link, 'pkg') }));
  assert.equal(wt.cwd, join(wt.path, 'pkg'));
  assert.ok(existsSync(join(wt.cwd, 'p.txt')));
});

test('a worktree deleted by hand, or a leftover directory, is recreated with the branch kept', async () => {
  const { g, opts } = repo();
  const o = opts('slack:C1:gone');
  const wt = await ensureWorktree(o);
  writeFileSync(join(wt.path, 'w.txt'), 'w\n');
  g(wt.path, 'add', '.');
  g(wt.path, 'commit', '-qm', 'work');

  rmSync(wt.path, { recursive: true, force: true });
  assert.equal((await worktreeStatus(o))?.commits?.length, 1, 'the branch still has its commits');
  const again = await ensureWorktree(o);
  assert.ok(again.created);
  assert.ok(existsSync(join(again.path, 'w.txt')), 'checked out from the existing branch');

  // A directory without .git (half-created, or broken by hand) is moved aside, never deleted.
  rmSync(join(wt.path, '.git'));
  writeFileSync(join(wt.path, 'notes.txt'), 'keep me');
  const third = await ensureWorktree(o);
  assert.match(third.notice!, /moved to (\S+)/);
  const aside = /moved to (\S+) and/.exec(third.notice!)![1]!;
  assert.equal(readFileSync(join(aside, 'notes.txt'), 'utf8'), 'keep me');
  assert.ok(existsSync(join(third.path, 'w.txt')));
});

test('uncommitted paths with spaces and non-ASCII characters are reported verbatim', async () => {
  const { opts, g } = repo();
  const o = opts('slack:C1:names');
  const wt = await ensureWorktree(o);
  writeFileSync(join(wt.path, 'my file.txt'), 'x');
  writeFileSync(join(wt.path, '文件.txt'), 'x');
  g(wt.path, 'mv', 'a.txt', 'b c.txt');
  assert.deepEqual((await worktreeStatus(o))!.dirty.sort(), ['?? my file.txt', '?? 文件.txt', 'R  b c.txt'].sort());
});

test('thread commands: status, merge needs yes, discard confirms only when work would be lost', async () => {
  const calls: string[] = [];
  let hasWork = true;
  const ws: Workspace = {
    status: async () => '🌿 bridge/x: 2 commits',
    previewMerge: async () => ({ ok: true, summary: 'Squash 2 commits' }),
    merge: async () => (calls.push('merge'), '✅ merged'),
    previewDiscard: async () => (hasWork ? '2 unmerged commits' : ''),
    discard: async () => (calls.push('discard'), '🗑 discarded'),
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

test('pr: pushes the branch to origin and opens a PR (fake gh), reuses an open one', async () => {
  const { chmodSync, writeFileSync: write } = await import('node:fs');
  const { root, g, opts } = repo();
  const remote = realpathSync(mkdtempSync(join(tmpdir(), 'ab-origin-')));
  g(remote, 'init', '-q', '--bare');
  g(root, 'remote', 'add', 'origin', remote);
  g(root, 'push', '-q', 'origin', 'main');

  // fake gh: `pr view` finds nothing the first time, then the PR; `pr create` records its args.
  const bin = realpathSync(mkdtempSync(join(tmpdir(), 'ab-bin-')));
  const log = join(bin, 'calls');
  write(join(bin, 'gh'), `#!/bin/sh
echo "$@" >> "${log}"
if [ "$1 $2" = "pr view" ]; then [ -f "${bin}/created" ] && echo https://github.com/o/r/pull/7; exit 0; fi
if [ "$1 $2" = "pr create" ]; then touch "${bin}/created"; echo https://github.com/o/r/pull/7; exit 0; fi
exit 1
`);
  chmodSync(join(bin, 'gh'), 0o755);
  const oldPath = process.env.PATH;
  process.env.PATH = `${bin}:${oldPath}`;
  try {
    const o = opts('slack:C9:T9');
    const wt = await ensureWorktree(o);
    await assert.rejects(pushPullRequest(o, 't'), /nothing to propose/);
    writeFileSync(join(wt.path, 'c.txt'), 'c\n');
    g(wt.path, 'add', '.');
    g(wt.path, 'commit', '-qm', 'add c');

    assert.deepEqual(await pushPullRequest(o, 't'), { url: 'https://github.com/o/r/pull/7', created: true });
    assert.equal(g(remote, 'log', '--format=%s', '-1', wt.branch), 'add c', 'branch pushed');
    const calls = readFileSync(log, 'utf8');
    assert.match(calls, /pr create --head bridge\/slack-c9-t9-\w+ --base main --title add c --body - add c/);

    assert.deepEqual(await pushPullRequest(o, 't'), { url: 'https://github.com/o/r/pull/7', created: false }, 'second call reuses the PR');
    assert.ok(existsSync(wt.path), 'worktree kept for follow-up commits');
  } finally {
    process.env.PATH = oldPath;
  }
});

test('pruneIdle removes idle worktrees with nothing unmerged, keeps the rest, and survives a broken one', async () => {
  const { root, g, opts, dir } = repo();
  const mk = (key: string) => ensureWorktree(opts(key));
  const empty = await mk('slack:C1:empty');
  const busy = await mk('slack:C1:busy');
  const active = await mk('slack:C1:active');
  const broken = await mk('slack:C1:broken');
  const after = await mk('slack:C1:zafter');
  writeFileSync(join(busy.path, 'x.txt'), 'x');
  g(busy.path, 'add', '.');
  g(busy.path, 'commit', '-qm', 'work');
  // A worktree git can't operate on: its removal fails, the others still go.
  writeFileSync(join(broken.path, '.git'), 'gitdir: /nonexistent\n');

  const activeSlug = active.branch.replace('bridge/', '');
  const { removed, errors } = await pruneIdle({ baseCwd: root, dir }, (slug) => slug !== activeSlug);
  assert.deepEqual(removed.sort(), [empty.branch, after.branch].sort());
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, new RegExp(broken.branch));
  assert.ok(!existsSync(empty.path));
  assert.ok(existsSync(busy.path), 'unmerged work is kept');
  assert.ok(existsSync(active.path), 'active conversation is kept');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../config/load.ts';
import { Bridge } from '../core/bridge.ts';
import { newEnvelope } from '../core/envelope.ts';
import { Store } from '../core/store.ts';
import type { AgentAdapter, AgentTurn } from '../adapters/agent/types.ts';
import { ensureWorktree } from '../adapters/agent/worktree.ts';
import { FakeIm } from './helpers.ts';

const cfg = parseConfig(`
server: { port: 0 }
people: { alice: { trust: owner, slack: U1 } }
im: { slack: { app_token: env:A, bot_token: env:B } }
agents: { cc: { type: stdio, command: "true" } }
routes: [ { from: "slack:*", when: { sender: [alice] }, to: cc } ]
`);

/** Leave a turn in the store as if the bridge died mid-turn after the agent reported its session id. */
function crashedTurn(store: Store, interrupted = 0) {
  const key = 'slack:C1:T1';
  store.upsertSession({ key, agent: 'cc', agent_session_id: 'claude-123', platform: 'slack', channel_id: 'C1', thread_id: 'T1', initiator: 'alice' });
  const envelope = newEnvelope({
    sender: { kind: 'person', id: 'alice', platform: 'slack', platformUserId: 'U1' },
    sessionKey: key, content: [{ type: 'text', text: 'fix the bug' }], trust: 'owner', initiator: 'alice', hops: 0, tainted: false,
  });
  const job = { sessionKey: key, agent: 'cc', text: 'fix the bug', envelope, thread: { platform: 'slack', channelId: 'C1', threadId: 'T1', isDM: false }, interrupted };
  store.enqueue(envelope.id, key, job);
  store.markRunning(envelope.id, job);
}

async function restart(store: Store) {
  const turns: AgentTurn[] = [];
  const cc: AgentAdapter = { name: 'cc', async run(t) { turns.push(t); return { text: 'resumed ok' }; } };
  const im = new FakeIm();
  const bridge = new Bridge({ cfg, store, ims: [im], agents: new Map([['cc', cc]]), log: () => {} });
  await bridge.start();
  await bridge.idle();
  await bridge.stop();
  return { turns, im };
}

test('a turn cut off by a restart resumes the same agent session', async () => {
  const store = new Store(':memory:');
  crashedTurn(store);
  const { turns, im } = await restart(store);
  assert.equal(turns.length, 1);
  assert.equal(turns[0]!.agentSessionId, 'claude-123');
  assert.match(turns[0]!.text, /interrupted because the bridge restarted[\s\S]*fix the bug/);
  assert.match(im.transcript().join('\n'), /🔁 The bridge restarted[\s\S]*resumed ok/);
  assert.equal(store.takePending(60e3).length, 0);
});

test('a turn interrupted too often is given up', async () => {
  const store = new Store(':memory:');
  crashedTurn(store, 2);
  const { turns, im } = await restart(store);
  assert.equal(turns.length, 0);
  assert.match(im.transcript().join('\n'), /interrupted 3 times/);
});

test('each session gets its own worktree and branch, reused across turns', async () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'ab-repo-')));
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  mkdirSync(join(repo, 'pkg'));
  writeFileSync(join(repo, 'pkg', 'a.txt'), 'x');
  mkdirSync(join(repo, 'node_modules'));
  git('add', 'pkg');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init');
  const dir = join(repo, '..', `wt-${Date.now()}`);

  const a = await ensureWorktree({ baseCwd: join(repo, 'pkg'), sessionKey: 'slack:C1:T1', dir, links: ['node_modules'] });
  const b = await ensureWorktree({ baseCwd: join(repo, 'pkg'), sessionKey: 'slack:C1:T2', dir });
  const again = await ensureWorktree({ baseCwd: join(repo, 'pkg'), sessionKey: 'slack:C1:T1', dir });

  assert.ok(a.created && b.created && !again.created);
  assert.notEqual(a.path, b.path);
  assert.notEqual(a.branch, b.branch);
  assert.equal(again.path, a.path);
  assert.ok(existsSync(join(a.cwd, 'a.txt')), 'cwd maps to the same subdirectory');
  assert.ok(existsSync(join(a.path, 'node_modules')), 'links are created');
  assert.match(a.branch, /^bridge\/slack-c1-t1-[0-9a-f]{6}$/);
});

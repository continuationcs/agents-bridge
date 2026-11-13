import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { getEventListeners } from 'node:events';
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeCodeAgent } from '../adapters/agent/claude-code.ts';
import { StdioAgent } from '../adapters/agent/stdio.ts';
import type { AgentTurn } from '../adapters/agent/types.ts';
import { newEnvelope } from '../core/envelope.ts';

const tmp = (prefix: string) => realpathSync(mkdtempSync(join(tmpdir(), prefix)));

function turn(text: string, extra: Partial<AgentTurn> = {}): AgentTurn {
  const envelope = newEnvelope({
    sender: { kind: 'person', id: 'alice', platform: 'slack', platformUserId: 'U1' },
    sessionKey: 'slack:C1:T1', content: [{ type: 'text', text }], trust: 'owner', initiator: 'alice', hops: 0, tainted: false,
  });
  return { envelope, text, mcp: { url: 'http://127.0.0.1:1/mcp', token: 't' }, ...extra };
}

/** Poll until `check` holds (deterministic: waits for the condition, fails after `ms`). */
async function until(check: () => boolean, what: string, ms = 10_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function script(dir: string, name: string, body: string) {
  const p = join(dir, name);
  writeFileSync(p, body);
  chmodSync(p, 0o755);
  return p;
}

const claudeCfg = (command: string, extra: object = {}) => ({
  type: 'claude-code' as const, command, permission_mode: 'default' as const, allowed_tools: [], worktree: false,
  worktree_dir: '~/.bridge/worktrees', worktree_links: [], ...extra,
});

test('claude-code: a session is resumed in the same directory, also after its worktree was recreated', async () => {
  const bin = tmp('ab-cc-');
  const fake = script(bin, 'claude', `#!/bin/sh
cat > /dev/null
resume=none
while [ $# -gt 0 ]; do [ "$1" = "--resume" ] && resume="$2"; shift; done
printf '{"type":"result","result":"resume=%s","session_id":"S1"}\\n' "$resume"
`);
  const repo = tmp('ab-cc-repo-');
  const git = (...a: string[]) => execFileSync('git', a, { cwd: repo, stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init');
  const agent = new ClaudeCodeAgent('cc', claudeCfg(fake, { cwd: repo, worktree: true, worktree_dir: join(repo, '..', `${repo.split('/').pop()}-wts`) }));

  const first = await agent.run(turn('hi'));
  assert.equal(first.text, 'resume=none');
  assert.match(first.agentSessionId!, /^S1@[0-9a-f]{12}$/);
  assert.equal((await agent.run(turn('again', { agentSessionId: first.agentSessionId }))).text, 'resume=S1');

  // Idle prune / discard removes the worktree; it comes back at the same path, so the session still applies.
  assert.match(await agent.workspace!.discard('slack:C1:T1'), /Discarded/);
  const notices: string[] = [];
  const after = await agent.run(turn('later', { agentSessionId: first.agentSessionId, onNotice: (n) => notices.push(n) }));
  assert.equal(after.text, 'resume=S1');
  assert.match(notices.join('\n'), /works on its own branch/);

  // A session from another directory is not resumed; an untagged (older) one only if the worktree is not new.
  assert.equal((await agent.run(turn('x', { agentSessionId: 'S1@000000000000' }))).text, 'resume=none');
  assert.equal((await agent.run(turn('x', { agentSessionId: 'S0' }))).text, 'resume=S0');
  await agent.workspace!.discard('slack:C1:T1');
  assert.equal((await agent.run(turn('x', { agentSessionId: 'S0' }))).text, 'resume=none');
});

test('claude-code: a process that exits without reading its prompt fails the turn instead of crashing (EPIPE)', async () => {
  const fake = script(tmp('ab-cc-'), 'claude', '#!/bin/sh\necho "bad flag" >&2\nexit 3\n');
  const agent = new ClaudeCodeAgent('cc', claudeCfg(fake, { cwd: tmpdir() }));
  await assert.rejects(agent.run(turn('x'.repeat(4 * 1024 * 1024))), /claude exited/);
});

test('claude-code: stop and abort end the whole process group and wait for it', async () => {
  const bin = tmp('ab-cc-');
  const pidFile = join(bin, 'pid');
  const fake = script(bin, 'claude', `#!/bin/sh
sleep 1000 &
echo $! > "${pidFile}.tmp" && mv "${pidFile}.tmp" "${pidFile}"
cat > /dev/null
wait
`);
  const agent = new ClaudeCodeAgent('cc', claudeCfg(fake, { cwd: tmpdir() }));

  const running = agent.run(turn('work'));
  const outcome = running.then(() => 'resolved', (e: Error) => e.message);
  await until(() => existsSync(pidFile), 'the fake claude to start its tool');
  const tool = Number(readFileSync(pidFile, 'utf8'));
  await agent.stop();
  assert.match(await outcome, /claude exited/);
  await until(() => !alive(tool), 'the tool subprocess to be killed');

  const ac = new AbortController();
  const aborted = agent.run(turn('work', { signal: ac.signal })).then(() => 'resolved', (e: Error) => e.message);
  await until(() => existsSync(pidFile) && Number(readFileSync(pidFile, 'utf8')) !== tool, 'the second run to start');
  const tool2 = Number(readFileSync(pidFile, 'utf8'));
  ac.abort();
  assert.match(await aborted, /abort/i);
  await until(() => !alive(tool2), 'the aborted tool subprocess to be killed');
});

// ───────────────────────── stdio ─────────────────────────

function stdioAgent(timeout = '30m') {
  const dir = tmp('ab-stdio-');
  const log = join(dir, 'in.log');
  writeFileSync(log, '');
  const agentScript = join(dir, 'agent.mjs');
  writeFileSync(agentScript, `
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  appendFileSync(${JSON.stringify(log)}, line + '\\n');
  const msg = JSON.parse(line);
  if (msg.type !== 'turn') return;
  if (msg.text === 'echo') out({ type: 'reply', id: msg.id, text: 'echo' });
  // anything else: never answered
});
`);
  const agent = new StdioAgent('st', { type: 'stdio', command: process.execPath, args: [agentScript], env: {}, timeout });
  const received = () => readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { agent, received };
}

test('stdio: an aborted turn is cancelled in the agent and its abort listener removed', async () => {
  const { agent, received } = stdioAgent();
  try {
    const ac = new AbortController();
    assert.equal((await agent.run(turn('echo', { signal: ac.signal }))).text, 'echo');
    assert.equal(getEventListeners(ac.signal, 'abort').length, 0, 'listener removed once the turn settled');

    const ac2 = new AbortController();
    const hanging = agent.run(turn('hang', { signal: ac2.signal }));
    await until(() => received().some((m) => m.text === 'hang'), 'the turn to arrive');
    ac2.abort();
    await assert.rejects(hanging, /aborted/);
    const id = received().find((m) => m.text === 'hang').id;
    await until(() => received().some((m) => m.type === 'cancel' && m.id === id), 'the cancel message');
  } finally {
    await agent.stop();
  }
});

test('stdio: a turn without a reply times out and is cancelled', async () => {
  const { agent, received } = stdioAgent('50ms');
  try {
    await assert.rejects(agent.run(turn('hang')), /gave no reply within 50ms/);
    await until(() => received().some((m) => m.type === 'cancel'), 'the cancel message');
  } finally {
    await agent.stop();
  }
});

test('stdio: an agent that closes its stdin fails the turns instead of crashing the bridge (EPIPE)', async () => {
  // Reads one turn, closes its stdin for good, keeps running.
  const agentScript = join(tmp('ab-stdio-'), 'closer.mjs');
  writeFileSync(agentScript, `
import { closeSync, readSync } from 'node:fs';
const buf = Buffer.alloc(65536);
let s = '';
while (!s.includes('\\n')) {
  const n = readSync(0, buf);
  if (!n) break;
  s += buf.toString('utf8', 0, n);
}
closeSync(0);
const { id } = JSON.parse(s.split('\\n')[0]);
process.stdout.write(JSON.stringify({ type: 'progress', id, text: 'closed' }) + '\\n');
setInterval(() => {}, 1000);
`);
  const agent = new StdioAgent('st', { type: 'stdio', command: process.execPath, args: [agentScript], env: {}, timeout: '30m' });
  try {
    let closed!: () => void;
    const isClosed = new Promise<void>((r) => (closed = r));
    const first = agent.run(turn('close-stdin', { onProgress: () => closed() }));
    const firstOutcome = first.then(() => 'resolved', (e: Error) => e.message);
    await isClosed;
    const second = agent.run(turn('after')).then(() => 'resolved', (e: Error) => e.message);
    assert.match(await second, /stopped reading its input|exited/);
    assert.match(await firstOutcome, /stopped reading its input|exited/);
  } finally {
    await agent.stop();
  }
});

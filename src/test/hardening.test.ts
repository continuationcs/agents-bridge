import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, utimesSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { parseConfig } from '../config/load.ts';
import { Bridge, codeBlock } from '../core/bridge.ts';
import { newEnvelope } from '../core/envelope.ts';
import { Store } from '../core/store.ts';
import { redact, registerSecret } from '../core/redact.ts';
import type { AgentAdapter, AgentTurn, Workspace } from '../adapters/agent/types.ts';
import type { ImAdapter, OutboundMessage } from '../adapters/im/types.ts';
import { FakeIm } from './helpers.ts';

const yaml = (extra = '') => `
server: { port: 0 }
people: { alice: { trust: owner, slack: U1 }, bob: { trust: member, slack: U2 } }
im: { slack: { app_token: env:A, bot_token: env:B } }
agents:
  boss: { type: stdio, command: "true" }
  helper: { type: stdio, command: "true" }
tools:
  fake: { command: node, args: [src/test/fixtures/tool-server.mjs] }
routes:
  - { from: "slack:#boss", when: { sender: [alice, bob] }, to: boss }
  - { from: "slack:#open", when: { sender: anyone }, to: boss }
  - { from: boss, to: [helper, "fake.*"] }
policies:
  - { match: { tool: "fake.delete*" }, approve_by: [initiator], timeout: 5s }
${extra}`;

/** Wait for a condition (never a fixed delay); fails after 10s so a broken test can't hang. */
async function until(cond: () => boolean, what: string) {
  const end = Date.now() + 10e3;
  while (!cond()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

function scripted(name: string, script: (mcp: Client, turn: AgentTurn) => Promise<string>): AgentAdapter {
  return {
    name,
    async run(turn) {
      const client = new Client({ name, version: '0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(turn.mcp.url)));
      try {
        return { text: await script(client, turn), agentSessionId: `${name}-s` };
      } finally {
        await client.close();
      }
    },
  };
}

const text = (r: any) => r.content.map((c: any) => c.text).join('');

async function setup(opts: { agents?: AgentAdapter[]; im?: FakeIm; store?: Store; extra?: string; filesDir?: string } = {}) {
  const im = opts.im ?? new FakeIm();
  const store = opts.store ?? new Store(':memory:');
  const logs: string[] = [];
  const bridge = new Bridge({
    cfg: parseConfig(yaml(opts.extra)),
    store,
    ims: [im],
    agents: new Map((opts.agents ?? []).map((a) => [a.name, a])),
    filesDir: opts.filesDir,
    log: (l) => logs.push(l),
  });
  await bridge.start();
  return { im, store, bridge, logs };
}

/** An IM whose every send fails. */
class DownIm extends FakeIm {
  override async send(_m: OutboundMessage): Promise<string> {
    throw new Error('IM is down');
  }
}

test('a failing IM never crashes the bridge (no unhandled rejection) and the turn still completes', async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => unhandled.push(e);
  process.on('unhandledRejection', onUnhandled);
  const runs: string[] = [];
  const boss: AgentAdapter = { name: 'boss', async run(t) { runs.push(t.text); return { text: 'ok' }; } };
  const { im, store, bridge, logs } = await setup({ agents: [boss], im: new DownIm() });
  try {
    im.receive({ userId: 'U1', text: 'hello', channelName: 'boss' });
    await bridge.idle();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(unhandled, []);
    assert.deepEqual(runs, ['hello'], 'the turn runs even though the placeholder could not be posted');
    assert.equal(store.takePending(60e3).length, 0, 'the turn is finished, not left to be re-run');
    assert.ok(logs.some((l) => /not delivered: IM is down/.test(l)), logs.join('\n'));
  } finally {
    process.off('unhandledRejection', onUnhandled);
    await bridge.stop();
  }
});

test('replay counts the interruption before anything runs, and nothing runs before the IMs are connected', async () => {
  const store = new Store(':memory:');
  const key = 'slack:C1:T1';
  const envelope = newEnvelope({
    sender: { kind: 'person', id: 'alice', platform: 'slack', platformUserId: 'U1' },
    sessionKey: key, content: [{ type: 'text', text: 'fix it' }], trust: 'owner', initiator: 'alice', hops: 0, tainted: false,
  });
  const job = { sessionKey: key, agent: 'boss', text: 'fix it', envelope, thread: { platform: 'slack', channelId: 'C1', threadId: 'T1', isDM: false } };
  store.enqueue(envelope.id, key, job);
  store.markRunning(envelope.id, job);

  let connect = () => {};
  const connected = new Promise<void>((r) => (connect = r));
  class SlowIm extends DownIm {
    override async start(...a: Parameters<FakeIm['start']>) {
      await connected;
      return super.start(...a);
    }
  }
  const runs: string[] = [];
  const boss: AgentAdapter = { name: 'boss', async run(t) { runs.push(t.text); return { text: 'ok' }; } };
  const bridge = new Bridge({ cfg: parseConfig(yaml()), store, ims: [new SlowIm()], agents: new Map([['boss', boss]]), log: () => {} });
  const started = bridge.start();
  await until(() => JSON.parse(store.db.prepare('SELECT payload FROM queue').get()!.payload as string).interrupted === 1, 'the interruption to be saved');
  assert.deepEqual(runs, [], 'nothing runs before the IM is connected');
  connect();
  await started;
  await bridge.idle();
  assert.equal(runs.length, 1, 'resumed even though the "resuming" notice could not be sent');
  await bridge.stop();
});

test('shutdown leaves a running turn queued, and the next start resumes it', async () => {
  const store = new Store(':memory:');
  let started = false;
  let fail: (e: Error) => void = () => {};
  // Like claude-code: stop() kills the running process, which fails the turn.
  const slow: AgentAdapter = {
    name: 'boss',
    run: () => ((started = true), new Promise((_, reject) => (fail = reject))),
    stop: async () => fail(new Error('claude exited with code 143')),
  };
  const first = await setup({ agents: [slow], store });
  first.im.receive({ userId: 'U1', text: 'long job', channelName: 'boss' });
  await until(() => started, 'the turn to start');
  await first.bridge.stop();
  assert.match(first.im.transcript().join('\n'), /interrupted by a bridge shutdown — it resumes/);
  assert.doesNotMatch(first.im.transcript().join('\n'), /failed/);
  assert.deepEqual(store.takePending(60e3).map((r) => r.status), ['running']);

  const seen: AgentTurn[] = [];
  const boss: AgentAdapter = { name: 'boss', async run(t) { seen.push(t); return { text: 'finished' }; } };
  const second = await setup({ agents: [boss], store });
  await second.bridge.idle();
  assert.equal(seen.length, 1);
  assert.match(second.im.transcript().join('\n'), /🔁 The bridge restarted[\s\S]*finished/);
  await second.bridge.stop();
});

test('reload keeps unchanged agents and lets a changed agent finish its running turn before stopping it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ab-hold-'));
  const flag = join(dir, 'go');
  const cfgText = (description: string) => `
server: { port: 0 }
people: { alice: { trust: owner, slack: U1 } }
im: { slack: { app_token: env:A, bot_token: env:B } }
agents: { hold: { type: stdio, command: node, args: [src/test/fixtures/hold-agent.mjs], description: "${description}" } }
routes: [ { from: "slack:*", when: { sender: [alice] }, to: hold } ]
`;
  const im = new FakeIm();
  const store = new Store(':memory:');
  const bridge = new Bridge({ cfg: parseConfig(cfgText('v1')), store, ims: [im], log: () => {} });
  await bridge.start();
  const pidIn = (threadId: string) => {
    const s = store.readTrace({ sessionKey: `slack:C1:${threadId}` }).find((t) => t.kind === 'reply');
    return s ? Number(/pid (\d+)/.exec(s.detail)?.[1]) : undefined;
  };
  try {
    im.receive({ userId: 'U1', text: `hold ${flag}`, threadId: 'T1' });
    await until(() => store.readTrace({ sessionKey: 'slack:C1:T1' }).some((t) => t.kind === 'progress'), 'the held turn to start');
    bridge.reload(parseConfig(cfgText('v2'))); // the agent's config changed
    writeFileSync(flag, '');
    await bridge.idle();
    const old = pidIn('T1');
    assert.ok(old, im.transcript().join('\n'));
    assert.equal(store.getSession('slack:C1:T1')?.spent_usd, 0.25, 'the turn finished and its cost counted');
    await until(() => { try { process.kill(old, 0); return false; } catch { return true; } }, 'the replaced process to be stopped');

    im.receive({ userId: 'U1', text: 'hi', threadId: 'T2' });
    await bridge.idle();
    const fresh = pidIn('T2');
    assert.ok(fresh && fresh !== old, 'the next turn runs on the new config');
    bridge.reload(parseConfig(cfgText('v2'))); // nothing changed
    im.receive({ userId: 'U1', text: 'again', threadId: 'T3' });
    await bridge.idle();
    assert.equal(pidIn('T3'), fresh, 'an unchanged agent keeps its process');
  } finally {
    await bridge.stop();
  }
});

test('an approval that outlives its turn is cancelled and the tool never runs', async () => {
  let turn: AgentTurn | undefined;
  const im = new FakeIm().withButtons();
  const boss = scripted('boss', async (mcp, t) => {
    turn = t;
    mcp.callTool({ name: 'fake__delete_thing', arguments: { id: '1' } }).catch(() => {});
    await until(() => im.choiceMessages.size === 1, 'the approval prompt');
    return 'gave up waiting';
  });
  const { store, bridge } = await setup({ agents: [boss], im });
  try {
    im.receive({ userId: 'U1', text: 'delete', channelName: 'boss' });
    await bridge.idle();
    assert.ok(turn?.signal?.aborted, 'the agent got a signal, aborted when the turn ended');
    const [id, msg] = [...im.choiceMessages.entries()][0]!;
    assert.equal(msg.outcome, '✖ Cancelled: the turn has ended.');
    assert.deepEqual(bridge.webChoices(), []);
    im.click(id, 'Approve', 'U1');
    await bridge.idle();
    assert.equal(im.notices.at(-1)?.text, 'This choice has already been decided or has expired.');
    assert.ok(!store.readTrace().some((t) => t.kind === 'tool_result'), 'the tool did not run');
  } finally {
    await bridge.stop();
  }
});

test('housekeeping survives stray files in the files folder and still expires old attachments', async () => {
  const filesDir = mkdtempSync(join(tmpdir(), 'ab-files-'));
  writeFileSync(join(filesDir, '.DS_Store'), 'x');
  mkdirSync(join(filesDir, 'conv'));
  const old = join(filesDir, 'conv', 'old.png');
  writeFileSync(old, 'x');
  const t = Date.now() / 1000 - 8 * 86400;
  utimesSync(old, t, t);
  const { bridge } = await setup({ filesDir });
  try {
    await bridge.cleanUp();
    assert.ok(!existsSync(old));
    assert.ok(!existsSync(join(filesDir, 'conv')), 'the emptied conversation folder is removed');
    assert.ok(existsSync(join(filesDir, '.DS_Store')));
  } finally {
    await bridge.stop();
  }
});

test('ask_human: an unknown sender on a sender: anyone route can answer, and a huge timeout is clamped', async () => {
  const boss = scripted('boss', async (mcp) =>
    'answer: ' + text(await mcp.callTool({ name: 'ask_human', arguments: { question: 'which env?', timeout_minutes: 1e9 } })),
  );
  const { im, bridge } = await setup({ agents: [boss] });
  im.onSend((m) => {
    if (m.text.startsWith('❓')) queueMicrotask(() => im.receive({ userId: 'U9', text: 'staging', channelName: 'open', mentioned: false }));
  });
  try {
    im.receive({ userId: 'U9', text: 'deploy', channelName: 'open' });
    await bridge.idle();
    assert.match(im.transcript().join('\n'), /answer: staging/);
  } finally {
    await bridge.stop();
  }
});

test('an external initiator cannot approve their own tool call: the owner decides', async () => {
  const boss = scripted('boss', async (mcp) => text(await mcp.callTool({ name: 'fake__delete_thing', arguments: { id: '5' } })));
  const { im, bridge } = await setup({ agents: [boss] });
  im.onSend((m) => {
    if (!m.text.startsWith('🔐')) return;
    queueMicrotask(() => {
      im.receive({ userId: 'U9', text: 'approve', channelName: 'open', mentioned: false });
      im.receive({ userId: 'U1', text: 'approve', channelName: 'open', mentioned: false });
    });
  });
  try {
    im.receive({ userId: 'U9', text: 'delete 5', channelName: 'open' });
    await bridge.idle();
    const t = im.transcript().join('\n');
    assert.match(t, /alice can decide/);
    assert.match(t, /Only alice can answer that/);
    assert.match(t, /✅ Approved by alice/);
    assert.match(t, /deleted 5/);
  } finally {
    await bridge.stop();
  }
});

test('approval prompt: arguments in a code block they cannot break out of, cut to fit a button message', async () => {
  const im = new FakeIm().withButtons();
  const ids = ['a```b', 'x'.repeat(3000)];
  const boss = scripted('boss', async (mcp) => {
    for (const id of ids) await mcp.callTool({ name: 'fake__delete_thing', arguments: { id } });
    return 'done';
  });
  const { bridge } = await setup({ agents: [boss], im });
  im.onSend((m) => {
    // After sendChoice has recorded the message (its send fires this listener first).
    if (m.text.startsWith('🔐')) setImmediate(() => im.click([...im.choiceMessages.keys()].at(-1)!, 'Approve', 'U1'));
  });
  try {
    im.receive({ userId: 'U1', text: 'go', channelName: 'boss' });
    await bridge.idle();
    const [escaped = '', long = ''] = [...im.choiceMessages.values()].map((c) => c.text);
    assert.equal(escaped.match(/```/g)?.length, 2, escaped);
    assert.match(escaped, /"id": "a\\u0060\\u0060\\u0060b"/);
    assert.ok(long.length <= im.maxTextLength, `${long.length} characters`);
    assert.match(long, /… \+\d+ more characters \(all arguments: dashboard → Activity\)\n```\nalice can decide/);
  } finally {
    await bridge.stop();
  }
  assert.equal(codeBlock('{"a":1}'), '```\n{"a":1}\n```');
});

test('a slow progress edit never overwrites the final reply', async () => {
  class SlowEditIm extends FakeIm {
    override async edit(_c: string, messageId: string, text: string) {
      if (text.startsWith('⏳')) await new Promise((r) => setTimeout(r, 30));
      this.edits.push({ messageId, text });
    }
  }
  const boss: AgentAdapter = { name: 'boss', async run(t) { t.onProgress?.('Read a.ts'); return { text: 'final answer' }; } };
  const { im, bridge } = await setup({ agents: [boss], im: new SlowEditIm() });
  try {
    im.receive({ userId: 'U1', text: 'go', channelName: 'boss' });
    await bridge.idle();
    assert.equal(im.edits.at(-1)?.text, 'final answer', im.edits.map((e) => e.text).join(' | '));
  } finally {
    await bridge.stop();
  }
});

test('a message named like an Object.prototype member is a prompt, not a command', async () => {
  const calls: string[] = [];
  const ws: Workspace = {
    status: async () => undefined,
    previewMerge: async () => ({ ok: false, reason: 'no' }),
    merge: async () => (calls.push('merge'), ''),
    previewDiscard: async () => (calls.push('previewDiscard'), ''),
    discard: async () => (calls.push('discard'), ''),
  };
  const boss: AgentAdapter = { name: 'boss', workspace: ws, async run(t) { return { text: `ran: ${t.text}` }; } };
  const { im, bridge } = await setup({ agents: [boss] });
  try {
    im.receive({ userId: 'U1', text: 'constructor', channelName: 'boss' });
    await bridge.idle();
    assert.deepEqual(calls, []);
    assert.match(im.transcript().join('\n'), /ran: constructor/);
  } finally {
    await bridge.stop();
  }
});

test('a message with a slow attachment keeps its place before later messages', async () => {
  const filesDir = mkdtempSync(join(tmpdir(), 'ab-files-'));
  const seen: string[] = [];
  const boss: AgentAdapter = { name: 'boss', async run(t) { seen.push(t.text); return { text: 'ok' }; } };
  const { im, bridge } = await setup({ agents: [boss], filesDir });
  let release = () => {};
  const downloaded = new Promise<void>((r) => (release = r));
  try {
    im.receive({
      userId: 'U1', text: 'first', channelName: 'boss',
      files: [{ name: 'big.bin', download: async () => (await downloaded, Buffer.from('x')) }],
    });
    im.receive({ userId: 'U1', text: 'second', channelName: 'boss' });
    release();
    await bridge.idle();
    assert.deepEqual(seen, ['first', 'second']);
  } finally {
    await bridge.stop();
  }
});

test('a click that arrives before the prompt send returns still counts', async () => {
  const im = new FakeIm().withButtons() as FakeIm & Required<Pick<ImAdapter, 'sendChoice'>>;
  const send = im.sendChoice.bind(im);
  im.sendChoice = async (m, c) => {
    const id = await send(m, c);
    im.click(id, 'Approve', 'U1');
    return id;
  };
  const boss = scripted('boss', async (mcp) => text(await mcp.callTool({ name: 'fake__delete_thing', arguments: { id: '3' } })));
  const { bridge } = await setup({ agents: [boss], im });
  try {
    im.receive({ userId: 'U1', text: 'go', channelName: 'boss' });
    await bridge.idle();
    assert.equal([...im.choiceMessages.values()][0]?.outcome, '✅ Approved by alice.');
    assert.match(im.transcript().join('\n'), /deleted 3/);
  } finally {
    await bridge.stop();
  }
});

test('two concurrent delegations to the same agent: the second is refused, not mixed into the first', async () => {
  let runs = 0;
  let release = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const helper: AgentAdapter = {
    name: 'helper',
    async run(t) {
      if (++runs === 2) release(); // both running at once would be the bug
      await gate;
      return { text: `helper did ${t.text}` };
    },
  };
  const boss = scripted('boss', async (mcp) => {
    const call = (task: string) => mcp.callTool({ name: 'delegate', arguments: { agent: 'helper', task } });
    const results = await Promise.all([call('a'), call('b').then((r) => (release(), r))]);
    return results.map((r: any) => `${r.isError ? 'ERR ' : ''}${text(r)}`).join(' | ');
  });
  const { im, bridge } = await setup({ agents: [boss, helper] });
  try {
    im.receive({ userId: 'U1', text: 'go', channelName: 'boss' });
    await bridge.idle();
    assert.equal(runs, 1);
    assert.match(im.transcript().join('\n'), /helper did a \| ERR helper is still working on an earlier task/);
  } finally {
    await bridge.stop();
  }
});

test('dashboard: branch status is cached and refreshed when a turn ends', async () => {
  let statusCalls = 0;
  const ws: Workspace = {
    status: async () => (statusCalls++, '🌿 bridge/x'),
    previewMerge: async () => ({ ok: true, summary: '' }),
    merge: async () => '',
    previewDiscard: async () => '',
    discard: async () => '',
  };
  const boss: AgentAdapter = { name: 'boss', workspace: ws, async run() { return { text: 'ok' }; } };
  const { im, bridge } = await setup({ agents: [boss] });
  try {
    im.receive({ userId: 'U1', text: 'go', channelName: 'boss' });
    await bridge.idle();
    assert.equal((await bridge.webSessions())[0]?.branch, '🌿 bridge/x');
    await bridge.webSessions();
    assert.equal(statusCalls, 1, 'the second poll is served from the cache');
    im.receive({ userId: 'U1', text: 'more', channelName: 'boss', mentioned: false });
    await bridge.idle();
    await bridge.webSessions();
    assert.equal(statusCalls, 2, 'a finished turn refreshes it');
  } finally {
    await bridge.stop();
  }
});

test('store: deleting a conversation deletes its delegation sessions; retention prunes old rows', () => {
  const store = new Store(':memory:');
  const s = (key: string) => store.upsertSession({ key, agent: 'a', agent_session_id: 'x', platform: 'slack', channel_id: 'C', thread_id: 'T', initiator: 'alice' });
  for (const k of ['slack:C:T', 'slack:C:T>helper', 'slack:C:T>helper>boss', 'slack:C:T2', 'slack:C:T%']) s(k);
  store.deleteSession('slack:C:T');
  assert.deepEqual(store.listSessions().map((r) => r.key).sort(), ['slack:C:T%', 'slack:C:T2']);

  store.enqueue('q1', 'k', {});
  store.finish('q1', 'done');
  store.enqueue('q2', 'k', {});
  store.trace('k', 'x', 'y', {});
  const later = Date.now() + 1000;
  assert.deepEqual(store.sessionsActiveSince(later), []);
  assert.equal(store.sessionsActiveSince(0).length, 2);
  assert.deepEqual(store.prune({ queueBefore: later }), { queue: 1, trace: 0, sessions: 0 });
  assert.deepEqual(store.prune({ queueBefore: later, historyBefore: later }), { queue: 0, trace: 1, sessions: 2 });
  assert.deepEqual(store.takePending(60e3).map((r) => r.id), ['q2'], 'unfinished work is kept');
});

test('trace redaction: token formats and registered secret values', () => {
  const cases = [
    'github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz',
    'Authorization: token 0123456789abcdef0123456789abcdef',
    'Authorization: Basic dXNlcjpwYXNzd29yZDEyMzQ1Ng==',
    'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    'ya29.a0AfH6SMBx0123456789abcdefghijkl',
    'AKIAIOSFODNN7EXAMPLE',
    't-g1044ghJRUIJJ5ELPZ5MKPPTNDF4K2XZ3JLXR2OT',
    '{"app_secret":"s3cr3t-value-123"}',
  ];
  for (const c of cases) assert.match(redact(c), /\[redacted\]/, c);
  assert.equal(redact('{"tenant_access_token": "abcdefghij"}'), '{"tenant_access_token": "[redacted]"}');
  assert.equal(redact('Authorization: token 0123456789abcdef0123456789abcdef'), 'Authorization: token [redacted]');

  registerSecret('plain-looking-value-42');
  registerSecret('short'); // too short to redact safely: ignored
  assert.equal(redact('sent plain-looking-value-42 and short'), 'sent [redacted] and short');
  registerSecret('with"quote\\slash');
  assert.equal(redact(JSON.stringify({ v: 'with"quote\\slash' })), '{"v":"[redacted]"}');
});

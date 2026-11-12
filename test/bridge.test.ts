import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { parseConfig } from '../src/config/load.ts';
import { Bridge } from '../src/core/bridge.ts';
import { Store } from '../src/core/store.ts';
import type { AgentAdapter, AgentTurn } from '../src/adapters/agent/types.ts';
import { FakeIm } from './helpers.ts';

const yaml = (extraRoutes = '', extraPolicies = '') => `
server: { port: 0 }
people: { alice: { trust: owner, slack: U1 }, bob: { trust: member, slack: U2 } }
im: { slack: { app_token: env:A, bot_token: env:B } }
agents:
  echo: { type: stdio, command: node, args: [examples/echo-agent.mjs] }
  boss: { type: stdio, command: "true" }
  helper: { type: stdio, command: "true" }
tools:
  fake: { command: node, args: [test/fixtures/tool-server.mjs] }
routes:
  - { from: "slack:#dev", when: { sender: [alice] }, to: echo }
  - { from: "slack:#boss", when: { sender: [alice, bob] }, to: boss }
  - { from: boss, to: [helper, "fake.*"] }
${extraRoutes}
policies:
  - { match: { tool: "fake.delete*" }, approve_by: [initiator], timeout: 5s }
${extraPolicies}`;

/** An in-test agent that drives the bridge's MCP endpoint like a real agent would. */
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

async function setup(agents: AgentAdapter[] = [], extraRoutes = '', extraPolicies = '') {
  const im = new FakeIm();
  const store = new Store(':memory:');
  const bridge = new Bridge({
    cfg: parseConfig(yaml(extraRoutes, extraPolicies)),
    store,
    ims: [im],
    agents: new Map(agents.map((a) => [a.name, a])),
    log: () => {},
  });
  await bridge.start();
  return { im, store, bridge, done: () => bridge.stop() };
}

test('IM → stdio agent → reply in thread, session continues', async () => {
  const { im, store, bridge, done } = await setup();
  try {
    im.receive({ userId: 'U1', text: 'hello' });
    await bridge.idle();
    im.receive({ userId: 'U1', text: 'again', mentioned: false }); // thread reply, no mention
    await bridge.idle();
    const t = im.transcript().join('\n');
    assert.match(t, /echo #1 \(from alice, trust owner\): hello/);
    assert.match(t, /echo #2 .*: again/);
    assert.equal(store.getSession('slack:C1:T1')?.agent, 'echo');
    assert.ok(im.sent.every((s) => s.threadId === 'T1'));
  } finally {
    await done();
  }
});

test('unknown sender is ignored (deny by default)', async () => {
  const { im, store, bridge, done } = await setup();
  try {
    im.receive({ userId: 'U9', text: 'hello' });
    await bridge.idle();
    assert.equal(im.sent.length, 0);
    assert.equal(store.readTrace()[0]?.kind, 'ignored');
  } finally {
    await done();
  }
});

test('MCP: tool listing follows routes, delegate runs the peer with reduced trust', async () => {
  let helperTurn: AgentTurn | undefined;
  const helper: AgentAdapter = {
    name: 'helper',
    async run(turn) {
      helperTurn = turn;
      return { text: `helper did: ${turn.text}` };
    },
  };
  const boss = scripted('boss', async (mcp) => {
    const names = (await mcp.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(names, ['ask_human', 'delegate', 'fake__delete_thing', 'fake__echo', 'send_message']);
    await mcp.callTool({ name: 'send_message', arguments: { text: 'on it' } });
    const echoed = text(await mcp.callTool({ name: 'fake__echo', arguments: { text: 'x' } }));
    const r = text(await mcp.callTool({ name: 'delegate', arguments: { agent: 'helper', task: 'sum 1+1' } }));
    return `${echoed} | ${r}`;
  });
  const { im, bridge, done } = await setup([boss, helper]);
  try {
    im.receive({ userId: 'U1', text: 'go', channelName: 'boss' });
    await bridge.idle();
    const t = im.transcript().join('\n');
    assert.match(t, /on it/);
    assert.match(t, /↪️ boss → helper: sum 1\+1/);
    assert.match(t, /tool echo: x \| helper did: sum 1\+1/);
    assert.equal(helperTurn?.envelope.hops, 1);
    assert.equal(helperTurn?.envelope.trust, 'agent');
    assert.equal(helperTurn?.envelope.initiator, 'alice');
  } finally {
    await done();
  }
});

test('approval: only the initiator can approve; tool runs after approve', async () => {
  const boss = scripted('boss', async (mcp) =>
    text(await mcp.callTool({ name: 'fake__delete_thing', arguments: { id: '42' } })),
  );
  const { im, bridge, done } = await setup([boss]);
  im.onSend((m) => {
    if (m.text.startsWith('🔐')) {
      setTimeout(() => {
        im.receive({ userId: 'U1', text: 'approve', channelName: 'boss', mentioned: false }); // alice is not the initiator
        im.receive({ userId: 'U2', text: 'approve', channelName: 'boss', mentioned: false }); // bob is
      }, 10);
    }
  });
  try {
    im.receive({ userId: 'U2', text: 'delete 42', channelName: 'boss' });
    await bridge.idle();
    const t = im.transcript().join('\n');
    assert.match(t, /🔐 boss wants to run `fake\.delete_thing`/);
    assert.match(t, /expires in 5s/);
    assert.match(t, /Only bob can answer that/);
    assert.match(t, /✅ Approved by bob/);
    assert.match(t, /deleted 42/);
  } finally {
    await done();
  }
});

test('approval denied → tool does not run', async () => {
  const boss = scripted('boss', async (mcp) => {
    const r = await mcp.callTool({ name: 'fake__delete_thing', arguments: { id: '7' } });
    return `${r.isError ? 'ERR ' : ''}${text(r)}`;
  });
  const { im, bridge, done } = await setup([boss]);
  im.onSend((m) => {
    if (m.text.startsWith('🔐')) setTimeout(() => im.receive({ userId: 'U1', text: 'deny', channelName: 'boss', mentioned: false }), 10);
  });
  try {
    im.receive({ userId: 'U1', text: 'delete 7', channelName: 'boss' });
    await bridge.idle();
    assert.match(im.transcript().join('\n'), /ERR denied by alice/);
  } finally {
    await done();
  }
});

test('ask_human waits for the initiator in the same thread', async () => {
  const boss = scripted('boss', async (mcp) =>
    'answer: ' + text(await mcp.callTool({ name: 'ask_human', arguments: { question: 'which env?' } })),
  );
  const { im, bridge, done } = await setup([boss]);
  im.onSend((m) => {
    if (m.text.startsWith('❓')) setTimeout(() => im.receive({ userId: 'U1', text: 'staging', channelName: 'boss', mentioned: false }), 10);
  });
  try {
    im.receive({ userId: 'U1', text: 'deploy', channelName: 'boss' });
    await bridge.idle();
    assert.match(im.transcript().join('\n'), /answer: staging/);
  } finally {
    await done();
  }
});

test('hop limit stops delegation loops', async () => {
  const boss = scripted('boss', async (mcp) => text(await mcp.callTool({ name: 'delegate', arguments: { agent: 'helper', task: 'ping' } })));
  const helper = scripted('helper', async (mcp) => {
    const r = await mcp.callTool({ name: 'delegate', arguments: { agent: 'boss', task: 'pong' } });
    return `helper: ${text(r)}`;
  });
  const { im, bridge, done } = await setup(
    [boss, helper],
    `  - { from: helper, to: [boss] }`,
    `  - { match: { agent: "*" }, max_hops: 1 }`,
  );
  try {
    im.receive({ userId: 'U1', text: 'go', channelName: 'boss' });
    await bridge.idle();
    assert.match(im.transcript().join('\n'), /helper: delegation stopped: 2 hops exceeds the limit of 1/);
  } finally {
    await done();
  }
});

test('webhook agent', async () => {
  const http = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d)).on('end', () => {
      const t = JSON.parse(body);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ text: `hook got ${t.text}`, session_id: 'w1', cost_usd: 0.01 }));
    });
  });
  await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
  const port = (http.address() as any).port;
  const im = new FakeIm();
  const store = new Store(':memory:');
  const cfg = parseConfig(`
server: { port: 0 }
im: { slack: { app_token: env:A, bot_token: env:B } }
agents: { hook: { type: webhook, url: "http://127.0.0.1:${port}/" } }
routes: [ { from: "slack:*", to: hook } ]
`);
  const bridge = new Bridge({ cfg, store, ims: [im], log: () => {} });
  await bridge.start();
  try {
    im.receive({ userId: 'U5', text: 'ping' });
    await bridge.idle();
    assert.match(im.transcript().join('\n'), /hook got ping/);
    const s = store.getSession('slack:C1:T1');
    assert.equal(s?.agent_session_id, 'w1');
    assert.equal(s?.spent_usd, 0.01);
  } finally {
    await bridge.stop();
    http.close();
  }
});

test('approval buttons: wrong person is told privately, right person approves, message shows outcome', async () => {
  const boss = scripted('boss', async (mcp) => text(await mcp.callTool({ name: 'fake__delete_thing', arguments: { id: '9' } })));
  const im = new FakeIm().withButtons();
  const bridge = new Bridge({ cfg: parseConfig(yaml()), store: new Store(':memory:'), ims: [im], agents: new Map([['boss', boss]]), log: () => {} });
  await bridge.start();
  im.onSend((m) => {
    if (!m.text.startsWith('🔐')) return;
    setTimeout(() => {
      const id = [...im.choiceMessages.keys()].at(-1)!;
      im.click(id, 'Approve', 'U1'); // alice: not the initiator
      im.click(id, 'Approve', 'U2'); // bob: the initiator
      im.click(id, 'Deny', 'U2'); // too late, already decided
    }, 10);
  });
  try {
    im.receive({ userId: 'U2', text: 'delete 9', channelName: 'boss' });
    await bridge.idle();
    const [msg] = [...im.choiceMessages.values()];
    assert.equal(msg?.outcome, '✅ Approved by bob.');
    assert.deepEqual(im.notices.map((n) => [n.userId, n.text]), [
      ['U1', 'Only bob can decide this.'],
      ['U2', 'This choice has already been decided or has expired.'],
    ]);
    assert.match(im.transcript().join('\n'), /deleted 9/);
  } finally {
    await bridge.stop();
  }
});

test('budget: each turn gets what is left, and an exhausted budget stops the turn', async () => {
  const seen: (number | undefined)[] = [];
  const cc: AgentAdapter = { name: 'echo', async run(t) { seen.push(t.budgetUsd); return { text: 'ok', costUsd: 0.6 }; } };
  const im = new FakeIm();
  const bridge = new Bridge({
    cfg: parseConfig(yaml('', '  - { match: { agent: echo }, budget_usd: 1 }')),
    store: new Store(':memory:'), ims: [im], agents: new Map([['echo', cc]]), log: () => {},
  });
  await bridge.start();
  try {
    for (const t of ['one', 'two', 'three']) {
      im.receive({ userId: 'U1', text: t });
      await bridge.idle();
    }
    assert.equal(seen[0], 1);
    assert.ok(Math.abs(seen[1]! - 0.4) < 1e-9);
    assert.equal(seen.length, 2, 'third turn never reaches the agent');
    assert.match(im.transcript().join('\n'), /used its \$1 budget/);
  } finally {
    await bridge.stop();
  }
});

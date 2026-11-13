import assert from 'node:assert/strict';
import { request } from 'node:http';
import { test } from 'node:test';
import type { AgentAdapter, Workspace } from '../adapters/agent/types.ts';
import { parseConfig } from '../config/load.ts';
import { Bridge } from '../core/bridge.ts';
import { Store } from '../core/store.ts';
import { memoryStorage } from '../mcp/oauth.ts';
import { FakeIm } from './helpers.ts';

async function setup() {
  const calls: string[] = [];
  const ws: Workspace = {
    status: async (key) => (calls.includes(`gone:${key}`) ? undefined : '🌿 bridge/x: 1 commit'),
    previewMerge: async () => ({ ok: true, summary: 'Squash 1 commit into main' }),
    merge: async () => (calls.push('merge'), '✅ merged'),
    previewDiscard: async () => '1 unmerged commit',
    discard: async () => (calls.push('discard'), '🗑 discarded'),
  };
  const cc: AgentAdapter = { name: 'cc', workspace: ws, async run() { return { text: 'done', agentSessionId: 's1' }; } };
  const cfg = parseConfig(`
server: { port: 0 }
people: { alice: { trust: owner, slack: U1 }, bob: { trust: member, slack: U2 } }
im: { slack: { app_token: env:A, bot_token: env:B } }
agents: { cc: { type: stdio, command: "true" } }
routes: [ { from: "slack:*", when: { sender: [alice, bob] }, to: cc } ]
`);
  const im = new FakeIm();
  const bridge = new Bridge({ cfg, store: new Store(':memory:'), ims: [im], agents: new Map([['cc', cc]]), oauthStorage: memoryStorage(), log: () => {} });
  const { mcpUrl: base } = await bridge.start();
  const get = async (path: string) => (await fetch(base + path)).json() as Promise<any>;
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  return { bridge, im, calls, base, get, post };
}

test('dashboard: page, overview, deciding a pending choice as the owner', async () => {
  const { bridge, im, calls, base, get, post } = await setup();
  try {
    const page = await fetch(base + '/');
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<title>bridge<\/title>/);
    assert.match(page.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);

    im.receive({ userId: 'U1', text: 'merge' }); // asks "yes?" and waits
    let overview: any;
    for (let i = 0; i < 50 && !overview?.choices.length; i++) {
      await new Promise((r) => setTimeout(r, 20));
      overview = await get('/api/overview');
    }
    const [choice] = overview.choices;
    assert.equal(choice.text, 'Squash 1 commit into main');
    assert.deepEqual(choice.choices.map((c: any) => c.value), ['merge', 'cancel']);
    assert.deepEqual(choice.allowed, ['alice']);

    assert.equal((await post(`/api/choices/${choice.id}`, { value: 'nope' })).status, 400);
    const ok = await post(`/api/choices/${choice.id}`, { value: 'merge' });
    assert.equal(ok.status, 200);
    await bridge.idle();
    assert.deepEqual(calls, ['merge']);
    assert.match(im.transcript().join('\n'), /Merge — confirmed by alice \(web\)\./);
    assert.equal((await get('/api/overview')).choices.length, 0);
    assert.equal((await post(`/api/choices/${choice.id}`, { value: 'merge' })).status, 400, 'already decided');
  } finally {
    await bridge.stop();
  }
});

test('dashboard: conversations with branches, discard from the web, activity trace', async () => {
  const { bridge, im, calls, get, post } = await setup();
  try {
    im.receive({ userId: 'U1', text: 'change something' });
    await bridge.idle();
    const { sessions } = await get('/api/overview');
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].agent, 'cc');
    assert.equal(sessions[0].branch, '🌿 bridge/x: 1 commit');
    const key = sessions[0].key;

    const preview = await (await post('/api/sessions/discard', { key, preview: true })).json();
    assert.equal(preview.text, 'This throws away 1 unmerged commit');
    assert.deepEqual(calls, [], 'preview changes nothing');
    const done = await (await post('/api/sessions/discard', { key })).json();
    assert.equal(done.text, '🗑 discarded');
    assert.deepEqual(calls, ['discard']);
    assert.match(im.transcript().join('\n'), /🗑 discarded\n_\(from the dashboard, by alice\)_/);

    const trace = await get(`/api/trace?session=${encodeURIComponent(key)}`);
    assert.deepEqual(trace.map((t: any) => t.kind).slice(0, 2), ['discarded', 'reply']);
    assert.equal(trace[0].actor, 'alice (web)');
    assert.deepEqual(await get('/api/tools'), []);
  } finally {
    await bridge.stop();
  }
});

test('dashboard: refuses cross-origin writes, non-JSON posts and foreign Host headers', async () => {
  const { bridge, base, post } = await setup();
  try {
    assert.equal((await post('/api/sessions/merge', { key: 'x' }, { origin: 'https://evil.example' })).status, 403);
    const form = await fetch(base + '/api/sessions/merge', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
    assert.equal(form.status, 415);
    const port = new URL(base).port;
    const status = await new Promise<number>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: '/api/overview', headers: { host: `evil.example:${port}` } }, (res) => {
        res.resume();
        resolve(res.statusCode!);
      });
      req.on('error', reject);
      req.end();
    });
    assert.equal(status, 403, 'DNS rebinding guard');
    // The MCP endpoint and /api/status keep working as before.
    assert.equal((await fetch(base + '/api/status')).status, 200);
  } finally {
    await bridge.stop();
  }
});

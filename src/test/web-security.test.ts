import assert from 'node:assert/strict';
import { request } from 'node:http';
import { test } from 'node:test';
import { parseConfig } from '../config/load.ts';
import { Bridge } from '../core/bridge.ts';
import { Store } from '../core/store.ts';
import { memoryStorage } from '../mcp/oauth.ts';
import { FakeIm } from './helpers.ts';

function get(base: string, path: string, headers: Record<string, string>): Promise<number> {
  const { port } = new URL(base);
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers }, (res) => {
      res.resume();
      resolve(res.statusCode!);
    });
    req.on('error', reject);
    req.end();
  });
}

test('status needs a loopback Host; sign-in can only start from a navigation the user made', async () => {
  const cfg = parseConfig(`
server: { port: 0 }
people: { alice: { trust: owner, slack: U1 } }
im: { slack: { app_token: env:A, bot_token: env:B } }
tools:
  remote: { url: "http://127.0.0.1:9/mcp", oauth: true }
`);
  const bridge = new Bridge({ cfg, store: new Store(':memory:'), ims: [new FakeIm()], oauthStorage: memoryStorage(), log: () => {} });
  const { mcpUrl: base } = await bridge.start();
  const host = new URL(base).host;
  try {
    assert.equal(await get(base, '/api/status', { host }), 200);
    assert.equal(await get(base, '/api/status', { host: 'rebind.example:80' }), 403);

    // An <img> or fetch from another site: no Sec-Fetch-Site of same-origin/none.
    assert.equal(await get(base, '/oauth/start/remote', { host, 'sec-fetch-site': 'cross-site' }), 403);
    assert.equal(await get(base, '/oauth/start/remote', { host }), 403);
    // From the dashboard (same-origin) it gets as far as trying the provider (unreachable here → 400, not 403).
    assert.equal(await get(base, '/oauth/start/remote', { host, 'sec-fetch-site': 'same-origin' }), 400);

    const state = (await (await fetch(`${base}/api/oauth/remote`)).json()) as { status: string; last: unknown };
    assert.deepEqual(state, { status: 'signed-out', last: null });
  } finally {
    await bridge.stop();
  }
});

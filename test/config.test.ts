import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError, parseConfig } from '../src/config/load.ts';

const base = `
people: { alice: { trust: owner, slack: U1 } }
im: { slack: { app_token: env:A, bot_token: env:B } }
agents:
  cc: { type: claude-code }
  remote: { type: webhook, url: "http://localhost:1/x" }
`;

test('valid config parses with defaults', () => {
  const cfg = parseConfig(base + `routes:\n  - { from: "slack:#dev", when: { sender: [alice] }, to: cc }\n`);
  assert.equal(cfg.defaults.max_hops, 4);
  assert.equal(cfg.server.port, 7377);
});

test('local agent route from IM must name senders', () => {
  assert.throws(
    () => parseConfig(base + `routes:\n  - { from: "slack:#dev", to: cc }\n`),
    (e: unknown) => e instanceof ConfigError && /needs when.sender/.test(e.message),
  );
  // remote agents may take anyone; "anyone" is an explicit opt-out for local ones
  parseConfig(base + `routes:\n  - { from: "slack:#dev", to: remote }\n`);
  parseConfig(base + `routes:\n  - { from: "slack:#dev", when: { sender: anyone }, to: cc }\n`);
});

test('unknown references are reported', () => {
  assert.throws(
    () => parseConfig(base + `routes:\n  - { from: "slack:#dev", when: { sender: [bob] }, to: nope }\n  - { from: cc, to: [ghost.*] }\n`),
    (e: unknown) => e instanceof ConfigError && e.issues.length >= 2,
  );
});

test('unknown fields are rejected', () => {
  assert.throws(() => parseConfig(base + `routes:\n  - { from: "slack:#dev", to: remote, wehn: {} }\n`), ConfigError);
});

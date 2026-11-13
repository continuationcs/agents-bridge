import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigError, parseConfig } from '../config/load.ts';

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

test('names from Object.prototype are not agents or IMs', () => {
  assert.throws(
    () => parseConfig(base + `routes:\n  - { from: "slack:#dev", to: constructor }\n`),
    (e: unknown) => e instanceof ConfigError && /unknown agent "constructor"/.test(e.message),
  );
});

test('contradicting listen / mention is rejected', () => {
  assert.throws(
    () => parseConfig(base + `routes:\n  - { from: "slack:#dev", when: { listen: all, mention: true }, to: remote }\n`),
    (e: unknown) => e instanceof ConfigError && /contradicts when.mention/.test(e.message),
  );
  parseConfig(base + `routes:\n  - { from: "slack:#dev", when: { listen: all, mention: false }, to: remote }\n`);
});

test('policies: budgets and hop limits match by agent only; external people cannot approve', () => {
  assert.throws(
    () => parseConfig(base + `policies:\n  - { match: { tool: "github.*" }, budget_usd: 1 }\n`),
    (e: unknown) => e instanceof ConfigError && /apply per agent/.test(e.message),
  );
  assert.throws(
    () => parseConfig(base.replace('people: {', 'people: { eve: { trust: external, slack: U9 },') + `policies:\n  - { match: { tool: "*" }, approve_by: [eve] }\n`),
    (e: unknown) => e instanceof ConfigError && /trust external and can't approve/.test(e.message),
  );
});

test('durations are validated; retention defaults to 30d and can be off', () => {
  assert.equal(parseConfig(base).defaults.retention, '30d');
  assert.equal(parseConfig(base + `defaults: { retention: "off" }\n`).defaults.retention, 'off');
  assert.throws(() => parseConfig(base + `defaults: { retention: forever }\n`), ConfigError);
  assert.throws(() => parseConfig(base + `policies:\n  - { match: { tool: "*" }, approve_by: [alice], timeout: 30d }\n`), /too long for a timer/);
  assert.throws(() => parseConfig(base.replace('url: "http://localhost:1/x" }', 'url: "http://localhost:1/x", timeout: soon }')), ConfigError);
});

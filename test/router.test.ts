import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../src/config/load.ts';
import { Router, type InboundMessage } from '../src/core/router.ts';
import { PolicyEngine } from '../src/core/policy.ts';

const cfg = parseConfig(`
people: { alice: { slack: U1 }, bob: { slack: U2 } }
im: { slack: { app_token: env:A, bot_token: env:B } }
agents:
  claude-code: { type: claude-code }
  data-agent: { type: webhook, url: "http://localhost:1/x" }
tools:
  github: { command: x }
  warehouse: { command: x }
routes:
  - { from: "slack:#dev", when: { mention: claude-code, sender: [alice] }, to: claude-code }
  - { from: "slack:#claude", when: { listen: all, sender: [alice] }, to: claude-code }
  - { from: "slack:#data", to: data-agent }
  - { from: "slack:dm", when: { sender: [alice, bob] }, to: claude-code }
  - { from: claude-code, to: [warehouse.query, "github.*", data-agent] }
policies:
  - { match: { tool: ["github.push*", "*.delete*"] }, approve_by: [initiator, alice], timeout: 5m }
  - { match: { agent: "*" }, max_hops: 3, budget_usd: 2 }
  - { match: { agent: data-agent }, budget_usd: 0.5 }
  - { match: { tool: "warehouse.*", writes: true }, approve_by: [alice] }
`);
const router = new Router(cfg);
const msg = (o: Partial<InboundMessage>): InboundMessage => ({
  platform: 'slack', channelId: 'C1', channelName: 'dev', isDM: false, userId: 'U1',
  text: 'hi', mentioned: true, threadId: 'T', messageId: 'M', ...o,
});

test('mention route needs a mention and an allowed sender', () => {
  assert.equal(router.matchInbound(msg({}), { personId: 'alice' })?.agent, 'claude-code');
  assert.equal(router.matchInbound(msg({ mentioned: false }), { personId: 'alice' }), undefined);
  assert.equal(router.matchInbound(msg({}), { personId: 'bob' }), undefined);
  assert.equal(router.matchInbound(msg({}), {}), undefined);
});

test('thread replies continue without a fresh mention', () => {
  assert.equal(router.matchInbound(msg({ mentioned: false }), { personId: 'alice', threadAgent: 'claude-code' })?.agent, 'claude-code');
});

test('listen: all needs no mention', () => {
  assert.equal(router.matchInbound(msg({ channelName: 'claude', mentioned: false }), { personId: 'alice' })?.agent, 'claude-code');
});

test('a leading agent name addresses that agent and is stripped', () => {
  const m = router.matchInbound(msg({ channelName: 'data', text: 'data-agent, revenue last week?' }), {});
  assert.equal(m?.agent, 'data-agent');
  assert.equal(m?.text, 'revenue last week?');
  // addressing another agent skips routes for this one
  assert.equal(router.matchInbound(msg({ text: 'data-agent hi' }), { personId: 'alice' }), undefined);
});

test('DM routes', () => {
  assert.equal(router.matchInbound(msg({ isDM: true, channelName: 'dm', mentioned: false }), { personId: 'bob' })?.agent, 'claude-code');
});

test('explain gives a reason per route', () => {
  const { trace } = router.explainInbound(msg({ channelName: 'random' }), { personId: 'alice' });
  assert.ok(trace.every((l) => /does not match|different IM|no route matched/.test(l)), trace.join('\n'));
});

test('outbound routes cover agents and tools by glob', () => {
  assert.ok(router.allowsOutbound('claude-code', 'github.push_files'));
  assert.ok(router.allowsOutbound('claude-code', 'warehouse.query'));
  assert.ok(!router.allowsOutbound('claude-code', 'warehouse.drop_table'));
  assert.ok(router.allowsOutbound('claude-code', 'data-agent'));
  assert.ok(!router.allowsOutbound('data-agent', 'claude-code'));
  assert.ok(router.mayReachServer('claude-code', 'github'));
  assert.ok(!router.mayReachServer('data-agent', 'github'));
});

test('policies: strictest wins, approvers merge', () => {
  const p = new PolicyEngine(cfg);
  assert.equal(p.maxHops('claude-code'), 3);
  assert.equal(p.budgetUsd('data-agent'), 0.5);
  assert.equal(p.budgetUsd('claude-code'), 2);
  const a = p.approvalFor('github.push_files');
  assert.deepEqual(a?.approvers, ['initiator', 'alice']);
  assert.equal(a?.timeoutMs, 5 * 60e3);
  assert.equal(p.approvalFor('github.get_issue'), undefined);
  assert.ok(p.approvalFor('warehouse.delete_rows'));
  assert.equal(p.approvalFor('warehouse.query', { readOnly: true }), undefined, 'reads skip a writes-only policy');
  assert.deepEqual(p.approvalFor('warehouse.insert', { readOnly: false })?.approvers, ['alice']);
});

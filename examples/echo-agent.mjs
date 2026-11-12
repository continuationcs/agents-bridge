#!/usr/bin/env node
// Minimal stdio agent: reads {"type":"turn",...} lines, replies on stdout.
// Shows the whole protocol: progress, reply, and keeping your own session id.
import { createInterface } from 'node:readline';

const turns = new Map(); // session_id -> count

createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'turn') return;
  const session = msg.session_id ?? `echo-${Math.random().toString(36).slice(2, 8)}`;
  const n = (turns.get(session) ?? 0) + 1;
  turns.set(session, n);
  const out = (o) => process.stdout.write(JSON.stringify({ id: msg.id, ...o }) + '\n');
  out({ type: 'progress', text: 'thinking' });
  out({
    type: 'reply',
    text: `echo #${n} (from ${msg.envelope.initiator}, trust ${msg.envelope.trust}): ${msg.text}`,
    session_id: session,
    cost_usd: 0,
  });
});

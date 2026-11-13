// stdio agent for tests: "hold <path>" replies once <path> exists; anything else replies at once.
// Every reply names the process id, so a test can tell whether the process was replaced.
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline';

createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.type !== 'turn') return;
  const out = (o) => process.stdout.write(JSON.stringify({ id: msg.id, ...o }) + '\n');
  out({ type: 'progress', text: 'started' });
  const reply = () => out({ type: 'reply', text: `pid ${process.pid}`, session_id: 'hold', cost_usd: 0.25 });
  const hold = /^hold (.+)$/.exec(msg.text);
  if (!hold) return reply();
  const timer = setInterval(() => {
    if (!existsSync(hold[1])) return;
    clearInterval(timer);
    reply();
  }, 10);
});

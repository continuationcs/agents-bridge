import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TelegramAdapter } from '../adapters/im/telegram.ts';
import type { InboundMessage } from '../core/router.ts';

/** A local Bot API: getUpdates long-polls until updates are queued; sendMessage can be held. */
async function fakeTelegram() {
  const queue: object[] = [];
  const polls: { offset: number; timeout: number }[] = [];
  let waiting: ServerResponse | undefined;
  let hold: Promise<void> | undefined;
  let nextId = 500;
  const reply = (res: ServerResponse, result: unknown) => res.end(JSON.stringify({ ok: true, result }));
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', async () => {
      const method = req.url!.split('/').pop();
      const params = JSON.parse(body || '{}');
      if (method === 'getMe') return reply(res, { id: 99, username: 'bot' });
      if (method === 'sendMessage') {
        await hold;
        return reply(res, { message_id: nextId++ });
      }
      if (method === 'getUpdates') {
        polls.push({ offset: params.offset, timeout: params.timeout });
        if (queue.length || params.timeout === 0) return reply(res, queue.splice(0));
        waiting = res;
        return;
      }
      res.end(JSON.stringify({ ok: false, description: 'unknown method' }));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    apiBase: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    polls,
    push(...updates: object[]) {
      queue.push(...updates);
      if (waiting) {
        const res = waiting;
        waiting = undefined;
        reply(res, queue.splice(0));
      }
    },
    holdSends(p: Promise<void> | undefined) {
      hold = p;
    },
    close: () => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))),
  };
}

const message = (update: number, id: number, text: string, replyTo?: { id: number; fromBot?: boolean }) => ({
  update_id: update,
  message: {
    message_id: id,
    text,
    chat: { id: 5, type: 'group', title: 'dev' },
    from: { id: 1, username: 'alice' },
    ...(replyTo ? { reply_to_message: { message_id: replyTo.id, from: { id: replyTo.fromBot ? 99 : 1 } } } : {}),
  },
});

async function until(check: () => boolean, what: string) {
  const end = Date.now() + 10_000;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

test('telegram: offset is confirmed on stop and persisted, reply chains survive a restart, stop spares sends', async () => {
  const tg = await fakeTelegram();
  const stateFile = join(mkdtempSync(join(tmpdir(), 'ab-tg-')), 'telegram.json');
  try {
    const got: InboundMessage[] = [];
    const a = new TelegramAdapter({ botToken: 'T', apiBase: tg.apiBase, stateFile });
    await a.start((m) => got.push(m));
    tg.push(message(10, 100, 'hi'), message(11, 101, 'more', { id: 100 }));
    await until(() => got.length === 2, 'two messages');
    assert.deepEqual(got.map((m) => m.threadId), ['100', '100']);
    assert.equal(await a.send({ channelId: '5', threadId: '100', isDM: false, text: 'answer' }), '500');

    // A send in flight when stop() is called still completes.
    let release!: () => void;
    tg.holdSends(new Promise<void>((r) => (release = r)));
    const inFlight = a.send({ channelId: '5', threadId: '100', isDM: false, text: 'late' });
    const stopped = a.stop();
    release();
    assert.equal(await inFlight, '501');
    await stopped;
    tg.holdSends(undefined);
    assert.deepEqual(tg.polls.at(-1), { offset: 12, timeout: 0 }, 'handed-over updates confirmed to Telegram');

    const again: InboundMessage[] = [];
    const b = new TelegramAdapter({ botToken: 'T', apiBase: tg.apiBase, stateFile });
    await b.start((m) => again.push(m));
    await until(() => tg.polls.at(-1)?.timeout === 30, 'the first poll after restart');
    assert.equal(tg.polls.at(-1)!.offset, 12, 'nothing is fetched twice');
    tg.push(message(12, 102, 'to the bot', { id: 500, fromBot: true }), message(13, 103, 'to alice', { id: 101 }));
    await until(() => again.length === 2, 'messages after restart');
    assert.deepEqual(again.map((m) => [m.threadId, m.mentioned]), [['100', true], ['100', false]], 'same thread as before the restart');
    await b.stop();
  } finally {
    await tg.close();
  }
});

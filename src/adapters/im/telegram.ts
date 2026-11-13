import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { InboundMessage } from '../../core/router.ts';
import type { ImAdapter, OutboundMessage } from './types.ts';

/** How many message → thread-root entries are kept (and persisted): recent threads, a small file. */
const MAX_ROOTS = 5000;
/** Any call but the long poll. */
const CALL_TIMEOUT_MS = 60_000;

interface TelegramState {
  /** The next update id to fetch: everything below it was handed to the bridge. */
  offset: number;
  /** "chatId:messageId" → thread root message id, oldest first. */
  roots: [string, string][];
}

/**
 * Telegram via Bot API long polling (no public URL). In groups, turn off privacy mode in
 * @BotFather if routes use `listen: all`; otherwise the bot only sees mentions and replies.
 * A reply chain to one root message is one thread.
 *
 * With `stateFile`, the update offset and the reply-chain map survive restarts, so the last batch
 * isn't delivered twice and threads don't split. Without it the offset is still confirmed to
 * Telegram on stop().
 */
export class TelegramAdapter implements ImAdapter {
  readonly platform = 'telegram';
  readonly maxTextLength = 4000;
  private readonly api: string;
  private readonly stateFile?: string;
  private username = '';
  private botId = 0;
  private offset = 0;
  /** Cancels only the long poll; sends and edits in flight finish on their own. */
  private readonly polling = new AbortController();
  private pollLoop?: Promise<void>;
  private readonly rootOf = new Map<string, string>();

  constructor(opts: { botToken: string; apiBase?: string; stateFile?: string }) {
    this.api = `${opts.apiBase ?? 'https://api.telegram.org'}/bot${opts.botToken}`;
    this.stateFile = opts.stateFile;
    this.load();
  }

  async start(onMessage: (msg: InboundMessage) => void) {
    const me = await this.call<{ id: number; username: string }>('getMe', {});
    this.botId = me.id;
    this.username = me.username;
    this.pollLoop = this.poll(onMessage);
  }

  async stop() {
    this.polling.abort();
    await this.pollLoop;
    // Confirm what was handed over, so Telegram doesn't deliver it again after a restart.
    if (this.offset) {
      await this.call('getUpdates', { offset: this.offset, timeout: 0, limit: 1, allowed_updates: ['message'] }, AbortSignal.timeout(10_000)).catch(
        (err) => console.error(`telegram: confirming updates failed: ${(err as Error).message}`),
      );
    }
    this.save();
  }

  async send(msg: OutboundMessage): Promise<string> {
    const sent = await this.call<{ message_id: number }>('sendMessage', {
      chat_id: msg.channelId,
      text: msg.text,
      ...(msg.isDM ? {} : { reply_parameters: { message_id: Number(msg.threadId), allow_sending_without_reply: true } }),
    });
    const id = String(sent.message_id);
    this.remember(msg.channelId, id, msg.threadId);
    this.save();
    return id;
  }

  async edit(channelId: string, messageId: string, text: string) {
    await this.call('editMessageText', { chat_id: channelId, message_id: Number(messageId), text });
  }

  private async poll(onMessage: (msg: InboundMessage) => void) {
    const signal = this.polling.signal;
    while (!signal.aborted) {
      try {
        const updates = await this.call<any[]>(
          'getUpdates',
          { offset: this.offset, timeout: 30, allowed_updates: ['message'] },
          AbortSignal.any([signal, AbortSignal.timeout(30_000 + CALL_TIMEOUT_MS)]),
        );
        for (const u of updates) {
          this.offset = u.update_id + 1;
          const m = u.message;
          if (!m?.from || m.from.is_bot) continue;
          const parsed = this.parse(m);
          if (parsed) onMessage(parsed);
        }
        if (updates.length) this.save();
      } catch (err) {
        if (signal.aborted) return;
        console.error(`telegram poll: ${(err as Error).message}`);
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 3000);
          signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
        });
      }
    }
  }

  private parse(m: any): InboundMessage | undefined {
    const raw: string = m.text ?? m.caption ?? '';
    if (!raw) return undefined;
    const chatId = String(m.chat.id);
    const isDM = m.chat.type === 'private';
    const tag = `@${this.username}`;
    const repliesToBot = m.reply_to_message?.from?.id === this.botId;
    const replyTo = m.reply_to_message ? String(m.reply_to_message.message_id) : undefined;
    const messageId = String(m.message_id);
    const threadId = replyTo ? (this.rootOf.get(`${chatId}:${replyTo}`) ?? replyTo) : messageId;
    this.remember(chatId, messageId, threadId);
    return {
      platform: 'telegram',
      channelId: chatId,
      channelName: isDM ? 'dm' : String(m.chat.title ?? m.chat.username ?? chatId),
      isDM,
      userId: String(m.from.id),
      userName: m.from.username,
      text: raw.split(tag).join('').trim(),
      mentioned: raw.includes(tag) || repliesToBot,
      threadId,
      messageId,
    };
  }

  private remember(chatId: string, messageId: string, root: string) {
    this.rootOf.set(`${chatId}:${messageId}`, root);
    if (this.rootOf.size > MAX_ROOTS) this.rootOf.delete(this.rootOf.keys().next().value!);
  }

  private load() {
    if (!this.stateFile || !existsSync(this.stateFile)) return;
    try {
      const state = JSON.parse(readFileSync(this.stateFile, 'utf8')) as Partial<TelegramState>;
      if (typeof state.offset === 'number') this.offset = state.offset;
      for (const [k, v] of state.roots ?? []) if (typeof k === 'string' && typeof v === 'string') this.rootOf.set(k, v);
    } catch (err) {
      console.error(`telegram: ignoring unreadable ${this.stateFile}: ${(err as Error).message}`);
    }
  }

  /** Atomic write (temp file + rename), so a crash mid-write leaves the previous state. */
  private save() {
    if (!this.stateFile) return;
    const state: TelegramState = { offset: this.offset, roots: [...this.rootOf] };
    try {
      mkdirSync(dirname(this.stateFile), { recursive: true });
      const tmp = `${this.stateFile}.tmp`;
      writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
      renameSync(tmp, this.stateFile);
    } catch (err) {
      console.error(`telegram: saving ${this.stateFile} failed: ${(err as Error).message}`);
    }
  }

  private async call<T>(method: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const res = await fetch(`${this.api}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: signal ?? AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
    const json = (await res.json()) as { ok: boolean; result: T; description?: string };
    if (!json.ok) throw new Error(`${method}: ${json.description ?? res.status}`);
    return json.result;
  }
}

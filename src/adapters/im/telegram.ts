import type { InboundMessage } from '../../core/router.ts';
import type { ImAdapter, OutboundMessage } from './types.ts';

/**
 * Telegram via Bot API long polling (no public URL). In groups, turn off privacy mode in
 * @BotFather if routes use `listen: all`; otherwise the bot only sees mentions and replies.
 * A reply chain to one root message is one thread.
 */
export class TelegramAdapter implements ImAdapter {
  readonly platform = 'telegram';
  readonly maxTextLength = 4000;
  private readonly api: string;
  private username = '';
  private botId = 0;
  private offset = 0;
  private readonly abort = new AbortController();
  private readonly rootOf = new Map<string, string>();

  constructor(opts: { botToken: string; apiBase?: string }) {
    this.api = `${opts.apiBase ?? 'https://api.telegram.org'}/bot${opts.botToken}`;
  }

  async start(onMessage: (msg: InboundMessage) => void) {
    const me = await this.call<{ id: number; username: string }>('getMe', {});
    this.botId = me.id;
    this.username = me.username;
    void this.poll(onMessage);
  }

  async stop() {
    this.abort.abort();
  }

  async send(msg: OutboundMessage): Promise<string> {
    const sent = await this.call<{ message_id: number }>('sendMessage', {
      chat_id: msg.channelId,
      text: msg.text,
      ...(msg.isDM ? {} : { reply_parameters: { message_id: Number(msg.threadId), allow_sending_without_reply: true } }),
    });
    const id = String(sent.message_id);
    this.remember(msg.channelId, id, msg.threadId);
    return id;
  }

  async edit(channelId: string, messageId: string, text: string) {
    await this.call('editMessageText', { chat_id: channelId, message_id: Number(messageId), text });
  }

  private async poll(onMessage: (msg: InboundMessage) => void) {
    while (!this.abort.signal.aborted) {
      try {
        const updates = await this.call<any[]>('getUpdates', {
          offset: this.offset,
          timeout: 30,
          allowed_updates: ['message'],
        });
        for (const u of updates) {
          this.offset = u.update_id + 1;
          const m = u.message;
          if (!m?.from || m.from.is_bot) continue;
          const parsed = this.parse(m);
          if (parsed) onMessage(parsed);
        }
      } catch (err) {
        if (this.abort.signal.aborted) return;
        console.error(`telegram poll: ${(err as Error).message}`);
        await new Promise((r) => setTimeout(r, 3000));
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
    if (this.rootOf.size > 20000) this.rootOf.delete(this.rootOf.keys().next().value!);
  }

  private async call<T>(method: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.api}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: this.abort.signal,
    });
    const json = (await res.json()) as { ok: boolean; result: T; description?: string };
    if (!json.ok) throw new Error(`${method}: ${json.description ?? res.status}`);
    return json.result;
  }
}

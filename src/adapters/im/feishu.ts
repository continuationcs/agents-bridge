import * as lark from '@larksuiteoapi/node-sdk';
import type { Readable } from 'node:stream';
import type { InboundFile, InboundMessage } from '../../core/router.ts';
import { toFeishuMarkdown } from './feishu-format.ts';
import type { Choice, ImAdapter, InboundAction, OutboundMessage } from './types.ts';

/**
 * Feishu (飞书) or Lark over the long connection (outbound WebSocket, no public URL).
 * Replies are message cards, so progress can be edited in place and approvals get buttons.
 *
 * App setup (open.feishu.cn / open.larksuite.com → self-built app):
 *  - Features: Bot.
 *  - Scopes: im:message, im:message:send_as_bot, im:message.p2p_msg:readonly,
 *    im:message.group_at_msg:readonly, im:resource, im:chat:readonly
 *    (+ im:message.group_msg for routes with `listen: all`).
 *  - Events & callbacks: subscription mode "long connection"; event im.message.receive_v1;
 *    callback card.action.trigger.
 */
export class FeishuAdapter implements ImAdapter {
  readonly platform = 'feishu';
  readonly maxTextLength = 8000;
  private readonly client: lark.Client;
  private readonly ws: lark.WSClient;
  private botOpenId = '';
  private readonly chatNames = new Map<string, string>();

  constructor(opts: { appId: string; appSecret: string; domain?: 'feishu' | 'lark' }) {
    const domain = opts.domain === 'lark' ? lark.Domain.Lark : lark.Domain.Feishu;
    const base = { appId: opts.appId, appSecret: opts.appSecret, domain, loggerLevel: lark.LoggerLevel.warn };
    this.client = new lark.Client(base);
    this.ws = new lark.WSClient(base);
  }

  async start(onMessage: (msg: InboundMessage) => void, onAction?: (action: InboundAction) => void) {
    const info = (await this.client.request({ method: 'GET', url: '/open-apis/bot/v3/info' })) as {
      bot?: { open_id?: string };
    };
    this.botOpenId = info.bot?.open_id ?? '';
    if (!this.botOpenId) throw new Error('could not read the bot identity — is the Bot feature enabled for this app?');

    const dispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data: any) => {
        const msg = await this.parse(data).catch(() => undefined);
        if (msg) onMessage(msg);
      },
      'card.action.trigger': async (data: any) => {
        const value = data?.action?.value?.v;
        const messageId = data?.context?.open_message_id ?? data?.open_message_id;
        const userId = data?.operator?.open_id;
        if (typeof value === 'string' && messageId && userId && onAction) {
          onAction({ platform: 'feishu', channelId: data?.context?.open_chat_id ?? data?.open_chat_id ?? '', userId, messageId, value });
        }
        return {};
      },
    } as any);
    await this.ws.start({ eventDispatcher: dispatcher });
  }

  async stop() {
    (this.ws as unknown as { close?: () => void }).close?.();
  }

  async send(msg: OutboundMessage): Promise<string> {
    return this.post(msg, card(msg.text));
  }

  async edit(_channelId: string, messageId: string, text: string) {
    await this.client.im.message.patch({ path: { message_id: messageId }, data: { content: JSON.stringify(card(text)) } });
  }

  async sendChoice(msg: OutboundMessage, choices: Choice[]): Promise<string> {
    return this.post(msg, card(msg.text, { choices }));
  }

  async resolveChoice(_channelId: string, messageId: string, text: string, outcome: string) {
    await this.client.im.message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(card(text, { note: outcome })) },
    });
  }

  /** Only the clicker sees it (Feishu's ephemeral cards work in group chats). */
  async notifyUser(channelId: string, userId: string, text: string) {
    await this.client.request({
      method: 'POST',
      url: '/open-apis/ephemeral/v1/send',
      data: { chat_id: channelId, open_id: userId, msg_type: 'interactive', card: card(text) },
    });
  }

  /** Groups: reply inside the thread of the root message. DMs: plain message in the chat. */
  private async post(msg: OutboundMessage, content: object): Promise<string> {
    const body = { content: JSON.stringify(content), msg_type: 'interactive' };
    const res = msg.isDM
      ? await this.client.im.message.create({ params: { receive_id_type: 'chat_id' }, data: { receive_id: msg.channelId, ...body } })
      : await this.client.im.message.reply({ path: { message_id: msg.threadId }, data: { ...body, reply_in_thread: true } });
    const id = res?.data?.message_id;
    if (!id) throw new Error(`feishu send failed: ${res?.msg ?? 'no message id'}`);
    return id;
  }

  private async parse(data: any): Promise<InboundMessage | undefined> {
    const m = data?.message;
    const sender = data?.sender;
    if (!m || sender?.sender_type !== 'user') return undefined;
    const userId: string | undefined = sender?.sender_id?.open_id;
    if (!userId) return undefined;

    const mentions: any[] = m.mentions ?? [];
    const mentioned = mentions.some((x) => x?.id?.open_id === this.botOpenId);
    // "@_user_1" placeholders: drop the bot's, spell out everyone else's.
    const unmention = (s: string) =>
      mentions.reduce((acc, x) => acc.split(x.key).join(x?.id?.open_id === this.botOpenId ? '' : `@${x.name}`), s).trim();

    let content: any = {};
    try {
      content = JSON.parse(m.content ?? '{}');
    } catch {
      /* keep empty */
    }
    let text = '';
    const files: InboundFile[] = [];
    switch (m.message_type) {
      case 'text':
        text = unmention(String(content.text ?? ''));
        break;
      case 'post': {
        // Rich text: paragraphs of text / link / at / img / code elements.
        const parts: string[] = content.title ? [content.title] : [];
        for (const para of content.content ?? []) {
          parts.push(
            (para as any[])
              .map((el) => {
                if (el.tag === 'text' || el.tag === 'code_block') return el.text ?? '';
                if (el.tag === 'a') return el.href ? `[${el.text ?? el.href}](${el.href})` : el.text ?? '';
                if (el.tag === 'at') return el.user_id === this.botOpenId ? '' : `@${el.user_name ?? ''}`;
                if (el.tag === 'img' && el.image_key) files.push(this.file(m.message_id, el.image_key, 'image', `${el.image_key}.png`));
                return '';
              })
              .join(''),
          );
        }
        text = unmention(parts.join('\n'));
        break;
      }
      case 'image':
        files.push(this.file(m.message_id, content.image_key, 'image', `${content.image_key}.png`, 'image/png'));
        break;
      case 'file':
      case 'audio':
      case 'media':
        files.push(this.file(m.message_id, content.file_key, 'file', content.file_name ?? content.file_key));
        break;
      default:
        return undefined; // stickers, cards, system messages…
    }

    const isDM = m.chat_type === 'p2p';
    return {
      platform: 'feishu',
      channelId: m.chat_id,
      channelName: isDM ? 'dm' : await this.chatName(m.chat_id),
      isDM,
      userId,
      text,
      mentioned,
      threadId: m.root_id || m.message_id,
      messageId: m.message_id,
      files,
    };
  }

  private file(messageId: string, key: string, type: 'image' | 'file', name: string, mime?: string): InboundFile {
    return {
      name,
      mime,
      download: async () => {
        const res = await this.client.im.messageResource.get({ path: { message_id: messageId, file_key: key }, params: { type } });
        return streamToBuffer(res.getReadableStream());
      },
    };
  }

  private async chatName(chatId: string): Promise<string> {
    const cached = this.chatNames.get(chatId);
    if (cached) return cached;
    try {
      const res = await this.client.im.chat.get({ path: { chat_id: chatId } });
      const name = res?.data?.name || chatId;
      this.chatNames.set(chatId, name);
      return name;
    } catch {
      return chatId;
    }
  }
}

/** A card with one markdown block, plus optional buttons or an outcome note. */
export function card(text: string, opts: { choices?: Choice[]; note?: string } = {}) {
  const elements: object[] = [{ tag: 'markdown', content: toFeishuMarkdown(text) }];
  if (opts.choices?.length) {
    elements.push({
      tag: 'action',
      actions: opts.choices.map((c) => ({
        tag: 'button',
        text: { tag: 'plain_text', content: c.label },
        type: c.style === 'danger' ? 'danger' : c.style === 'primary' ? 'primary' : 'default',
        value: { v: c.value },
      })),
    });
  }
  if (opts.note) elements.push({ tag: 'note', elements: [{ tag: 'lark_md', content: toFeishuMarkdown(opts.note) }] });
  return { config: { wide_screen_mode: true, update_multi: true }, elements };
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks);
}

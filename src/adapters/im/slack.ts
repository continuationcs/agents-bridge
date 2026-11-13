import { SocketModeClient } from '@slack/socket-mode';
import { WebClient } from '@slack/web-api';
import type { InboundFile, InboundMessage } from '../../core/router.ts';
import { toSlackMrkdwn, truncateMrkdwn } from './slack-format.ts';
import type { Choice, ImAdapter, InboundAction, OutboundMessage } from './types.ts';

/** Section block text is limited to 3000 characters. */
const SECTION_MAX = 3000;

/**
 * Slack over Socket Mode (outbound WebSocket, no public URL).
 * App needs: connections:write (app token); chat:write, channels:history, groups:history,
 * im:history, channels:read, groups:read (private channel names), files:read (attachments)
 * (bot token); events message.channels, message.groups, message.im.
 */
export class SlackAdapter implements ImAdapter {
  readonly platform = 'slack';
  readonly maxTextLength = 3500;
  private readonly web: WebClient;
  private readonly socket: SocketModeClient;
  private readonly botToken: string;
  private botUserId = '';
  private readonly channelNames = new Map<string, string>();

  constructor(opts: { appToken: string; botToken: string }) {
    this.web = new WebClient(opts.botToken);
    this.botToken = opts.botToken;
    this.socket = new SocketModeClient({ appToken: opts.appToken });
  }

  async start(onMessage: (msg: InboundMessage) => void, onAction?: (action: InboundAction) => void) {
    this.socket.on('interactive', async ({ body, ack }: { body: any; ack: () => Promise<void> }) => {
      await ack();
      if (body?.type !== 'block_actions' || !onAction) return;
      for (const a of body.actions ?? []) {
        onAction({
          platform: 'slack',
          channelId: body.channel?.id ?? body.container?.channel_id,
          userId: body.user?.id,
          messageId: body.container?.message_ts ?? body.message?.ts,
          value: String(a.value ?? ''),
        });
      }
    });
    const auth = await this.web.auth.test();
    this.botUserId = String(auth.user_id);
    this.socket.on('message', async ({ event, ack }: { event: any; ack: () => Promise<void> }) => {
      await ack();
      if (!isPersonMessage(event, this.botUserId)) return;
      const mentionTag = `<@${this.botUserId}>`;
      const raw = String(event.text ?? '');
      const isDM = event.channel_type === 'im';
      onMessage({
        platform: 'slack',
        channelId: event.channel,
        channelName: isDM ? 'dm' : await this.channelName(event.channel),
        isDM,
        userId: event.user,
        text: raw.split(mentionTag).join('').trim(),
        mentioned: raw.includes(mentionTag),
        threadId: event.thread_ts ?? event.ts,
        messageId: event.ts,
        files: (event.files ?? []).map((f: any) => this.file(f)),
      });
    });
    await this.socket.start();
  }

  async stop() {
    await this.socket.disconnect();
  }

  async send(msg: OutboundMessage): Promise<string> {
    const res = await this.web.chat.postMessage({
      channel: msg.channelId,
      text: toSlackMrkdwn(msg.text),
      thread_ts: msg.isDM ? undefined : msg.threadId,
      unfurl_links: false,
    });
    return String(res.ts);
  }

  async sendChoice(msg: OutboundMessage, choices: Choice[]): Promise<string> {
    const text = toSlackMrkdwn(msg.text);
    const res = await this.web.chat.postMessage({
      channel: msg.channelId,
      thread_ts: msg.isDM ? undefined : msg.threadId,
      text,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: truncateMrkdwn(text, SECTION_MAX) } },
        {
          type: 'actions',
          elements: choices.map((c, i) => ({
            type: 'button',
            action_id: `choice_${i}`,
            text: { type: 'plain_text', text: c.label },
            value: c.value,
            ...(c.style ? { style: c.style } : {}),
          })),
        },
      ],
    });
    return String(res.ts);
  }

  async resolveChoice(channelId: string, messageId: string, text: string, outcome: string) {
    const body = toSlackMrkdwn(text);
    await this.web.chat.update({
      channel: channelId,
      ts: messageId,
      text: `${body}\n${outcome}`,
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: truncateMrkdwn(body, SECTION_MAX) } },
        { type: 'context', elements: [{ type: 'mrkdwn', text: toSlackMrkdwn(outcome) }] },
      ],
    });
  }

  async notifyUser(channelId: string, userId: string, text: string) {
    await this.web.chat.postEphemeral({ channel: channelId, user: userId, text: toSlackMrkdwn(text) });
  }

  async edit(channelId: string, messageId: string, text: string) {
    await this.web.chat.update({ channel: channelId, ts: messageId, text: toSlackMrkdwn(text) });
  }

  /** Slack file → InboundFile; private URLs need the bot token (scope files:read). */
  private file(f: any): InboundFile {
    return {
      name: String(f.name ?? f.title ?? f.id),
      mime: f.mimetype,
      size: typeof f.size === 'number' ? f.size : undefined,
      download: async () => {
        const url = f.url_private_download ?? f.url_private;
        if (!url) throw new Error('no download URL (is the files:read scope granted?)');
        const res = await fetch(url, { headers: { authorization: `Bearer ${this.botToken}` } });
        if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
        // Without files:read Slack answers 200 with its HTML login page instead of the file.
        if ((res.headers.get('content-type') ?? '').startsWith('text/html') && !String(f.mimetype).startsWith('text/html')) {
          throw new Error('Slack returned a login page — grant the files:read scope and reinstall the app');
        }
        return Buffer.from(await res.arrayBuffer());
      },
    };
  }

  private async channelName(id: string): Promise<string> {
    const cached = this.channelNames.get(id);
    if (cached) return cached;
    try {
      const info = await this.web.conversations.info({ channel: id });
      const name = info.channel?.name ?? id;
      this.channelNames.set(id, name);
      return name;
    } catch {
      return id;
    }
  }
}

/**
 * A message a person wrote: plain, with attachments (file_share), or a thread reply also sent to the
 * channel (thread_broadcast). Other subtypes are edits, deletions, joins, bot posts…
 */
export function isPersonMessage(event: any, botUserId: string): boolean {
  if (!event) return false;
  const subtypeOk = !event.subtype || event.subtype === 'file_share' || event.subtype === 'thread_broadcast';
  return subtypeOk && !event.bot_id && !!event.user && event.user !== botUserId;
}

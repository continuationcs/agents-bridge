import { SocketModeClient } from '@slack/socket-mode';
import { WebClient } from '@slack/web-api';
import type { InboundMessage } from '../../core/router.ts';
import { toSlackMrkdwn } from './slack-format.ts';
import type { Choice, ImAdapter, InboundAction, OutboundMessage } from './types.ts';

/**
 * Slack over Socket Mode (outbound WebSocket, no public URL).
 * App needs: connections:write (app token); chat:write, channels:history, groups:history,
 * im:history, channels:read (bot token); events message.channels, message.groups, message.im.
 */
export class SlackAdapter implements ImAdapter {
  readonly platform = 'slack';
  readonly maxTextLength = 3500;
  private readonly web: WebClient;
  private readonly socket: SocketModeClient;
  private botUserId = '';
  private readonly channelNames = new Map<string, string>();

  constructor(opts: { appToken: string; botToken: string }) {
    this.web = new WebClient(opts.botToken);
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
      if (!event || event.subtype || event.bot_id || !event.user || event.user === this.botUserId) return;
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
        { type: 'section', text: { type: 'mrkdwn', text: text.slice(0, 3000) } },
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
        { type: 'section', text: { type: 'mrkdwn', text: body.slice(0, 3000) } },
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

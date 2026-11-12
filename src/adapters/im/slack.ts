import { SocketModeClient } from '@slack/socket-mode';
import { WebClient } from '@slack/web-api';
import type { InboundMessage } from '../../core/router.ts';
import type { ImAdapter, OutboundMessage } from './types.ts';

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

  async start(onMessage: (msg: InboundMessage) => void) {
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
      text: msg.text,
      thread_ts: msg.isDM ? undefined : msg.threadId,
      unfurl_links: false,
    });
    return String(res.ts);
  }

  async edit(channelId: string, messageId: string, text: string) {
    await this.web.chat.update({ channel: channelId, ts: messageId, text });
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

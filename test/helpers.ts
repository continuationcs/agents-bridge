import type { ImAdapter, OutboundMessage } from '../src/adapters/im/types.ts';
import type { InboundMessage } from '../src/core/router.ts';

export class FakeIm implements ImAdapter {
  readonly platform: string;
  readonly maxTextLength = 1000;
  readonly sent: OutboundMessage[] = [];
  readonly edits: { messageId: string; text: string }[] = [];
  private onMessage?: (m: InboundMessage) => void;
  private n = 0;
  private listeners: Array<(m: OutboundMessage) => void> = [];

  constructor(platform = 'slack') {
    this.platform = platform;
  }
  async start(cb: (m: InboundMessage) => void) {
    this.onMessage = cb;
  }
  async stop() {}
  async send(m: OutboundMessage) {
    this.sent.push(m);
    for (const l of this.listeners) l(m);
    return `out-${++this.n}`;
  }
  async edit(_c: string, messageId: string, text: string) {
    this.edits.push({ messageId, text });
  }
  /** Everything visible in the thread: sends plus edits, in order. */
  transcript(): string[] {
    return [...this.sent.map((s) => s.text), ...this.edits.map((e) => e.text)];
  }
  onSend(l: (m: OutboundMessage) => void) {
    this.listeners.push(l);
  }
  receive(m: Partial<InboundMessage> & { text: string; userId: string }) {
    this.onMessage!({
      platform: this.platform,
      channelId: 'C1',
      channelName: 'dev',
      isDM: false,
      mentioned: true,
      threadId: 'T1',
      messageId: `in-${++this.n}`,
      ...m,
    });
  }
}

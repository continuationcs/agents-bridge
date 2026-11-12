import type { Choice, ImAdapter, InboundAction, OutboundMessage } from '../src/adapters/im/types.ts';
import type { InboundMessage } from '../src/core/router.ts';

export class FakeIm implements ImAdapter {
  readonly platform: string;
  readonly maxTextLength = 1000;
  readonly sent: OutboundMessage[] = [];
  readonly edits: { messageId: string; text: string }[] = [];
  private onMessage?: (m: InboundMessage) => void;
  private onAction?: (a: InboundAction) => void;
  readonly choiceMessages = new Map<string, { text: string; choices: Choice[]; outcome?: string }>();
  readonly notices: { userId: string; text: string }[] = [];
  private n = 0;
  private listeners: Array<(m: OutboundMessage) => void> = [];

  constructor(platform = 'slack') {
    this.platform = platform;
  }
  async start(cb: (m: InboundMessage) => void, onAction?: (a: InboundAction) => void) {
    this.onMessage = cb;
    this.onAction = onAction;
  }
  /** Give this fake buttons (like Slack). */
  withButtons() {
    const self = this as FakeIm & Pick<ImAdapter, 'sendChoice' | 'resolveChoice' | 'notifyUser'>;
    self.sendChoice = async (m: OutboundMessage, choices: Choice[]) => {
      const id = await this.send(m);
      this.choiceMessages.set(id, { text: m.text, choices });
      return id;
    };
    self.resolveChoice = async (_c: string, id: string, _t: string, outcome: string) => {
      this.choiceMessages.get(id)!.outcome = outcome;
    };
    self.notifyUser = async (_c: string, userId: string, text: string) => {
      this.notices.push({ userId, text });
    };
    return this;
  }
  /** Click the button labelled `label` on choice message `id`. */
  click(id: string, label: string, userId: string) {
    const c = this.choiceMessages.get(id)!.choices.find((x) => x.label === label)!;
    this.onAction!({ platform: this.platform, channelId: 'C1', userId, messageId: id, value: c.value });
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

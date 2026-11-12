import type { InboundMessage } from '../../core/router.ts';

export interface OutboundMessage {
  channelId: string;
  /** Reply inside this thread (root message id). */
  threadId: string;
  isDM: boolean;
  text: string;
}

/** A button. `value` comes back in an InboundAction when someone clicks it. */
export interface Choice {
  label: string;
  value: string;
  style?: 'primary' | 'danger';
}

/** Someone clicked a button the bridge sent. */
export interface InboundAction {
  platform: string;
  channelId: string;
  userId: string;
  messageId: string;
  value: string;
}

/** An IM connection. Every adapter connects outbound (socket / long-poll), so no public URL is needed. */
export interface ImAdapter {
  readonly platform: string;
  start(onMessage: (msg: InboundMessage) => void, onAction?: (action: InboundAction) => void): Promise<void>;
  stop(): Promise<void>;
  /** Returns the platform message id. */
  send(msg: OutboundMessage): Promise<string>;
  /** Replace a message the bridge sent earlier. Adapters that cannot edit leave this out. */
  edit?(channelId: string, messageId: string, text: string): Promise<void>;
  /** Post a message with buttons. Adapters without buttons leave this out; the bridge falls back to typed replies. */
  sendChoice?(msg: OutboundMessage, choices: Choice[]): Promise<string>;
  /** Replace a choice message once decided: same text, buttons swapped for the outcome. */
  resolveChoice?(channelId: string, messageId: string, text: string, outcome: string): Promise<void>;
  /** Tell one person something only they see (e.g. "only alice can decide"). */
  notifyUser?(channelId: string, userId: string, text: string): Promise<void>;
  /** Longest text one message can carry; the bridge splits longer replies. */
  readonly maxTextLength: number;
}

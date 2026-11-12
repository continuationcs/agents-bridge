import type { InboundMessage } from '../../core/router.ts';

export interface OutboundMessage {
  channelId: string;
  /** Reply inside this thread (root message id). */
  threadId: string;
  isDM: boolean;
  text: string;
}

/** An IM connection. Every adapter connects outbound (socket / long-poll), so no public URL is needed. */
export interface ImAdapter {
  readonly platform: string;
  start(onMessage: (msg: InboundMessage) => void): Promise<void>;
  stop(): Promise<void>;
  /** Returns the platform message id. */
  send(msg: OutboundMessage): Promise<string>;
  /** Replace a message the bridge sent earlier. Adapters that cannot edit leave this out. */
  edit?(channelId: string, messageId: string, text: string): Promise<void>;
  /** Longest text one message can carry; the bridge splits longer replies. */
  readonly maxTextLength: number;
}

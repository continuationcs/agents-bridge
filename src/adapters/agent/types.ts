import type { Envelope } from '../../core/envelope.ts';

export interface AgentTurn {
  envelope: Envelope;
  /** Prompt text for this turn. */
  text: string;
  /** The agent's own session id from the previous turn in this bridge session, if any. */
  agentSessionId?: string;
  /** Session-scoped MCP endpoint the agent can call back into (send_message, ask_human, delegate, tools). */
  mcp: { url: string; token: string };
  /** Short progress lines ("Reading src/…"). */
  onProgress?: (line: string) => void;
  /** The agent's session id, as soon as it is known (lets a crashed turn be resumed). */
  onSessionId?: (id: string) => void;
  /** A one-off note for the conversation (e.g. "working on branch X"). */
  onNotice?: (text: string) => void;
  signal?: AbortSignal;
}

export interface AgentReply {
  text: string;
  agentSessionId?: string;
  costUsd?: number;
}

/** Where an agent's work lives between turns (a git branch), for the in-thread status/merge/discard commands. */
export interface Workspace {
  /** Human-readable status, or undefined when this conversation has no workspace yet. */
  status(sessionKey: string): string | undefined;
  /** What merging would do, or why it can't happen now. */
  previewMerge(sessionKey: string): { ok: true; summary: string } | { ok: false; reason: string };
  merge(sessionKey: string): string;
  /** What discarding would throw away ('' when there is nothing to lose). */
  previewDiscard(sessionKey: string): string | undefined;
  discard(sessionKey: string): string;
}

export interface AgentAdapter {
  readonly name: string;
  run(turn: AgentTurn): Promise<AgentReply>;
  stop?(): Promise<void>;
  /** Present when the agent keeps its work on a per-conversation branch. */
  readonly workspace?: Workspace;
}

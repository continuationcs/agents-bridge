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
  signal?: AbortSignal;
}

export interface AgentReply {
  text: string;
  agentSessionId?: string;
  costUsd?: number;
}

export interface AgentAdapter {
  readonly name: string;
  run(turn: AgentTurn): Promise<AgentReply>;
  stop?(): Promise<void>;
}

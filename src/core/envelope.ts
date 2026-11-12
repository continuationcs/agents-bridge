import { randomUUID } from 'node:crypto';
import type { TrustLevel } from '../config/schema.ts';

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'file'; name: string; url?: string; mime?: string; /** Local copy the agent can read. */ path?: string };

export type Sender =
  | { kind: 'person'; id: string; platform: string; platformUserId: string; displayName?: string }
  | { kind: 'agent'; name: string };

/** Everything the bridge moves is wrapped in an envelope. */
export interface Envelope {
  id: string;
  sender: Sender;
  /** The bridge session (one per IM thread / DM window / delegation). */
  sessionKey: string;
  content: ContentBlock[];
  trust: TrustLevel;
  /** Person id of whoever started the chain; approvals default to them. */
  initiator: string;
  /** Agent-to-agent hops so far. 0 for a message straight from a person. */
  hops: number;
  /** Remaining USD budget for the whole chain, if a policy set one. */
  budgetUsd?: number;
  /** Content came from someone outside the trusted set (labelled, not enforced in v0.1). */
  tainted: boolean;
  createdAt: number;
}

export function newEnvelope(e: Omit<Envelope, 'id' | 'createdAt'>): Envelope {
  return { ...e, id: randomUUID(), createdAt: Date.now() };
}

export function textOf(e: Pick<Envelope, 'content'>): string {
  return e.content
    .map((b) => (b.type === 'text' ? b.text : `[file: ${b.name}${b.path ? ` ${b.path}` : b.url ? ` ${b.url}` : ''}]`))
    .join('\n');
}

const ORDER: TrustLevel[] = ['external', 'agent', 'member', 'trusted', 'owner'];
/** Delegated work never runs with more trust than any link in the chain. */
export function minTrust(a: TrustLevel, b: TrustLevel): TrustLevel {
  return ORDER.indexOf(a) <= ORDER.indexOf(b) ? a : b;
}

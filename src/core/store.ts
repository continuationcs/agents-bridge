import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface SessionRow {
  key: string;
  agent: string;
  agent_session_id: string | null;
  platform: string;
  channel_id: string;
  thread_id: string;
  initiator: string;
  created_at: number;
  last_active: number;
  spent_usd: number;
}

export interface QueueRow {
  id: string;
  status: 'pending' | 'running';
  session_key: string;
  payload: string;
  created_at: number;
}

export interface TraceRow {
  id: number;
  ts: number;
  session_key: string;
  kind: string;
  actor: string;
  detail: string;
}

/** SQLite holds sessions, the inbound queue, approvals and the audit trace. Pass ":memory:" in tests. */
export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS sessions (
        key TEXT PRIMARY KEY, agent TEXT NOT NULL, agent_session_id TEXT,
        platform TEXT NOT NULL, channel_id TEXT NOT NULL, thread_id TEXT NOT NULL,
        initiator TEXT NOT NULL, created_at INTEGER NOT NULL, last_active INTEGER NOT NULL,
        spent_usd REAL NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS queue (
        id TEXT PRIMARY KEY, session_key TEXT NOT NULL, payload TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS queue_pending ON queue(status, created_at);
      CREATE TABLE IF NOT EXISTS trace (
        id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, session_key TEXT NOT NULL,
        kind TEXT NOT NULL, actor TEXT NOT NULL, detail TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS trace_session ON trace(session_key, id);
    `);
  }

  getSession(key: string): SessionRow | undefined {
    return this.db.prepare('SELECT * FROM sessions WHERE key = ?').get(key) as SessionRow | undefined;
  }

  upsertSession(s: Omit<SessionRow, 'created_at' | 'last_active' | 'spent_usd'>): SessionRow {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO sessions (key, agent, agent_session_id, platform, channel_id, thread_id, initiator, created_at, last_active)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET agent = excluded.agent, last_active = excluded.last_active`,
      )
      .run(s.key, s.agent, s.agent_session_id, s.platform, s.channel_id, s.thread_id, s.initiator, now, now);
    return this.getSession(s.key)!;
  }

  updateSession(key: string, patch: { agent_session_id?: string | null; addSpentUsd?: number }) {
    const now = Date.now();
    if (patch.agent_session_id !== undefined) {
      this.db.prepare('UPDATE sessions SET agent_session_id = ? WHERE key = ?').run(patch.agent_session_id, key);
    }
    this.db
      .prepare('UPDATE sessions SET last_active = ?, spent_usd = spent_usd + ? WHERE key = ?')
      .run(now, patch.addSpentUsd ?? 0, key);
  }

  deleteSession(key: string) {
    this.db.prepare('DELETE FROM sessions WHERE key = ?').run(key);
  }

  listSessions(limit = 50): SessionRow[] {
    return this.db.prepare('SELECT * FROM sessions ORDER BY last_active DESC LIMIT ?').all(limit) as unknown as SessionRow[];
  }

  enqueue(id: string, sessionKey: string, payload: unknown) {
    this.db
      .prepare('INSERT INTO queue (id, session_key, payload, created_at) VALUES (?, ?, ?, ?)')
      .run(id, sessionKey, JSON.stringify(payload), Date.now());
  }

  /** A turn has started; `payload` is saved so a crash can resume it. */
  markRunning(id: string, payload: unknown) {
    this.db.prepare(`UPDATE queue SET status = 'running', payload = ? WHERE id = ?`).run(JSON.stringify(payload), id);
  }

  finish(id: string, status: 'done' | 'failed' | 'expired') {
    this.db.prepare('UPDATE queue SET status = ? WHERE id = ?').run(status, id);
  }

  /**
   * Work left over from a previous run: `pending` never started, `running` was cut off mid-turn.
   * Anything older than `ttlMs` is expired instead.
   */
  takePending(ttlMs: number): QueueRow[] {
    const cutoff = Date.now() - ttlMs;
    this.db
      .prepare(`UPDATE queue SET status = 'expired' WHERE status IN ('pending', 'running') AND created_at < ?`)
      .run(cutoff);
    return this.db
      .prepare(
        `SELECT id, status, session_key, payload, created_at FROM queue WHERE status IN ('pending', 'running') ORDER BY created_at`,
      )
      .all() as unknown as QueueRow[];
  }

  trace(sessionKey: string, kind: string, actor: string, detail: unknown) {
    this.db
      .prepare('INSERT INTO trace (ts, session_key, kind, actor, detail) VALUES (?, ?, ?, ?, ?)')
      .run(Date.now(), sessionKey, kind, actor, redact(JSON.stringify(detail ?? null)));
  }

  readTrace(opts: { sessionKey?: string; limit?: number } = {}): TraceRow[] {
    const limit = opts.limit ?? 100;
    const rows = opts.sessionKey
      ? this.db.prepare('SELECT * FROM trace WHERE session_key = ? ORDER BY id DESC LIMIT ?').all(opts.sessionKey, limit)
      : this.db.prepare('SELECT * FROM trace ORDER BY id DESC LIMIT ?').all(limit);
    return (rows as unknown as TraceRow[]).reverse();
  }

  close() {
    this.db.close();
  }
}

const SECRET_PATTERNS = [
  /xox[abposr]-[A-Za-z0-9-]{10,}/g, // Slack tokens
  /xapp-[A-Za-z0-9-]{10,}/g, // Slack app tokens
  /\b\d{6,}:[A-Za-z0-9_-]{30,}\b/g, // Telegram bot tokens
  /\bsk-[A-Za-z0-9_-]{16,}/g, // API keys
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub tokens
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
];

/** The audit log keeps everything except credentials. */
export function redact(s: string): string {
  return SECRET_PATTERNS.reduce((acc, re) => acc.replace(re, '[redacted]'), s);
}

import type { Database } from "bun:sqlite";
import type { SteerRecord } from "../types.js";

interface EnqueueOpts {
  target_message_id: string | null;
  target_agent: string;
  conversation_id: string;
  source: string;
  channel?: string | null;
  message: string;
  priority: "normal" | "interrupt";
  ttl_seconds?: number;
  on_expire?: "discard";
}

export class SteersDB {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS steers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        steer_id TEXT NOT NULL UNIQUE,
        target_message_id TEXT,
        target_agent TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        source TEXT NOT NULL,
        channel TEXT,
        message TEXT NOT NULL,
        priority TEXT NOT NULL DEFAULT 'normal',
        status TEXT NOT NULL DEFAULT 'pending',
        ttl_seconds INTEGER DEFAULT 300,
        on_expire TEXT NOT NULL DEFAULT 'discard',
        created_at INTEGER NOT NULL,
        delivered_at INTEGER,
        expired_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_steers_target ON steers (target_message_id, status);
      CREATE INDEX IF NOT EXISTS idx_steers_agent ON steers (target_agent, status, created_at);
    `);
  }

  enqueue(opts: EnqueueOpts): string {
    const steerId = `steer_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const now = Date.now();

    this.db.run(
      `INSERT INTO steers (steer_id, target_message_id, target_agent, conversation_id, source, channel, message, priority, ttl_seconds, on_expire, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        steerId,
        opts.target_message_id ?? null,
        opts.target_agent,
        opts.conversation_id,
        opts.source,
        opts.channel ?? null,
        opts.message,
        opts.priority,
        opts.ttl_seconds ?? 300,
        opts.on_expire ?? "discard",
        now,
      ],
    );

    return steerId;
  }

  getPending(messageId: string): SteerRecord[] {
    return this.db.query(
      `SELECT * FROM steers WHERE target_message_id = ? AND status = 'pending' ORDER BY created_at ASC`,
    ).all(messageId) as SteerRecord[];
  }

  pendingCount(messageId: string): number {
    const row = this.db.query(
      `SELECT count(*) as cnt FROM steers WHERE target_message_id = ? AND status = 'pending'`,
    ).get(messageId) as { cnt: number };
    return row.cnt;
  }

  markDelivered(steerId: string): void {
    this.db.run(
      `UPDATE steers SET status = 'delivered', delivered_at = ? WHERE steer_id = ?`,
      [Date.now(), steerId],
    );
  }

  expireForMessage(messageId: string): number {
    const now = Date.now();
    const result = this.db.run(
      `UPDATE steers SET status = 'expired', expired_at = ? WHERE target_message_id = ? AND status = 'pending'`,
      [now, messageId],
    );
    return result.changes;
  }

  expirePastTtl(): number {
    const now = Date.now();
    const result = this.db.run(
      `UPDATE steers SET status = 'expired', expired_at = ?
       WHERE status = 'pending'
         AND ttl_seconds IS NOT NULL
         AND (created_at + ttl_seconds * 1000) < ?`,
      [now, now],
    );
    return result.changes;
  }

  formatBatch(messageId: string): string {
    const steers = this.getPending(messageId);
    if (steers.length === 0) return "";

    const now = Date.now();
    const lines = steers.map((s, i) => {
      const agoMs = now - s.created_at;
      const agoMin = Math.max(1, Math.round(agoMs / 60_000));
      const agoStr = agoMin === 1 ? "1 min ago" : `${agoMin} min ago`;
      return `${i + 1}. (from ${s.source}, ${agoStr}): ${s.message}`;
    });

    return `[STEERS RECEIVED]\n${lines.join("\n")}\n[END STEERS]`;
  }
}

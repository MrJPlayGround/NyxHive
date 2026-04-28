import { Database } from "bun:sqlite";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { logger } from "../utils/logger.js";
import { formatError } from "../utils/error.js";
import { ensureTableSchema } from "../utils/schema.js";
import type {
  InputRequest,
  MessageData,
  MessageStatus,
  RelayOriginContext,
  ResponseData,
  SuspendedMessage,
  SuspendedProcessHandle,
} from "../types.js";

export interface QueueErrorAnalysis {
  category: "transient" | "cancelled" | "configuration" | "permanent" | "unknown";
  retryable: boolean;
  reason: string;
}

export interface QueueHealthReport {
  stats: { pending: number; processing: number; suspended: number; completed: number; failed: number; dead_letter: number };
  dead_letters: {
    total: number;
    retryable: number;
    categories: Record<string, number>;
    samples: Array<{
      message_id: string;
      agent?: string;
      task_id?: string;
      created_at: number;
      updated_at: number;
      error: string | null;
      analysis: QueueErrorAnalysis;
    }>;
  };
  stale_processing: Array<{
    message_id: string;
    agent?: string;
    task_id?: string;
    updated_at: number;
    age_ms: number;
  }>;
  stale_pending: Array<{
    message_id: string;
    agent?: string;
    task_id?: string;
    created_at: number;
    age_ms: number;
  }>;
}

export interface QueueDBOptions {
  resetOrphansOnStartup?: boolean;
}

const TRANSIENT_ERROR_PATTERNS = [
  /processing wall time exceeded/i,
  /timed out/i,
  /timeout/i,
  /rate limit/i,
  /\b429\b/,
  /temporar/i,
  /empty(?: final)? response/i,
  /empty output/i,
  /stream.*stall/i,
  /connection reset/i,
  /econnreset/i,
  /socket hang up/i,
  /network error/i,
  /service unavailable/i,
  /\b503\b/,
  /try again/i,
];

const CANCELLED_ERROR_PATTERNS = [
  /\babort(error|ed)?\b/i,
  /\bcancel(l)?ed\b/i,
];

const CONFIGURATION_ERROR_PATTERNS = [
  /unknown agent/i,
  /cannot be launched inside another/i,
  /api key/i,
  /authentication/i,
  /unauthorized/i,
  /forbidden/i,
  /blocked system directory/i,
  /reading prompt from stdin/i,
  /stdin is closed/i,
  /missing field [`'"]?id_token[`'"]?/i,
  /model [`'"]?[^`'"]+[`'"]? does not exist or you do not have access/i,
  /you['’]ve hit your limit/i,
  /\busage limit\b/i,
  /\bsession limit\b/i,
  /\bquota exceeded\b/i,
  /\bresets?\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)\b/i,
];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT NOT NULL UNIQUE,
    channel TEXT NOT NULL,
    sender TEXT NOT NULL,
    sender_id TEXT,
    task_id TEXT,
    message TEXT NOT NULL,
    agent TEXT,
    files TEXT,
    conversation_id TEXT,
    from_agent TEXT,
    thread_id TEXT,
    relay_origin_instance TEXT,
    relay_callback_url TEXT,
    relay_callback_token TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    priority INTEGER NOT NULL DEFAULT 1,
    retry_count INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    last_activity TEXT,
    last_progress_text TEXT,
    last_progress_at INTEGER,
    claimed_by TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_status ON messages(status, priority DESC, agent, created_at);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, status);
CREATE INDEX IF NOT EXISTS idx_messages_task ON messages(task_id, created_at DESC);

CREATE TABLE IF NOT EXISTS responses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id TEXT NOT NULL,
    channel TEXT NOT NULL,
    sender TEXT NOT NULL,
    sender_id TEXT,
    message TEXT NOT NULL,
    original_message TEXT NOT NULL,
    agent TEXT,
    files TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL,
    acked_at INTEGER,
    UNIQUE(message_id, channel)
);
CREATE INDEX IF NOT EXISTS idx_responses_channel ON responses(channel, status);

CREATE TABLE IF NOT EXISTS suspended_runs (
    message_id TEXT PRIMARY KEY,
    request_id TEXT NOT NULL UNIQUE,
    channel TEXT NOT NULL,
    sender TEXT NOT NULL,
    sender_id TEXT,
    task_id TEXT,
    agent TEXT,
    thread_id TEXT,
    original_message TEXT NOT NULL,
    request_json TEXT NOT NULL,
    response_text TEXT NOT NULL,
    reply_text TEXT,
    process_handle_json TEXT,
    suspended_at INTEGER NOT NULL,
    timeout_at INTEGER NOT NULL,
    resumed_at INTEGER,
    FOREIGN KEY (message_id) REFERENCES messages(message_id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_suspended_runs_sender ON suspended_runs(channel, sender_id, sender, suspended_at);
CREATE INDEX IF NOT EXISTS idx_suspended_runs_timeout ON suspended_runs(timeout_at);
`;

const DEFAULT_INPUT_TIMEOUT_MS = 30 * 60 * 1000;

interface SuspendedRunRow {
  message_id: string;
  request_id: string;
  channel: string;
  sender: string;
  sender_id: string | null;
  task_id: string | null;
  agent: string | null;
  thread_id: string | null;
  original_message: string;
  request_json: string;
  response_text: string;
  reply_text: string | null;
  process_handle_json: string | null;
  suspended_at: number;
  timeout_at: number;
  resumed_at: number | null;
}

function parseJson<T>(value: string | null): T | undefined {
  if (!value) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

function toSuspendedMessage(row: SuspendedRunRow): SuspendedMessage | null {
  const request = parseJson<InputRequest>(row.request_json);
  if (!request) return null;
  return {
    message_id: row.message_id,
    request_id: row.request_id,
    channel: row.channel,
    sender: row.sender,
    sender_id: row.sender_id ?? undefined,
    task_id: row.task_id ?? undefined,
    agent: row.agent ?? undefined,
    thread_id: row.thread_id ?? undefined,
    original_message: row.original_message,
    request,
    response_text: row.response_text,
    reply: row.reply_text ?? undefined,
    process_handle: parseJson<SuspendedProcessHandle>(row.process_handle_json),
    suspended_at: row.suspended_at,
    timeout_at: row.timeout_at,
    resumed_at: row.resumed_at ?? undefined,
  };
}

export class QueueDB {
  private db: Database;
  readonly events = new EventEmitter();
  private senderMessageCounts: Map<string, { count: number; windowStart: number }> = new Map();
  private rateLimitCallCount = 0;

  constructor(dataDir: string, instanceName?: string, opts?: QueueDBOptions) {
    const dbPath = join(dataDir, `${instanceName ?? "nyxhive"}.db`);
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    const walCheck = this.db.query("PRAGMA journal_mode").get() as { journal_mode: string } | null;
    if (walCheck?.journal_mode !== "wal") {
      logger.warn(`[queue] WAL mode not active (journal_mode=${walCheck?.journal_mode}), performance may be degraded`);
    }
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec("PRAGMA busy_timeout = 5000");

    // Detect stale schemas before CREATE TABLE IF NOT EXISTS (which silently skips existing tables)
    ensureTableSchema(this.db, {
      table: "messages",
      required: ["message_id", "channel", "sender", "sender_id", "task_id", "message", "agent", "files",
        "conversation_id", "from_agent", "thread_id", "relay_origin_instance", "relay_callback_url",
        "relay_callback_token", "status", "priority", "retry_count", "last_error",
        "last_activity", "last_progress_text", "last_progress_at", "claimed_by",
        "created_at", "updated_at"],
      ephemeral: true,
      columnDefs: {
        task_id: "TEXT",
      },
    }, "queue");
    ensureTableSchema(this.db, {
      table: "responses",
      required: ["message_id", "channel", "sender", "sender_id", "message", "original_message",
        "agent", "files", "status", "created_at", "acked_at"],
      ephemeral: true,
    }, "queue");

    this.db.exec(SCHEMA);
    ensureTableSchema(this.db, {
      table: "suspended_runs",
      required: [
        "message_id", "request_id", "channel", "sender", "sender_id", "task_id", "agent", "thread_id",
        "original_message", "request_json", "response_text", "reply_text", "process_handle_json",
        "suspended_at", "timeout_at", "resumed_at",
      ],
      ephemeral: false,
      columnDefs: {
        sender_id: "TEXT",
        task_id: "TEXT",
        agent: "TEXT",
        thread_id: "TEXT",
        reply_text: "TEXT",
        process_handle_json: "TEXT",
        resumed_at: "INTEGER",
      },
    }, "queue");

    // Ensure idempotency index exists for existing installs (table already existed before UNIQUE was added)
    try {
      this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_responses_idempotency ON responses(message_id, channel)");
    } catch (err) {
      const msg = formatError(err);
      logger.warn(`[queue] Could not create responses idempotency index: ${msg}`);
    }

    // Purge old responses on startup (30 day default)
    const purged = this.purgeOldResponses(30 * 24 * 60 * 60 * 1000);
    if (purged > 0) {
      logger.info(`[queue] Purged ${purged} old responses`);
    }

    // Reset orphaned 'processing' messages from prior crash
    if (opts?.resetOrphansOnStartup !== false) {
      const orphans = this.resetOrphans();
      if (orphans > 0) {
        logger.info(`[queue] Reset ${orphans} orphaned processing message(s) to pending`);
      }
    }

    logger.info(`[queue] Database ready: ${dbPath}`);
  }

  // --- Message Queue ---

  /**
   * Check for a duplicate message from the same sender/channel within a time window.
   * Returns the existing message_id if found, null otherwise.
   */
  findRecentDuplicate(channel: string, sender: string, message: string, windowMs = 10_000): string | null {
    const since = Date.now() - windowMs;
    const row = this.db
      .query(
        `SELECT message_id FROM messages
         WHERE channel = ? AND sender = ? AND message = ? AND created_at > ?
         LIMIT 1`,
      )
      .get(channel, sender, message, since) as { message_id: string } | null;
    return row?.message_id ?? null;
  }

  /**
   * Telegram and similar chat channels provide a stable per-message thread id.
   * Use it as a durable dedupe key so replayed updates after reconnect/restart
   * do not re-enqueue the same inbound message indefinitely.
   */
  findMessageByThread(channel: string, senderId: string | undefined, threadId: string | undefined): string | null {
    const normalizedSenderId = senderId?.trim();
    const normalizedThreadId = threadId?.trim();
    if (!normalizedSenderId || !normalizedThreadId) return null;

    const row = this.db
      .query(
        `SELECT message_id FROM messages
         WHERE channel = ? AND sender_id = ? AND thread_id = ?
         ORDER BY created_at ASC
         LIMIT 1`,
      )
      .get(channel, normalizedSenderId, normalizedThreadId) as { message_id: string } | null;
    return row?.message_id ?? null;
  }

  /**
   * Cross-channel duplicate check: find any recent message with the same content
   * regardless of channel or sender. Uses exact match on first 500 chars to catch
   * the same task being sent through multiple channels.
   */
  findRecentDuplicateAnyChannel(message: string, windowMs = 60_000): { message_id: string; channel: string } | null {
    const since = Date.now() - windowMs;
    const prefix = message.slice(0, 500);
    const row = this.db
      .query(
        `SELECT message_id, channel FROM messages
         WHERE SUBSTR(message, 1, 500) = ? AND created_at > ? AND status != 'dead_letter'
         ORDER BY created_at ASC LIMIT 1`,
      )
      .get(prefix, since) as { message_id: string; channel: string } | null;
    return row ?? null;
  }

  /**
   * Identity-scoped cross-channel duplicate check. This is intentionally narrower
   * than the global content-only lookup so unrelated users do not collide when
   * they happen to send the same short message on different channels.
   */
  findRecentDuplicateAnyChannelForIdentity(
    message: string,
    identity: { sender?: string; senderId?: string },
    windowMs = 60_000,
  ): { message_id: string; channel: string } | null {
    const senderId = identity.senderId?.trim();
    const sender = identity.sender?.trim();

    const clauses: string[] = [];
    const params: string[] = [];
    if (senderId) {
      clauses.push("sender_id = ?");
      params.push(senderId);
    }
    if (sender) {
      clauses.push("sender = ?");
      params.push(sender);
    }
    if (clauses.length === 0) return null;

    const since = Date.now() - windowMs;
    const prefix = message.slice(0, 500);
    const row = this.db
      .query(
        `SELECT message_id, channel FROM messages
         WHERE SUBSTR(message, 1, 500) = ? AND created_at > ? AND status != 'dead_letter'
           AND (${clauses.join(" OR ")})
         ORDER BY created_at ASC LIMIT 1`,
      )
      .get(prefix, since, ...params) as { message_id: string; channel: string } | null;
    return row ?? null;
  }

  enqueueMessage(opts: {
    channel: string;
    sender: string;
    sender_id?: string;
    task_id?: string;
    message: string;
    agent?: string;
    files?: string;
    conversation_id?: string;
    from_agent?: string;
    thread_id?: string;
    status?: MessageStatus;
    relay?: RelayOriginContext;
  }): string {
    const messageId = randomUUID();
    const now = Date.now();
    const status = opts.status ?? "pending";
    const priority = opts.channel === "system" || opts.channel === "scheduler" ? 2 : opts.channel === "background" ? 0 : 1;

    this.db.run(
      `INSERT INTO messages (message_id, channel, sender, sender_id, task_id, message, agent, files, conversation_id, from_agent, thread_id, relay_origin_instance, relay_callback_url, relay_callback_token, status, priority, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        messageId,
        opts.channel,
        opts.sender,
        opts.sender_id ?? null,
        opts.task_id ?? null,
        opts.message,
        opts.agent ?? null,
        opts.files ?? null,
        opts.conversation_id ?? null,
        opts.from_agent ?? null,
        opts.thread_id ?? null,
        opts.relay?.originInstance ?? null,
        opts.relay?.callbackUrl ?? null,
        opts.relay?.callbackToken ?? null,
        status,
        priority,
        now,
        now,
      ],
    );

    logger.debug(`[queue] Enqueued message ${messageId} for agent=${opts.agent ?? "any"} (${status})${opts.thread_id ? ` [thread=${opts.thread_id}]` : ""}`);
    this.events.emit("message-enqueued", { messageId });
    return messageId;
  }

  /**
   * Atomically claim a pending message for an agent.
   * Uses BEGIN IMMEDIATE for write lock to prevent double-claims.
   */
  claimMessage(agentName: string, opts?: { explicitOnly?: boolean }): MessageData | null {
    // BEGIN IMMEDIATE acquires a write lock immediately
    this.db.exec("BEGIN IMMEDIATE");

    try {
      // When explicitOnly is true (workers), only claim messages explicitly tagged for this agent.
      // Leads/orchestrators can also claim untagged messages (agent IS NULL).
      const agentFilter = opts?.explicitOnly
        ? `AND agent = ?`
        : `AND (agent IS NULL OR agent = ?)`;
      const row = this.db
        .query(
          `SELECT * FROM messages
           WHERE status = 'pending'
             ${agentFilter}
             AND thread_id IS NULL
           ORDER BY priority DESC, created_at ASC
           LIMIT 1`,
        )
        .get(agentName) as MessageData | null;

      if (!row) {
        this.db.exec("ROLLBACK");
        return null;
      }

      const now = Date.now();
      this.db.run(
        `UPDATE messages SET status = 'processing', claimed_by = ?, updated_at = ?
         WHERE message_id = ?`,
        [agentName, now, row.message_id],
      );

      this.db.exec("COMMIT");

      return { ...row, status: "processing", claimed_by: agentName, updated_at: now };
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /**
   * Atomically claim a pending thread message, skipping threads already in-flight.
   * Thread messages bypass the per-agent serial chain and run concurrently in the thread pool.
   */
  claimThreadMessage(activeThreadIds: string[]): MessageData | null {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      let query: string;
      let params: (string | number)[];

      if (activeThreadIds.length > 0) {
        const placeholders = activeThreadIds.map(() => "?").join(",");
        query = `SELECT * FROM messages
           WHERE status = 'pending'
             AND thread_id IS NOT NULL
             AND thread_id NOT IN (${placeholders})
           ORDER BY priority DESC, created_at ASC
           LIMIT 1`;
        params = [...activeThreadIds];
      } else {
        query = `SELECT * FROM messages
           WHERE status = 'pending'
             AND thread_id IS NOT NULL
           ORDER BY priority DESC, created_at ASC
           LIMIT 1`;
        params = [];
      }

      const row = this.db.query(query).get(...params) as MessageData | null;

      if (!row) {
        this.db.exec("ROLLBACK");
        return null;
      }

      const now = Date.now();
      this.db.run(
        `UPDATE messages SET status = 'processing', claimed_by = 'thread_pool', updated_at = ?
         WHERE message_id = ?`,
        [now, row.message_id],
      );

      this.db.exec("COMMIT");

      return { ...row, status: "processing", claimed_by: "thread_pool", updated_at: now };
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  completeMessage(messageId: string): void {
    const now = Date.now();
    this.db.run(
      `UPDATE messages
       SET status = 'completed',
           last_error = NULL,
           last_activity = NULL,
           last_progress_text = NULL,
           last_progress_at = NULL,
           claimed_by = NULL,
           updated_at = ?
       WHERE message_id = ?`,
      [now, messageId],
    );
  }

  suspendMessage(opts: {
    messageId: string;
    channel: string;
    sender: string;
    sender_id?: string;
    task_id?: string;
    agent?: string;
    thread_id?: string;
    original_message: string;
    requestId: string;
    request: InputRequest;
    responseText: string;
    processHandle?: SuspendedProcessHandle;
  }): SuspendedMessage {
    const suspendedAt = Date.now();
    const timeoutAt = suspendedAt + Math.max(1, opts.request.timeout_ms ?? DEFAULT_INPUT_TIMEOUT_MS);

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.run(
        `UPDATE messages
         SET status = 'suspended',
             last_activity = NULL,
             last_progress_text = NULL,
             last_progress_at = NULL,
             claimed_by = NULL,
             updated_at = ?
         WHERE message_id = ?`,
        [suspendedAt, opts.messageId],
      );

      this.db.run(
        `INSERT INTO suspended_runs (
           message_id, request_id, channel, sender, sender_id, task_id, agent, thread_id,
           original_message, request_json, response_text, reply_text, process_handle_json,
           suspended_at, timeout_at, resumed_at
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL)
         ON CONFLICT(message_id) DO UPDATE SET
           request_id = excluded.request_id,
           channel = excluded.channel,
           sender = excluded.sender,
           sender_id = excluded.sender_id,
           task_id = excluded.task_id,
           agent = excluded.agent,
           thread_id = excluded.thread_id,
           original_message = excluded.original_message,
           request_json = excluded.request_json,
           response_text = excluded.response_text,
           reply_text = NULL,
           process_handle_json = excluded.process_handle_json,
           suspended_at = excluded.suspended_at,
           timeout_at = excluded.timeout_at,
           resumed_at = NULL`,
        [
          opts.messageId,
          opts.requestId,
          opts.channel,
          opts.sender,
          opts.sender_id ?? null,
          opts.task_id ?? null,
          opts.agent ?? null,
          opts.thread_id ?? null,
          opts.original_message,
          JSON.stringify(opts.request),
          opts.responseText,
          opts.processHandle ? JSON.stringify(opts.processHandle) : null,
          suspendedAt,
          timeoutAt,
        ],
      );

      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    return {
      message_id: opts.messageId,
      request_id: opts.requestId,
      channel: opts.channel,
      sender: opts.sender,
      sender_id: opts.sender_id,
      task_id: opts.task_id,
      agent: opts.agent,
      thread_id: opts.thread_id,
      original_message: opts.original_message,
      request: opts.request,
      response_text: opts.responseText,
      process_handle: opts.processHandle,
      suspended_at: suspendedAt,
      timeout_at: timeoutAt,
    };
  }

  getSuspendedMessage(messageId: string): SuspendedMessage | null {
    const row = this.db
      .query(`SELECT * FROM suspended_runs WHERE message_id = ? LIMIT 1`)
      .get(messageId) as SuspendedRunRow | null;
    return row ? toSuspendedMessage(row) : null;
  }

  getSuspendedByRequestId(requestId: string): SuspendedMessage | null {
    const row = this.db
      .query(`SELECT * FROM suspended_runs WHERE request_id = ? LIMIT 1`)
      .get(requestId) as SuspendedRunRow | null;
    return row ? toSuspendedMessage(row) : null;
  }

  getSuspendedForSender(channel: string, sender: string, senderId?: string): SuspendedMessage | null {
    const rows = this.db
      .query(
        `SELECT sr.*
         FROM suspended_runs sr
         JOIN messages m ON m.message_id = sr.message_id
         WHERE m.status = 'suspended'
           AND sr.channel = ?
           AND ((sr.sender_id IS NOT NULL AND sr.sender_id = ?) OR sr.sender = ?)
         ORDER BY sr.suspended_at ASC
         LIMIT 1`,
      )
      .all(channel, senderId ?? null, sender) as SuspendedRunRow[];
    for (const row of rows) {
      const suspended = toSuspendedMessage(row);
      if (suspended) return suspended;
    }
    return null;
  }

  listSuspendedMessages(): SuspendedMessage[] {
    const rows = this.db
      .query(
        `SELECT sr.*
         FROM suspended_runs sr
         JOIN messages m ON m.message_id = sr.message_id
         WHERE m.status = 'suspended'
         ORDER BY sr.suspended_at ASC`,
      )
      .all() as SuspendedRunRow[];
    return rows.map((row) => toSuspendedMessage(row)).filter((row): row is SuspendedMessage => Boolean(row));
  }

  resumeSuspendedMessage(messageId: string, reply: string, nextStatus: "pending" | "processing" = "pending"): SuspendedMessage | null {
    const now = Date.now();
    const suspended = this.getSuspendedMessage(messageId);
    if (!suspended) return null;

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.run(
        `UPDATE messages
         SET status = ?,
             claimed_by = NULL,
             last_activity = NULL,
             last_progress_text = NULL,
             last_progress_at = NULL,
             updated_at = ?
         WHERE message_id = ?`,
        [nextStatus, now, messageId],
      );
      this.db.run(
        `UPDATE suspended_runs
         SET reply_text = ?, resumed_at = ?
         WHERE message_id = ?`,
        [reply, now, messageId],
      );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    if (nextStatus === "pending") {
      this.events.emit("message-enqueued", { messageId });
    }

    return {
      ...suspended,
      reply,
      resumed_at: now,
    };
  }

  clearSuspendedMessage(messageId: string): void {
    this.db.run("DELETE FROM suspended_runs WHERE message_id = ?", [messageId]);
  }

  expireSuspendedMessages(now = Date.now()): SuspendedMessage[] {
    const rows = this.db
      .query(
        `SELECT sr.*
         FROM suspended_runs sr
         JOIN messages m ON m.message_id = sr.message_id
         WHERE m.status = 'suspended' AND sr.timeout_at <= ?`,
      )
      .all(now) as SuspendedRunRow[];

    if (rows.length === 0) return [];

    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        this.db.run(
          `UPDATE messages
           SET status = 'failed',
               last_error = ?,
               last_activity = NULL,
               last_progress_text = NULL,
               last_progress_at = NULL,
               claimed_by = NULL,
               updated_at = ?
           WHERE message_id = ?`,
          ["Input request timed out waiting for user reply", now, row.message_id],
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    return rows.map((row) => toSuspendedMessage(row)).filter((row): row is SuspendedMessage => Boolean(row));
  }

  getActiveTasks(agentName: string): Array<{
    message_id: string;
    conversation_id: string;
    activity: string;
    started_at: number;
  }> {
    const rows = this.db.query(
      `SELECT message_id, conversation_id, last_activity, updated_at
       FROM messages
       WHERE agent = ? AND status = 'processing'
       ORDER BY updated_at DESC`,
    ).all(agentName) as Array<{
      message_id: string;
      conversation_id: string | null;
      last_activity: string | null;
      updated_at: number;
    }>;

    return rows.map((r) => ({
      message_id: r.message_id,
      conversation_id: r.conversation_id ?? "",
      activity: r.last_activity ?? "",
      started_at: r.updated_at,
    }));
  }

  getMessageProgress(messageId: string): { activity: string | null; text: string | null } | null {
    const row = this.db.query(
      "SELECT last_activity, last_progress_text FROM messages WHERE message_id = ?",
    ).get(messageId) as { last_activity: string | null; last_progress_text: string | null } | null;
    if (!row) return null;
    return { activity: row.last_activity, text: row.last_progress_text };
  }

  updateMessageProgress(messageId: string, progress: {
    activity?: string;
    text?: string;
  }): void {
    const updates: string[] = ["updated_at = ?"];
    const values: Array<number | string | null> = [Date.now()];

    if (progress.activity !== undefined) {
      updates.push("last_activity = ?");
      values.push(progress.activity.trim() || null);
    }
    if (progress.text !== undefined) {
      updates.push("last_progress_text = ?");
      values.push(progress.text.trim() || null);
    }
    if (progress.activity !== undefined || progress.text !== undefined) {
      updates.push("last_progress_at = ?");
      values.push(Date.now());
    }

    if (updates.length === 1) return;
    values.push(messageId);
    this.db.run(`UPDATE messages SET ${updates.join(", ")} WHERE message_id = ?`, values);
  }

  failMessage(messageId: string, error: string, maxRetries = 3): void {
    const now = Date.now();
    const msg = this.db
      .query("SELECT retry_count FROM messages WHERE message_id = ?")
      .get(messageId) as { retry_count: number } | null;

    if (!msg) return;

    const newRetry = msg.retry_count + 1;
    const newStatus: MessageStatus = newRetry >= maxRetries ? "dead_letter" : "pending";

    // Exponential backoff: delay retry so the poll loop skips it until ready.
    // created_at is pushed into the future so ORDER BY created_at ASC defers it.
    const backoffMs = Math.min(newRetry * 10_000, 60_000); // 10s, 20s, 30s... max 60s

    this.db.run(
      `UPDATE messages
       SET status = ?,
           retry_count = ?,
           last_error = ?,
           last_activity = NULL,
           last_progress_text = NULL,
           last_progress_at = NULL,
           claimed_by = NULL,
           updated_at = ?
       WHERE message_id = ?`,
      [newStatus, newRetry, error, now, messageId],
    );

    // Defer retry by pushing created_at forward (claim query orders by created_at ASC)
    if (newStatus === "pending") {
      this.db.run(
        `UPDATE messages SET created_at = ? WHERE message_id = ?`,
        [now + backoffMs, messageId],
      );
      logger.info(`[queue] Message ${messageId} retry ${newRetry}/${maxRetries} — deferred ${backoffMs / 1000}s`);
    }

    if (newStatus === "dead_letter") {
      logger.error(`[queue] Message ${messageId} moved to dead letter after ${newRetry} retries`);
    }
  }

  static analyzeError(error: string | null | undefined): QueueErrorAnalysis {
    const text = (error ?? "").trim();
    if (!text) {
      return { category: "unknown", retryable: false, reason: "No recorded error" };
    }
    if (CANCELLED_ERROR_PATTERNS.some((pattern) => pattern.test(text))) {
      return { category: "cancelled", retryable: false, reason: "Explicitly cancelled or aborted" };
    }
    if (CONFIGURATION_ERROR_PATTERNS.some((pattern) => pattern.test(text))) {
      return { category: "configuration", retryable: false, reason: "Configuration or environment failure" };
    }
    if (TRANSIENT_ERROR_PATTERNS.some((pattern) => pattern.test(text))) {
      return { category: "transient", retryable: true, reason: "Likely transient runtime failure" };
    }
    if (/syntax|type error|not found|invalid/i.test(text)) {
      return { category: "permanent", retryable: false, reason: "Likely deterministic failure" };
    }
    return { category: "unknown", retryable: false, reason: "Unclassified failure" };
  }

  static isTransientError(error: string | null | undefined): boolean {
    return QueueDB.analyzeError(error).retryable;
  }

  /**
   * Reset any messages stuck in 'processing' from a previous crash.
   * Called once at startup — returns them to 'pending' so the poll loop retries them.
   */
  resetOrphans(
    maxAgeMs = 5 * 60 * 1000,
    minAgeMs = 0,
    opts?: { maxWallAgeMs?: number },
  ): number {
    const now = Date.now();
    const staleCutoff = now - maxAgeMs;
    const freshCutoff = now - minAgeMs;

    if (opts?.maxWallAgeMs !== undefined) {
      const wallCutoff = now - opts.maxWallAgeMs;
      const wallStale = this.db.run(
        `UPDATE messages
         SET status = 'dead_letter',
             last_error = ?,
             last_activity = NULL,
             last_progress_text = NULL,
             last_progress_at = NULL,
             claimed_by = NULL,
             updated_at = ?
         WHERE status = 'processing' AND retry_count > 0 AND created_at < ?`,
        [`processing wall time exceeded ${opts.maxWallAgeMs / 60000}min`, now, wallCutoff],
      );
      if (wallStale.changes > 0) {
        logger.info(`[queue] Dead-lettered ${wallStale.changes} wall-stale orphan(s) (processing wall time longer than ${opts.maxWallAgeMs / 60000}min)`);
      }
    }

    // Dead-letter stale orphans (processing longer than maxAge — context is too outdated to re-execute).
    // Uses updated_at (set when message was claimed) to measure actual processing duration, not creation time.
    const stale = this.db.run(
      `UPDATE messages
       SET status = 'dead_letter',
           last_error = ?,
           last_activity = NULL,
           last_progress_text = NULL,
           last_progress_at = NULL,
           claimed_by = NULL,
           updated_at = ?
       WHERE status = 'processing' AND updated_at < ?`,
      [`processing stale longer than ${maxAgeMs / 60000}min`, now, staleCutoff],
    );
    if (stale.changes > 0) {
      logger.info(`[queue] Dead-lettered ${stale.changes} stale orphan(s) (processing longer than ${maxAgeMs / 60000}min)`);
    }

    // Reset orphans that have been processing between minAge and maxAge (likely crashed).
    // Messages younger than minAge are assumed to be actively running and are left alone.
    const fresh = this.db.run(
      `UPDATE messages
       SET status = 'pending',
           retry_count = retry_count + 1,
           last_error = ?,
           last_activity = NULL,
           last_progress_text = NULL,
           last_progress_at = NULL,
           claimed_by = NULL,
           updated_at = ?
       WHERE status = 'processing' AND updated_at >= ? AND updated_at <= ?`,
      [`orphaned processing reset after restart`, now, staleCutoff, freshCutoff],
    );
    return fresh.changes;
  }

  getPendingCount(agent?: string, opts?: { explicitOnly?: boolean }): number {
    if (agent) {
      const agentFilter = opts?.explicitOnly
        ? `AND agent = ?`
        : `AND (agent IS NULL OR agent = ?)`;
      const row = this.db
        .query(`SELECT COUNT(*) as count FROM messages WHERE status = 'pending' ${agentFilter} AND thread_id IS NULL`)
        .get(agent) as { count: number };
      return row.count;
    }
    const row = this.db
      .query(`SELECT COUNT(*) as count FROM messages WHERE status = 'pending' AND thread_id IS NULL`)
      .get() as { count: number };
    return row.count;
  }

  /** Count pending thread messages (optionally excluding specific thread IDs) */
  getPendingThreadCount(excludeThreadIds?: string[]): number {
    if (excludeThreadIds && excludeThreadIds.length > 0) {
      const placeholders = excludeThreadIds.map(() => "?").join(",");
      const row = this.db
        .query(`SELECT COUNT(*) as count FROM messages WHERE status = 'pending' AND thread_id IS NOT NULL AND thread_id NOT IN (${placeholders})`)
        .get(...excludeThreadIds) as { count: number };
      return row.count;
    }
    const row = this.db
      .query(`SELECT COUNT(*) as count FROM messages WHERE status = 'pending' AND thread_id IS NOT NULL`)
      .get() as { count: number };
    return row.count;
  }

  /** Count all pending messages (both channel and thread). Used by idle discovery. */
  getPendingCountAll(): number {
    const row = this.db
      .query(`SELECT COUNT(*) as count FROM messages WHERE status = 'pending'`)
      .get() as { count: number };
    return row.count;
  }

  /** Count distinct threads currently in 'processing' status */
  countActiveThreads(): number {
    const row = this.db
      .query(`SELECT COUNT(DISTINCT thread_id) as count FROM messages WHERE status = 'processing' AND thread_id IS NOT NULL`)
      .get() as { count: number };
    return row.count;
  }

  getQueueStats(): { pending: number; processing: number; suspended: number; completed: number; failed: number; dead_letter: number } {
    const rows = this.db
      .query("SELECT status, COUNT(*) as count FROM messages GROUP BY status")
      .all() as { status: string; count: number }[];

    const stats = { pending: 0, processing: 0, suspended: 0, completed: 0, failed: 0, dead_letter: 0 };
    for (const row of rows) {
      if (row.status in stats) {
        stats[row.status as keyof typeof stats] = row.count;
      }
    }
    return stats;
  }

  getRecentMessages(limit = 20): MessageData[] {
    return this.db
      .query("SELECT * FROM messages ORDER BY created_at DESC LIMIT ?")
      .all(limit) as MessageData[];
  }

  getDeadLetters(): MessageData[] {
    return this.db
      .query(`SELECT * FROM messages WHERE status = 'dead_letter' ORDER BY created_at DESC`)
      .all() as MessageData[];
  }

  getFailedMessages(): MessageData[] {
    return this.db
      .query(`SELECT * FROM messages WHERE status = 'failed' ORDER BY created_at DESC`)
      .all() as MessageData[];
  }

  /** Clear all dead letters by updating status to 'dead_letter_cleared'. Returns count cleared. */
  clearDeadLetters(): number {
    const now = Date.now();
    const result = this.db
      .query(`UPDATE messages SET status = 'dead_letter_cleared', updated_at = ? WHERE status = 'dead_letter'`)
      .run(now);
    return result.changes;
  }

  /** Clear a specific dead letter by message_id. Returns true if found and cleared. */
  clearDeadLetter(messageId: string): boolean {
    const now = Date.now();
    const result = this.db
      .query(`UPDATE messages SET status = 'dead_letter_cleared', updated_at = ? WHERE message_id = ? AND status = 'dead_letter'`)
      .run(now, messageId);
    return result.changes > 0;
  }

  clearFailedMessages(): number {
    const result = this.db
      .query(`DELETE FROM messages WHERE status = 'failed'`)
      .run();
    return result.changes;
  }

  clearFailedMessage(messageId: string): boolean {
    const result = this.db
      .query(`DELETE FROM messages WHERE message_id = ? AND status = 'failed'`)
      .run(messageId);
    return result.changes > 0;
  }

  getQueueHealth(opts: {
    deadLetterLimit?: number;
    staleProcessingMs?: number;
    stalePendingMs?: number;
  } = {}): QueueHealthReport {
    const now = Date.now();
    const deadLetterLimit = opts.deadLetterLimit ?? 20;
    const staleProcessingMs = opts.staleProcessingMs ?? 30 * 60 * 1000;
    const stalePendingMs = opts.stalePendingMs ?? 24 * 60 * 60 * 1000;

    const deadLetters = this.db
      .query(`SELECT message_id, task_id, agent, last_error, created_at, updated_at
              FROM messages
              WHERE status = 'dead_letter'
              ORDER BY updated_at DESC
              LIMIT ?`)
      .all(deadLetterLimit) as Array<{
        message_id: string;
        task_id: string | null;
        agent: string | null;
        last_error: string | null;
        created_at: number;
        updated_at: number;
      }>;

    const deadLetterRows = this.db
      .query(`SELECT last_error
              FROM messages
              WHERE status = 'dead_letter'`)
      .all() as Array<{ last_error: string | null }>;

    const categories: Record<string, number> = {};
    let retryable = 0;
    for (const row of deadLetterRows) {
      const analysis = QueueDB.analyzeError(row.last_error);
      categories[analysis.category] = (categories[analysis.category] ?? 0) + 1;
      if (analysis.retryable) retryable++;
    }

    const staleProcessing = this.db
      .query(`SELECT message_id, task_id, agent, updated_at
              FROM messages
              WHERE status = 'processing' AND updated_at < ?
              ORDER BY updated_at ASC
              LIMIT 20`)
      .all(now - staleProcessingMs) as Array<{
        message_id: string;
        task_id: string | null;
        agent: string | null;
        updated_at: number;
      }>;

    const stalePending = this.db
      .query(`SELECT message_id, task_id, agent, created_at
              FROM messages
              WHERE status = 'pending' AND created_at < ?
              ORDER BY created_at ASC
              LIMIT 20`)
      .all(now - stalePendingMs) as Array<{
        message_id: string;
        task_id: string | null;
        agent: string | null;
        created_at: number;
      }>;

    return {
      stats: this.getQueueStats(),
      dead_letters: {
        total: deadLetterRows.length,
        retryable,
        categories,
        samples: deadLetters.map((row) => ({
          message_id: row.message_id,
          task_id: row.task_id ?? undefined,
          agent: row.agent ?? undefined,
          created_at: row.created_at,
          updated_at: row.updated_at,
          error: row.last_error,
          analysis: QueueDB.analyzeError(row.last_error),
        })),
      },
      stale_processing: staleProcessing.map((row) => ({
        message_id: row.message_id,
        task_id: row.task_id ?? undefined,
        agent: row.agent ?? undefined,
        updated_at: row.updated_at,
        age_ms: now - row.updated_at,
      })),
      stale_pending: stalePending.map((row) => ({
        message_id: row.message_id,
        task_id: row.task_id ?? undefined,
        agent: row.agent ?? undefined,
        created_at: row.created_at,
        age_ms: now - row.created_at,
      })),
    };
  }

  deleteMessage(messageId: string): boolean {
    const result = this.db.run("DELETE FROM messages WHERE message_id = ?", [messageId]);
    return result.changes > 0;
  }

  retryMessage(messageId: string): boolean {
    const now = Date.now();
    const result = this.db.run(
      `UPDATE messages
       SET status = 'pending',
           claimed_by = NULL,
           last_activity = NULL,
           last_progress_text = NULL,
           last_progress_at = NULL,
           updated_at = ?
       WHERE message_id = ? AND status = 'dead_letter'`,
      [now, messageId],
    );
    if (result.changes > 0) {
      this.events.emit("message-enqueued", { messageId });
      return true;
    }
    return false;
  }

  // --- Response Queue ---

  enqueueResponse(opts: {
    message_id: string;
    channel: string;
    sender: string;
    sender_id?: string;
    message: string;
    original_message: string;
    agent?: string;
    files?: string;
  }): void {
    const now = Date.now();
    this.db.run(
      `INSERT OR IGNORE INTO responses (message_id, channel, sender, sender_id, message, original_message, agent, files, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
      [
        opts.message_id,
        opts.channel,
        opts.sender,
        opts.sender_id ?? null,
        opts.message,
        opts.original_message,
        opts.agent ?? null,
        opts.files ?? null,
        now,
      ],
    );
  }

  getResponsesForChannel(channel: string, limit = 10): ResponseData[] {
    return this.db
      .query(
        `SELECT * FROM responses
         WHERE channel = ? AND status = 'pending'
         ORDER BY created_at ASC
         LIMIT ?`,
      )
      .all(channel, limit) as ResponseData[];
  }

  getPendingResponses(limit = 50): ResponseData[] {
    return this.db
      .query(`SELECT * FROM responses WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?`)
      .all(limit) as ResponseData[];
  }

  ackResponse(id: number): void {
    const now = Date.now();
    this.db.run(
      `UPDATE responses SET status = 'sent', acked_at = ? WHERE id = ?`,
      [now, id],
    );
  }

  ackResponses(ids: number[]): void {
    if (ids.length === 0) return;
    const now = Date.now();
    const placeholders = ids.map(() => "?").join(",");
    this.db.run(
      `UPDATE responses SET status = 'sent', acked_at = ? WHERE id IN (${placeholders})`,
      [now, ...ids],
    );
  }

  purgeOldResponses(olderThanMs: number): number {
    const cutoff = Date.now() - olderThanMs;
    const stmt = this.db.prepare("DELETE FROM responses WHERE created_at < ? AND acked_at IS NOT NULL");
    const result = stmt.run(cutoff);
    return result.changes;
  }

  /**
   * Check if a sender is within the per-sender rate limit.
   * Returns true if the message should be allowed, false if rate-limited.
   * Default: max 10 messages per minute per sender.
   *
   * Call this before enqueueMessage in channel handlers to reject
   * senders who are sending too fast without blocking the queue.
   */
  checkSenderRateLimit(senderId: string, maxPerMinute = 10): boolean {
    const now = Date.now();
    const windowMs = 60_000; // 1 minute

    // Periodically sweep expired entries to prevent unbounded Map growth
    if (++this.rateLimitCallCount % 100 === 0) {
      for (const [id, e] of this.senderMessageCounts) {
        if (now - e.windowStart > windowMs) {
          this.senderMessageCounts.delete(id);
        }
      }
    }

    const entry = this.senderMessageCounts.get(senderId);
    if (!entry || now - entry.windowStart > windowMs) {
      // New window
      this.senderMessageCounts.set(senderId, { count: 1, windowStart: now });
      return true;
    }

    if (entry.count >= maxPerMinute) {
      return false;
    }

    entry.count++;
    return true;
  }

  getMessageByMessageId(messageId: string): MessageData | null {
    return this.db.prepare("SELECT * FROM messages WHERE message_id = ?").get(messageId) as MessageData | null;
  }

  getResponseByMessageId(messageId: string): ResponseData | null {
    return this.db.prepare("SELECT * FROM responses WHERE message_id = ?").get(messageId) as ResponseData | null;
  }

  close(): void {
    this.db.close();
  }
}

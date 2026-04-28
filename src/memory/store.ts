import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../utils/logger.js";
import { formatError } from "../utils/error.js";
import { ensureTableSchema, type TableSchemaCheck } from "../utils/schema.js";
import type { ArtifactJob, ArtifactQueueSink, AssemblyTrace, ContextArtifactRecord, ContextArtifactSourceType, ContextSourceKind, MemoryBeliefType, MemoryCurrentness, MemorySourceReliability } from "./retrieval-trace.js";
import type { ConversationTraceRow } from "../runtime/conversation-quality.js";
import { buildThreadArtifactSourceUri, defaultContextSourceKind, hashContextSource } from "./retrieval-trace.js";
import { assessMemoryTrust, clampConfidence, normalizeMemoryBeliefType } from "./belief-state.js";

/** A persisted conversation message with token/cost metadata. */
export interface StoredMessage {
  id: number;
  conversation_id: string;
  role: string;
  content: string;
  model: string | null;
  provider: string | null;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  importance_score?: number | null;
  created_at: number;
}

/** A free-form memory entry extracted from conversations (facts, preferences, learnings). */
export interface StoredMemory {
  id: number;
  content: string;
  category: string | null;
  source: string | null;
  memory_type: MemoryBeliefType;
  confidence: number;
  source_reliability: MemorySourceReliability;
  user_confirmed: number;
  currentness: MemoryCurrentness;
  status: string;
  supersedes_id: number | null;
  superseded_by_id: number | null;
  expires_at: number | null;
  created_at: number;
}

export interface MemorySaveOptions {
  category?: string | null;
  source?: string | null;
  memoryType?: MemoryBeliefType | string | null;
  confidence?: number | null;
  sourceReliability?: MemorySourceReliability | string | null;
  userConfirmed?: boolean | number | null;
  currentness?: MemoryCurrentness | string | null;
  status?: "current" | "stale" | "superseded" | "uncertain" | string | null;
  supersedesId?: number | null;
  expiresAt?: number | null;
}

/** Aggregated token usage and cost per model/agent pair, derived from trace_events. */
export interface UsageRecord {
  model: string;
  agent: string;
  total_tokens_in: number;
  total_tokens_out: number;
  total_cost: number;
  actual_cost: number;
  count: number;
}

export interface ConversationUsageSummary {
  total_tokens_in: number;
  total_tokens_out: number;
  total_cost_usd: number;
  model: string | null;
  provider: string | null;
  message_count: number;
}

/** FTS5 search result joining messages with their conversation's channel info. */
export interface MessageSearchResult {
  id: number;
  conversation_id: string;
  role: string;
  content: string;
  model: string | null;
  provider: string | null;
  created_at: number;
  channel: string;
  channel_id: string;
}

/** A logged unit of agent work — task description, result excerpt, and timing. */
export interface WorkLogEntry {
  id: number;
  agent_key: string;
  task: string;
  result: string;
  channel: string | null;
  duration_ms: number | null;
  created_at: number;
}

interface ContextArtifactSource {
  sourceUri: string;
  sourceType: ContextArtifactSourceType;
  sourceKind?: ContextSourceKind;
  sourceLabel?: string | null;
  importBatchId?: string | null;
  sourceHash: string;
}

function normalizeSourceReliability(
  value: string | null | undefined,
  userConfirmed?: boolean | number | null,
): MemorySourceReliability {
  if (userConfirmed) return "user_confirmed";
  switch (value) {
    case "user_confirmed":
    case "user_stated":
    case "assistant_inferred":
    case "system_observed":
    case "imported":
      return value;
    default:
      return "assistant_inferred";
  }
}

function normalizeCurrentness(value: string | null | undefined): MemoryCurrentness {
  switch (value) {
    case "current":
    case "stale":
    case "superseded":
    case "expired":
    case "uncertain":
      return value;
    default:
      return "current";
  }
}

/**
 * SQLite-backed persistence layer for conversations, messages, memories, usage stats, and agent work logs.
 * Uses WAL mode for concurrent read/write performance. Manages schema migrations via version tracking.
 * One instance per NyxHive project (each gets its own `{project}.db` file in the data directory).
 */
export class MemoryStore {
  private db: Database;
  private artifactQueue?: ArtifactQueueSink;

  constructor(dataDir: string, projectName?: string) {
    const fileName = `${(projectName ?? "memory").toLowerCase()}.db`;
    const dbPath = join(dataDir, fileName);
    this.db = new Database(dbPath, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    const walCheck = this.db.query("PRAGMA journal_mode").get() as { journal_mode: string } | null;
    if (walCheck?.journal_mode !== "wal") {
      logger.warn(`[memory] WAL mode not active (journal_mode=${walCheck?.journal_mode}), performance may be degraded`);
    }
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.init();
    this.initSchemaVersion();
  }

  private static readonly SCHEMA_VERSION = 1;

  private initSchemaVersion(): void {
    try {
      const row = this.db
        .query("SELECT version FROM schema_version ORDER BY version DESC LIMIT 1")
        .get() as { version: number } | null;
      const current = row?.version ?? 0;
      if (current < MemoryStore.SCHEMA_VERSION) {
        this.db
          .prepare("INSERT INTO schema_version (version, applied_at) VALUES (?, ?)")
          .run(MemoryStore.SCHEMA_VERSION, Date.now());
        logger.info(`[memory] Schema version set to ${MemoryStore.SCHEMA_VERSION}`);
      }
    } catch (err) {
      const msg = formatError(err);
      logger.warn(`[memory] Could not initialize schema version: ${msg}`);
    }
  }

  private init(): void {
    // Detect stale schemas before CREATE TABLE IF NOT EXISTS.
    // Persistent data — ALTER TABLE ADD COLUMN for missing columns.
    const persistentChecks: Omit<TableSchemaCheck, "ephemeral">[] = [
      {
        table: "conversations",
        required: ["channel", "channel_id", "created_at", "updated_at"],
        columnDefs: {
          channel: "TEXT NOT NULL DEFAULT ''", channel_id: "TEXT NOT NULL DEFAULT ''",
          created_at: "INTEGER NOT NULL DEFAULT 0", updated_at: "INTEGER NOT NULL DEFAULT 0",
        },
      },
      {
        table: "messages",
        required: ["conversation_id", "role", "content", "model", "provider",
          "tokens_in", "tokens_out", "cost_usd", "importance_score", "created_at"],
        columnDefs: {
          conversation_id: "TEXT NOT NULL DEFAULT ''", role: "TEXT NOT NULL DEFAULT ''",
          content: "TEXT NOT NULL DEFAULT ''", model: "TEXT", provider: "TEXT",
          tokens_in: "INTEGER DEFAULT 0", tokens_out: "INTEGER DEFAULT 0",
          cost_usd: "REAL DEFAULT 0", importance_score: "INTEGER",
          created_at: "INTEGER NOT NULL DEFAULT 0",
        },
      },
      {
        table: "memories",
        required: ["content", "category", "source", "memory_type", "confidence", "source_reliability", "user_confirmed",
          "currentness", "status", "supersedes_id", "superseded_by_id", "expires_at", "created_at"],
        columnDefs: {
          content: "TEXT NOT NULL DEFAULT ''", category: "TEXT",
          source: "TEXT",
          memory_type: "TEXT NOT NULL DEFAULT 'user_stated_fact'",
          confidence: "REAL NOT NULL DEFAULT 0.6",
          source_reliability: "TEXT NOT NULL DEFAULT 'assistant_inferred'",
          user_confirmed: "INTEGER NOT NULL DEFAULT 0",
          currentness: "TEXT NOT NULL DEFAULT 'current'",
          status: "TEXT NOT NULL DEFAULT 'current'",
          supersedes_id: "INTEGER",
          superseded_by_id: "INTEGER",
          expires_at: "INTEGER",
          created_at: "INTEGER NOT NULL DEFAULT 0",
        },
      },
      // usage table deprecated — trace_events is the single source of truth
      {
        table: "conversation_summaries",
        required: ["summary", "updated_at"],
        columnDefs: {
          summary: "TEXT NOT NULL DEFAULT ''", updated_at: "INTEGER NOT NULL DEFAULT 0",
        },
      },
      {
        table: "context_traces",
        required: ["conversation_id", "agent_key", "trace_json", "created_at"],
        columnDefs: {
          conversation_id: "TEXT", agent_key: "TEXT NOT NULL DEFAULT ''",
          trace_json: "TEXT NOT NULL DEFAULT '{}'", created_at: "INTEGER NOT NULL DEFAULT 0",
        },
      },
      {
        table: "execution_traces",
        required: ["origin_message_id", "channel", "sender", "sender_id", "input_message",
          "final_response", "status", "total_tokens_in", "total_tokens_out", "total_cost",
          "total_duration_ms", "agent_count", "created_at", "completed_at"],
        columnDefs: {
          origin_message_id: "TEXT", channel: "TEXT NOT NULL DEFAULT ''",
          sender: "TEXT NOT NULL DEFAULT ''", sender_id: "TEXT",
          input_message: "TEXT NOT NULL DEFAULT ''", final_response: "TEXT",
          status: "TEXT NOT NULL DEFAULT 'running'",
          total_tokens_in: "INTEGER DEFAULT 0", total_tokens_out: "INTEGER DEFAULT 0",
          total_cost: "REAL DEFAULT 0", total_duration_ms: "INTEGER DEFAULT 0",
          agent_count: "INTEGER DEFAULT 0", created_at: "INTEGER NOT NULL DEFAULT 0",
          completed_at: "INTEGER",
        },
      },
      {
        table: "trace_events",
        required: ["trace_id", "parent_event_id", "agent", "task", "response_excerpt",
          "status", "error", "tokens_in", "tokens_out", "cost", "duration_ms",
          "model", "task_type", "model_hint", "billing_type", "metadata_json",
          "started_at", "completed_at"],
        columnDefs: {
          trace_id: "TEXT NOT NULL DEFAULT ''", parent_event_id: "INTEGER",
          agent: "TEXT NOT NULL DEFAULT ''", task: "TEXT NOT NULL DEFAULT ''",
          response_excerpt: "TEXT", status: "TEXT NOT NULL DEFAULT 'running'",
          error: "TEXT", tokens_in: "INTEGER DEFAULT 0", tokens_out: "INTEGER DEFAULT 0",
          cost: "REAL DEFAULT 0", duration_ms: "INTEGER DEFAULT 0",
          model: "TEXT", task_type: "TEXT", model_hint: "TEXT",
          billing_type: "TEXT", metadata_json: "TEXT",
          started_at: "INTEGER NOT NULL DEFAULT 0", completed_at: "INTEGER",
        },
      },
      {
        table: "scheduled_run_artifacts",
        required: ["task_id", "task_name", "trace_id", "question", "decision", "outcome",
          "evidence_json", "artifacts_json", "notified", "suppression_reason",
          "notification_signature", "model_trust_tier", "started_at", "completed_at"],
        columnDefs: {
          task_id: "TEXT NOT NULL DEFAULT ''", task_name: "TEXT NOT NULL DEFAULT ''",
          trace_id: "TEXT", question: "TEXT NOT NULL DEFAULT ''",
          decision: "TEXT NOT NULL DEFAULT ''", outcome: "TEXT NOT NULL DEFAULT ''",
          evidence_json: "TEXT NOT NULL DEFAULT '{}'", artifacts_json: "TEXT NOT NULL DEFAULT '[]'",
          notified: "INTEGER NOT NULL DEFAULT 0", suppression_reason: "TEXT",
          notification_signature: "TEXT", model_trust_tier: "TEXT",
          started_at: "INTEGER NOT NULL DEFAULT 0", completed_at: "INTEGER NOT NULL DEFAULT 0",
        },
      },
      {
        table: "agent_work_log",
        required: ["agent_key", "task", "result", "channel", "duration_ms", "created_at"],
        columnDefs: {
          agent_key: "TEXT NOT NULL DEFAULT ''", task: "TEXT NOT NULL DEFAULT ''",
          result: "TEXT NOT NULL DEFAULT ''", channel: "TEXT",
          duration_ms: "INTEGER", created_at: "INTEGER NOT NULL DEFAULT 0",
        },
      },
      {
        table: "context_artifacts",
        required: ["source_uri", "source_type", "source_kind", "source_label", "import_batch_id", "source_hash", "l0_abstract", "l1_overview",
          "l0_vector", "generated_at", "generation_model", "is_stale"],
        columnDefs: {
          source_uri: "TEXT NOT NULL DEFAULT ''", source_type: "TEXT NOT NULL DEFAULT ''",
          source_kind: "TEXT NOT NULL DEFAULT 'retrieval_artifact'",
          source_label: "TEXT", import_batch_id: "TEXT",
          source_hash: "TEXT NOT NULL DEFAULT ''", l0_abstract: "TEXT", l1_overview: "TEXT",
          l0_vector: "BLOB", generated_at: "INTEGER", generation_model: "TEXT",
          is_stale: "INTEGER NOT NULL DEFAULT 0",
        },
      },
      {
        table: "schema_version",
        required: ["version", "applied_at"],
        columnDefs: {
          version: "INTEGER NOT NULL DEFAULT 0",
          applied_at: "INTEGER NOT NULL DEFAULT 0",
        },
      },
    ];
    for (const check of persistentChecks) {
      ensureTableSchema(this.db, { ...check, ephemeral: false }, "memory");
    }

    const schemaPath = join(import.meta.dir, "schema.sql");
    const schema = readFileSync(schemaPath, "utf-8");

    // Split on statement boundaries. Triggers contain internal semicolons,
    // so we split on ";\n" at the top level and track BEGIN/END blocks.
    const statements: string[] = [];
    let current = "";
    let inBlock = false;

    for (const line of schema.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("--") || trimmed === "") {
        continue;
      }

      current += `${line}\n`;

      if (/\bBEGIN\b/i.test(trimmed)) inBlock = true;
      if (/\bEND;/i.test(trimmed)) inBlock = false;

      if (!inBlock && trimmed.endsWith(";")) {
        statements.push(current.trim());
        current = "";
      }
    }

    if (current.trim()) statements.push(current.trim());

    for (const stmt of statements) {
      try {
        this.db.exec(stmt);
      } catch (err) {
        const msg = formatError(err);
        if (!msg.includes("already exists")) {
          logger.warn(`[memory] Schema warning: ${msg}`);
        }
      }
    }

    logger.info("[memory] Database initialized");
  }

  /** Access the underlying bun:sqlite Database instance (for advanced queries or subsystem integration). */
  getDb(): Database {
    return this.db;
  }

  // --- Conversations ---

  /** Create a conversation record or update its `updated_at` timestamp if it already exists. */
  ensureConversation(id: string, channel: string, channelId: string): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO conversations (id, channel, channel_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET updated_at = ?`,
      )
      .run(id, channel, channelId, now, now, now);
  }

  /** Delete a conversation and all its messages and summaries. */
  clearConversation(conversationId: string): void {
    this.db.prepare("DELETE FROM messages WHERE conversation_id = ?").run(conversationId);
    this.db.prepare("DELETE FROM conversation_summaries WHERE conversation_id = ?").run(conversationId);
    this.db.prepare("DELETE FROM conversations WHERE id = ?").run(conversationId);
    logger.info(`[memory] Cleared conversation ${conversationId}`);
  }

  /** Get the total number of messages in a conversation. */
  getMessageCount(conversationId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as count FROM messages WHERE conversation_id = ?")
      .get(conversationId) as { count: number };
    return row.count;
  }

  /** Delete all but the most recent `keepRecent` messages from a conversation. */
  trimOldMessages(conversationId: string, keepRecent: number): void {
    this.db
      .prepare(
        `DELETE FROM messages WHERE conversation_id = ? AND id NOT IN (
           SELECT id FROM messages WHERE conversation_id = ? ORDER BY created_at DESC, id DESC LIMIT ?
         )`,
      )
      .run(conversationId, conversationId, keepRecent);
  }

  // --- Messages ---

  /** Persist a message with its token usage and cost metadata. */
  saveMessage(
    conversationId: string,
    role: string,
    content: string,
    model: string | null,
    provider: string | null,
    tokensIn: number,
    tokensOut: number,
    costUsd: number,
    importanceScore: number | null = null,
  ): void {
    this.db
      .prepare(
        `INSERT INTO messages (conversation_id, role, content, model, provider, tokens_in, tokens_out, cost_usd, importance_score, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(conversationId, role, content, model, provider, tokensIn, tokensOut, costUsd, importanceScore, Date.now());
  }

  /** Retrieve messages for a conversation in chronological order. */
  getMessages(conversationId: string, limit = 50): StoredMessage[] {
    return this.db
      .prepare(
        "SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC, id DESC LIMIT ?",
      )
      .all(conversationId, limit)
      .reverse() as StoredMessage[];
  }

  /** Get the last N messages in chronological order. */
  getLastMessages(conversationId: string, count: number): StoredMessage[] {
    return this.db
      .prepare(
        "SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at DESC, id DESC LIMIT ?",
      )
      .all(conversationId, count)
      .reverse() as StoredMessage[];
  }

  /** Aggregate token usage and cost for a single conversation. */
  getConversationUsage(conversationId: string): ConversationUsageSummary {
    const totals = this.db
      .prepare(
        `SELECT
            COALESCE(SUM(tokens_in), 0) as total_tokens_in,
            COALESCE(SUM(tokens_out), 0) as total_tokens_out,
            COALESCE(SUM(cost_usd), 0) as total_cost_usd,
            COUNT(*) as message_count
         FROM messages
         WHERE conversation_id = ?`,
      )
      .get(conversationId) as {
        total_tokens_in: number;
        total_tokens_out: number;
        total_cost_usd: number;
        message_count: number;
      };

    const lastAssistant = this.db
      .prepare(
        `SELECT model, provider
         FROM messages
         WHERE conversation_id = ? AND role = 'assistant' AND model IS NOT NULL
         ORDER BY created_at DESC, id DESC
         LIMIT 1`,
      )
      .get(conversationId) as { model: string | null; provider: string | null } | null;

    return {
      ...totals,
      model: lastAssistant?.model ?? null,
      provider: lastAssistant?.provider ?? null,
    };
  }

  /** Delete the N most recent messages. Returns the number actually deleted. */
  deleteLastMessages(conversationId: string, count: number): number {
    const ids = this.db
      .prepare(
        "SELECT id FROM messages WHERE conversation_id = ? ORDER BY created_at DESC, id DESC LIMIT ?",
      )
      .all(conversationId, count) as { id: number }[];

    if (ids.length === 0) return 0;

    const placeholders = ids.map(() => "?").join(",");
    this.db
      .prepare(`DELETE FROM messages WHERE id IN (${placeholders})`)
      .run(...ids.map((r) => r.id));

    return ids.length;
  }

  /** Delete a single message by ID within a conversation. */
  deleteMessage(conversationId: string, messageId: number): void {
    this.db
      .prepare("DELETE FROM messages WHERE conversation_id = ? AND id = ?")
      .run(conversationId, messageId);
  }

  /** Update the content of a message (used by compaction to strip code blocks). */
  updateMessageContent(conversationId: string, messageId: number, content: string): void {
    this.db
      .prepare("UPDATE messages SET content = ? WHERE conversation_id = ? AND id = ?")
      .run(content, conversationId, messageId);
  }

  /** Cache a compaction importance score for a message. */
  updateMessageImportanceScore(conversationId: string, messageId: number, score: number | null): void {
    this.db
      .prepare("UPDATE messages SET importance_score = ? WHERE conversation_id = ? AND id = ?")
      .run(score, conversationId, messageId);
  }

  /** Invalidate cached importance scores after compaction changes message recency/shape. */
  clearImportanceScores(conversationId: string): void {
    this.db
      .prepare("UPDATE messages SET importance_score = NULL WHERE conversation_id = ?")
      .run(conversationId);
  }

  /** Trim a conversation to the most recent N messages. Returns number of messages removed. */
  trimToRecent(conversationId: string, keepRecent: number): number {
    const total = this.getMessageCount(conversationId);
    if (total <= keepRecent) return 0;

    this.db
      .prepare(
        `DELETE FROM messages WHERE conversation_id = ? AND id NOT IN (
           SELECT id FROM messages WHERE conversation_id = ? ORDER BY created_at DESC, id DESC LIMIT ?
         )`,
      )
      .run(conversationId, conversationId, keepRecent);

    return total - keepRecent;
  }

  // --- Message Search (global FTS5) ---

  /** Full-text search across all messages using FTS5 with BM25 ranking. */
  searchMessages(query: string, limit = 20): MessageSearchResult[] {
    try {
      const ftsQuery = query
        .split(/\s+/)
        .filter((w) => w.length > 1)
        .map((w) => `"${w}"`)
        .join(" OR ");

      if (!ftsQuery) return [];

      return this.db
        .prepare(
          `SELECT m.id, m.conversation_id, m.role, m.content, m.model, m.provider, m.created_at,
                  c.channel, c.channel_id
           FROM messages m
           JOIN messages_fts fts ON m.id = fts.rowid
           LEFT JOIN conversations c ON m.conversation_id = c.id
           WHERE messages_fts MATCH ?
           ORDER BY rank
           LIMIT ?`,
        )
        .all(ftsQuery, limit) as MessageSearchResult[];
    } catch {
      return [];
    }
  }

  /** Rebuild the FTS5 index for messages. Use after bulk imports or corruption recovery. */
  rebuildMessagesFts(): void {
    try {
      this.db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");
      logger.info("[memory] Rebuilt messages FTS index");
    } catch (err) {
      logger.warn(`[memory] Failed to rebuild messages FTS: ${formatError(err)}`);
    }
  }

  // --- Memories ---

  /** Store a memory entry. Returns the inserted row ID. */
  saveMemory(content: string, category?: string, source?: string): number;
  saveMemory(content: string, opts?: MemorySaveOptions): number;
  saveMemory(content: string, categoryOrOpts?: string | MemorySaveOptions, source?: string): number {
    const opts: MemorySaveOptions = typeof categoryOrOpts === "object" && categoryOrOpts !== null
      ? categoryOrOpts
      : { category: categoryOrOpts, source };
    const memoryType = normalizeMemoryBeliefType(opts.memoryType ?? opts.category);
    const confidence = clampConfidence(opts.confidence, opts.userConfirmed ? 0.84 : undefined);
    const sourceReliability = normalizeSourceReliability(opts.sourceReliability, opts.userConfirmed);
    const trust = assessMemoryTrust({
      confidence,
      sourceReliability,
      userConfirmed: opts.userConfirmed,
      status: opts.status ?? opts.currentness,
      supersedesId: opts.supersedesId,
      expiresAt: opts.expiresAt,
    });
    const currentness = normalizeCurrentness(opts.currentness ?? trust.currentness);
    const status = opts.status ?? currentness;
    const result = this.db
      .prepare(
        `INSERT INTO memories (
          content, category, source, memory_type, confidence, source_reliability, user_confirmed,
          currentness, status, supersedes_id, expires_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        content,
        opts.category ?? null,
        opts.source ?? null,
        memoryType,
        confidence,
        sourceReliability,
        opts.userConfirmed ? 1 : 0,
        currentness,
        status,
        opts.supersedesId ?? null,
        opts.expiresAt ?? null,
        Date.now(),
      );

    const insertedId = Number(result.lastInsertRowid);
    if (opts.supersedesId != null) {
      this.markMemorySuperseded(opts.supersedesId, insertedId);
    }

    return insertedId;
  }

  /** Search memories using FTS5 with BM25 ranking. */
  searchMemories(query: string, limit = 5): StoredMemory[] {
    try {
      // FTS5 search with BM25 ranking
      const ftsQuery = query
        .split(/\s+/)
        .filter((w) => w.length > 2)
        .map((w) => `"${w}"`)
        .join(" OR ");

      if (!ftsQuery) return [];

      return this.db
        .prepare(
          `SELECT m.* FROM memories m
           JOIN memories_fts fts ON m.id = fts.rowid
           WHERE memories_fts MATCH ?
           ORDER BY
             CASE m.currentness WHEN 'current' THEN 0 WHEN 'uncertain' THEN 1 WHEN 'stale' THEN 2 WHEN 'expired' THEN 3 WHEN 'superseded' THEN 4 ELSE 5 END,
             m.confidence DESC,
             rank
           LIMIT ?`,
        )
        .all(ftsQuery, limit) as StoredMemory[];
    } catch {
      return [];
    }
  }

  /** Delete a memory entry by ID. */
  deleteMemory(id: number): void {
    this.db.prepare("DELETE FROM memories WHERE id = ?").run(id);
  }

  /** List memories in reverse chronological order. */
  listMemories(limit = 20): StoredMemory[] {
    return this.db
      .prepare("SELECT * FROM memories ORDER BY created_at DESC, id DESC LIMIT ?")
      .all(limit) as StoredMemory[];
  }

  listMemoryTrust(limit = 50): Array<StoredMemory & { trust: ReturnType<typeof assessMemoryTrust> }> {
    return this.listMemories(limit).map((memory) => ({
      ...memory,
      trust: assessMemoryTrust({
        confidence: memory.confidence,
        sourceReliability: memory.source_reliability,
        userConfirmed: memory.user_confirmed,
        status: memory.status,
        supersededById: memory.superseded_by_id,
        expiresAt: memory.expires_at,
        createdAt: memory.created_at,
      }),
    }));
  }

  markMemorySuperseded(id: number, supersededById?: number | null): void {
    this.db
      .prepare("UPDATE memories SET currentness = 'superseded', status = 'superseded', superseded_by_id = ? WHERE id = ?")
      .run(supersededById ?? null, id);
  }

  // --- Summaries ---

  /** Get the rolling summary for a conversation, if one has been generated. */
  getConversationSummary(conversationId: string): string | null {
    const row = this.db
      .prepare("SELECT summary FROM conversation_summaries WHERE conversation_id = ?")
      .get(conversationId) as { summary: string } | undefined;
    return row?.summary ?? null;
  }

  /** Upsert a conversation summary (replaces existing if present). */
  saveConversationSummary(conversationId: string, summary: string): void {
    this.db
      .prepare(
        `INSERT INTO conversation_summaries (conversation_id, summary, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(conversation_id) DO UPDATE SET summary = ?, updated_at = ?`,
      )
      .run(conversationId, summary, Date.now(), summary, Date.now());

    const sourceUri = buildThreadArtifactSourceUri(conversationId);
    const sourceHash = hashContextSource(summary);
    if (this.touchContextArtifactSource({
      sourceUri,
      sourceType: "thread_archive",
      sourceKind: "summary_artifact",
      sourceLabel: conversationId,
      sourceHash,
    })) {
      this.enqueueContextArtifactJob({
        sourceUri,
        sourceType: "thread_archive",
        sourceKind: "summary_artifact",
        sourceLabel: conversationId,
        content: summary,
        priority: 1,
      });
    }
  }

  // --- Usage (reads from trace_events — single source of truth) ---

  /** Get aggregated token usage and cost per model/agent, sourced from trace_events. */
  getUsageSummary(sinceHours = 24): UsageRecord[] {
    const since = Date.now() - sinceHours * 60 * 60 * 1000;
    return this.db
      .prepare(
        `SELECT COALESCE(model, 'unknown') as model,
                LOWER(agent) as agent,
                COALESCE(SUM(tokens_in), 0) as total_tokens_in,
                COALESCE(SUM(tokens_out), 0) as total_tokens_out,
                COALESCE(SUM(cost), 0) as total_cost,
                COALESCE(SUM(CASE WHEN billing_type = 'api' THEN cost ELSE 0 END), 0) as actual_cost,
                COUNT(*) as count
         FROM trace_events WHERE started_at > ?
         GROUP BY model, LOWER(agent)
         ORDER BY total_cost DESC`,
      )
      .all(since) as UsageRecord[];
  }

  /** Get total USD cost across all agents within the given time window. */
  getTotalCost(sinceHours = 24): number {
    const since = Date.now() - sinceHours * 60 * 60 * 1000;
    const row = this.db
      .prepare("SELECT COALESCE(SUM(cost), 0) as total FROM trace_events WHERE started_at > ?")
      .get(since) as { total: number };
    return row.total;
  }

  /** Get actual billed API USD cost (excludes subscription-billed traces) within the given time window. */
  getActualCost(sinceHours = 24): number {
    const since = Date.now() - sinceHours * 60 * 60 * 1000;
    const row = this.db
      .prepare("SELECT COALESCE(SUM(CASE WHEN billing_type = 'api' THEN cost ELSE 0 END), 0) as total FROM trace_events WHERE started_at > ?")
      .get(since) as { total: number };
    return row.total;
  }

  // --- Work Log ---

  /** Log a completed agent task. Auto-prunes entries beyond `maxEntries` per agent. */
  saveWorkLog(
    agentKey: string,
    task: string,
    result: string,
    channel?: string,
    durationMs?: number,
    maxEntries = 20,
  ): void {
    const truncatedResult = result.slice(0, 4000);
    this.db
      .prepare(
        `INSERT INTO agent_work_log (agent_key, task, result, channel, duration_ms, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(agentKey, task, truncatedResult, channel ?? null, durationMs ?? null, Date.now());

    // Prune old entries beyond maxEntries for this agent
    this.db
      .prepare(
        `DELETE FROM agent_work_log WHERE agent_key = ? AND id NOT IN (
           SELECT id FROM agent_work_log WHERE agent_key = ? ORDER BY id DESC LIMIT ?
         )`,
      )
      .run(agentKey, agentKey, maxEntries);
  }

  /** Get recent work log entries for an agent in chronological order. */
  getWorkLog(agentKey: string, limit = 5): WorkLogEntry[] {
    return this.db
      .prepare(
        "SELECT * FROM agent_work_log WHERE agent_key = ? ORDER BY id DESC LIMIT ?",
      )
      .all(agentKey, limit)
      .reverse() as WorkLogEntry[];
  }

  /** Clear work log entries. If agentKey given, clear for that agent only; otherwise clear all. */
  clearWorkLog(agentKey?: string): void {
    if (agentKey) {
      this.db.prepare("DELETE FROM agent_work_log WHERE agent_key = ?").run(agentKey);
    } else {
      this.db.prepare("DELETE FROM agent_work_log").run();
    }
  }

  setArtifactQueue(queue?: ArtifactQueueSink): void {
    this.artifactQueue = queue;
  }

  enqueueContextArtifactJob(job: ArtifactJob): void {
    this.artifactQueue?.enqueue(job);
  }

  saveContextTrace(conversationId: string | null, agentKey: string, trace: AssemblyTrace): void {
    const now = Date.now();
    const cutoff = now - 7 * 24 * 60 * 60 * 1000;
    this.db.prepare("DELETE FROM context_traces WHERE created_at < ?").run(cutoff);
    this.db
      .prepare(
        `INSERT INTO context_traces (conversation_id, agent_key, trace_json, created_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(conversationId, agentKey, JSON.stringify(trace), now);
  }

  getContextTraces(conversationId?: string, limit = 20): Array<{
    id: number;
    conversation_id: string | null;
    agent_key: string;
    trace_json: string;
    created_at: number;
  }> {
    if (conversationId) {
      return this.db
        .prepare(
          "SELECT * FROM context_traces WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?",
        )
        .all(conversationId, limit) as Array<{
          id: number;
          conversation_id: string | null;
          agent_key: string;
          trace_json: string;
          created_at: number;
        }>;
    }
    return this.db
      .prepare("SELECT * FROM context_traces ORDER BY created_at DESC LIMIT ?")
      .all(limit) as Array<{
        id: number;
        conversation_id: string | null;
        agent_key: string;
        trace_json: string;
        created_at: number;
      }>;
  }

  getContextTraceById(id: number): {
    id: number;
    conversation_id: string | null;
    agent_key: string;
    trace_json: string;
    created_at: number;
  } | null {
    return this.db
      .prepare("SELECT * FROM context_traces WHERE id = ?")
      .get(id) as {
        id: number;
        conversation_id: string | null;
        agent_key: string;
        trace_json: string;
        created_at: number;
      } | null;
  }

  getConversationQualityTraceRows(limit = 100): ConversationTraceRow[] {
    return this.db
      .prepare(
        `SELECT
           ct.id,
           ct.conversation_id,
           ct.agent_key,
           ct.trace_json,
           ct.created_at,
           (
             SELECT m.content
             FROM messages m
             WHERE m.conversation_id = ct.conversation_id
               AND m.role = 'user'
               AND m.created_at <= ct.created_at
             ORDER BY m.created_at DESC, m.id DESC
             LIMIT 1
           ) AS user_message,
           (
             SELECT m.content
             FROM messages m
             WHERE m.conversation_id = ct.conversation_id
               AND m.role = 'assistant'
               AND m.created_at >= ct.created_at
             ORDER BY m.created_at ASC, m.id ASC
             LIMIT 1
           ) AS assistant_response
         FROM context_traces ct
         ORDER BY ct.created_at DESC
         LIMIT ?`,
      )
      .all(limit) as ConversationTraceRow[];
  }

  getContextArtifact(sourceUri: string): ContextArtifactRecord | null {
    return this.db
      .prepare("SELECT * FROM context_artifacts WHERE source_uri = ?")
      .get(sourceUri) as ContextArtifactRecord | null;
  }

  listContextArtifacts(opts?: {
    limit?: number;
    sourceType?: ContextArtifactSourceType;
    sourceKind?: ContextSourceKind;
    importBatchId?: string;
    staleOnly?: boolean;
  }): ContextArtifactRecord[] {
    const limit = opts?.limit ?? 50;
    const clauses: string[] = [];
    const params: Array<string | number> = [];

    if (opts?.sourceType) {
      clauses.push("source_type = ?");
      params.push(opts.sourceType);
    }
    if (opts?.sourceKind) {
      clauses.push("source_kind = ?");
      params.push(opts.sourceKind);
    }
    if (opts?.importBatchId) {
      clauses.push("import_batch_id = ?");
      params.push(opts.importBatchId);
    }
    if (opts?.staleOnly) {
      clauses.push("(is_stale = 1 OR generated_at IS NULL OR l0_abstract IS NULL OR l1_overview IS NULL)");
    }

    const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
    return this.db
      .prepare(
        `SELECT * FROM context_artifacts
         ${where}
         ORDER BY
           CASE WHEN is_stale = 1 OR generated_at IS NULL OR l0_abstract IS NULL OR l1_overview IS NULL THEN 0 ELSE 1 END ASC,
           COALESCE(generated_at, 0) DESC,
           id DESC
         LIMIT ?`,
      )
      .all(...params, limit) as ContextArtifactRecord[];
  }

  getContextArtifactStats(): {
    total: number;
    stale: number;
    missing: number;
    ready: number;
    by_type: Record<string, number>;
    by_kind: Record<string, number>;
  } {
    const totals = this.db
      .prepare(
        `SELECT
           COUNT(*) as total,
           SUM(CASE WHEN is_stale = 1 THEN 1 ELSE 0 END) as stale,
           SUM(CASE WHEN generated_at IS NULL OR l0_abstract IS NULL OR l1_overview IS NULL THEN 1 ELSE 0 END) as missing,
           SUM(CASE
             WHEN is_stale = 1 OR generated_at IS NULL OR l0_abstract IS NULL OR l1_overview IS NULL
             THEN 1 ELSE 0 END) as pending
         FROM context_artifacts`,
      )
      .get() as { total: number; stale: number | null; missing: number | null; pending: number | null };
    const byTypeRows = this.db
      .prepare("SELECT source_type, COUNT(*) as count FROM context_artifacts GROUP BY source_type")
      .all() as Array<{ source_type: string; count: number }>;
    const byKindRows = this.db
      .prepare("SELECT source_kind, COUNT(*) as count FROM context_artifacts GROUP BY source_kind")
      .all() as Array<{ source_kind: string; count: number }>;

    const byType: Record<string, number> = {};
    for (const row of byTypeRows) {
      byType[row.source_type] = row.count;
    }
    const byKind: Record<string, number> = {};
    for (const row of byKindRows) {
      byKind[row.source_kind] = row.count;
    }

    const total = totals.total ?? 0;
    const stale = totals.stale ?? 0;
    const missing = totals.missing ?? 0;
    const pending = totals.pending ?? 0;
    return {
      total,
      stale,
      missing,
      ready: Math.max(0, total - pending),
      by_type: byType,
      by_kind: byKind,
    };
  }

  listPendingContextArtifacts(limit = 100): ContextArtifactRecord[] {
    return this.db
      .prepare(
        `SELECT * FROM context_artifacts
         WHERE is_stale = 1 OR generated_at IS NULL OR l0_abstract IS NULL OR l1_overview IS NULL
         ORDER BY
           CASE WHEN is_stale = 1 THEN 0 ELSE 1 END ASC,
           COALESCE(generated_at, 0) ASC,
           id ASC
         LIMIT ?`,
      )
      .all(limit) as ContextArtifactRecord[];
  }

  touchContextArtifactSource(source: ContextArtifactSource): boolean {
    const sourceKind = source.sourceKind ?? defaultContextSourceKind(source.sourceType);
    const sourceLabel = source.sourceLabel ?? null;
    const importBatchId = source.importBatchId ?? null;
    const existing = this.getContextArtifact(source.sourceUri);
    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO context_artifacts (
             source_uri, source_type, source_kind, source_label, import_batch_id, source_hash, is_stale
           ) VALUES (?, ?, ?, ?, ?, ?, 1)`,
        )
        .run(source.sourceUri, source.sourceType, sourceKind, sourceLabel, importBatchId, source.sourceHash);
      return true;
    }

    const missingGenerated = !existing.l0_abstract || !existing.l1_overview || !existing.generated_at;
    const metadataChanged = existing.source_kind !== sourceKind
      || existing.source_label !== sourceLabel
      || existing.import_batch_id !== importBatchId;
    if (
      existing.source_hash !== source.sourceHash
      || existing.source_type !== source.sourceType
      || existing.is_stale === 1
      || missingGenerated
    ) {
      this.db
        .prepare(
          `UPDATE context_artifacts
           SET source_type = ?, source_kind = ?, source_label = ?, import_batch_id = ?,
               source_hash = ?, is_stale = 1
           WHERE source_uri = ?`,
        )
        .run(source.sourceType, sourceKind, sourceLabel, importBatchId, source.sourceHash, source.sourceUri);
      return true;
    }
    if (metadataChanged) {
      this.db
        .prepare(
          `UPDATE context_artifacts
           SET source_kind = ?, source_label = ?, import_batch_id = ?
           WHERE source_uri = ?`,
        )
        .run(sourceKind, sourceLabel, importBatchId, source.sourceUri);
    }

    return false;
  }

  saveContextArtifact(opts: {
    sourceUri: string;
    sourceType: ContextArtifactSourceType;
    sourceKind?: ContextSourceKind;
    sourceLabel?: string | null;
    importBatchId?: string | null;
    sourceHash: string;
    l0Abstract: string | null;
    l1Overview: string | null;
    l0Vector?: Float32Array | null;
    generationModel: string | null;
  }): void {
    const now = Date.now();
    const sourceKind = opts.sourceKind ?? defaultContextSourceKind(opts.sourceType);
    const vectorBlob = opts.l0Vector
      ? Buffer.from(opts.l0Vector.buffer, opts.l0Vector.byteOffset, opts.l0Vector.byteLength)
      : null;
    this.db
      .prepare(
        `INSERT INTO context_artifacts (
          source_uri, source_type, source_kind, source_label, import_batch_id,
          source_hash, l0_abstract, l1_overview,
          l0_vector, generated_at, generation_model, is_stale
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
        ON CONFLICT(source_uri) DO UPDATE SET
          source_type = excluded.source_type,
          source_kind = excluded.source_kind,
          source_label = excluded.source_label,
          import_batch_id = excluded.import_batch_id,
          source_hash = excluded.source_hash,
          l0_abstract = excluded.l0_abstract,
          l1_overview = excluded.l1_overview,
          l0_vector = excluded.l0_vector,
          generated_at = excluded.generated_at,
          generation_model = excluded.generation_model,
          is_stale = 0`,
      )
      .run(
        opts.sourceUri,
        opts.sourceType,
        sourceKind,
        opts.sourceLabel ?? null,
        opts.importBatchId ?? null,
        opts.sourceHash,
        opts.l0Abstract,
        opts.l1Overview,
        vectorBlob,
        now,
        opts.generationModel,
      );
  }

  /** Close the SQLite database connection. */
  close(): void {
    this.db.close();
  }
}

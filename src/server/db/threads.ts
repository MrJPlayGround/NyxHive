import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import type {
  Thread,
  ThreadMessage,
  ThreadRow,
  Project,
  NewThread,
  NewThreadMessage,
  NewProject,
  ThreadStatus,
  FileChange,
  ThreadExecutionEvent,
} from "../../types/threads.js";
import { logger } from "../../utils/logger.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  instance TEXT NOT NULL,
  repo_path TEXT,
  default_agent TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  project_id TEXT REFERENCES projects(id),
  instance TEXT NOT NULL,
  agent TEXT,
  status TEXT NOT NULL DEFAULT 'created',
  message TEXT NOT NULL,
  response TEXT,
  message_id TEXT,
  trace_id TEXT,
  cost_cents REAL DEFAULT 0,
  total_tokens INTEGER DEFAULT 0,
  duration_ms INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  archived INTEGER DEFAULT 0,
  branch TEXT,
  base_branch TEXT,
  worktree_path TEXT,
  commit_hash TEXT,
  pr_url TEXT,
  category TEXT,
  metadata TEXT
);

CREATE TABLE IF NOT EXISTS thread_messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  agent TEXT,
  message_id TEXT,
  trace_id TEXT,
  cost_cents REAL DEFAULT 0,
  tokens INTEGER DEFAULT 0,
  timestamp INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS thread_file_changes (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  message_id TEXT,
  file_path TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('write', 'edit', 'create', 'delete')),
  lines_added INTEGER DEFAULT 0,
  lines_removed INTEGER DEFAULT 0,
  diff_summary TEXT,
  timestamp INTEGER NOT NULL,
  FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS thread_execution_events (
  thread_id TEXT NOT NULL,
  id TEXT NOT NULL,
  message_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('command', 'file_change', 'mcp_tool', 'web_search', 'status')),
  phase TEXT NOT NULL CHECK (phase IN ('started', 'updated', 'completed', 'failed')),
  turn INTEGER,
  title TEXT NOT NULL,
  subtitle TEXT,
  details TEXT,
  command TEXT,
  output_preview TEXT,
  exit_code INTEGER,
  changes_json TEXT,
  timestamp INTEGER NOT NULL,
  PRIMARY KEY (thread_id, id),
  FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_threads_project ON threads(project_id);
CREATE INDEX IF NOT EXISTS idx_threads_status ON threads(status);
CREATE INDEX IF NOT EXISTS idx_threads_created ON threads(created_at);
CREATE INDEX IF NOT EXISTS idx_thread_messages_thread ON thread_messages(thread_id);
CREATE INDEX IF NOT EXISTS idx_tfc_thread ON thread_file_changes(thread_id);
CREATE INDEX IF NOT EXISTS idx_tee_thread ON thread_execution_events(thread_id);

CREATE VIRTUAL TABLE IF NOT EXISTS threads_fts USING fts5(
  title, content, thread_id UNINDEXED
);
`;

/**
 * Generate a title from the first ~60 chars of the message, trimmed to last word boundary.
 */
function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function trimInstructionBody(value: string): string {
  return value
    .split(/\n\s*\n/)[0]
    .split(/(?:Read first:|What to build|Requirements:|Verification required|When you finish)/i)[0]
    .trim();
}

function extractTaggedSection(message: string, tag: "Goal" | "Mission"): string | null {
  const match = message.match(new RegExp(`${tag}:\\s*([\\s\\S]+)$`, "i"));
  if (!match) return null;
  const body = trimInstructionBody(match[1]);
  return body ? compactWhitespace(body) : null;
}

function fileLabel(pathLike: string): string {
  return pathLike.replace(/^.*\//, "");
}

function readablePromptTitle(source: string): string | null {
  const text = compactWhitespace(source);
  if (!text) return null;

  if (/phase 1 of the web cockpit/i.test(text)) return "Gateway cockpit phase 1";
  if (/direct-owner cockpit/i.test(text)) return "Direct-owner cockpit build";
  if (/repo is out of sync/i.test(text)) return "Repo sync patch";

  let match = text.match(/^reply only with the current contents of\s+([^\s]+)\b/i);
  if (match) return `File contents check: ${fileLabel(match[1])}`;

  match = text.match(/^reply only (?:with )?yes or no:\s*(.+)$/i);
  if (match) {
    const question = match[1];
    const fileMatch = question.match(/([A-Za-z0-9_./-]+\.[A-Za-z0-9_]+)\b/);
    if (/does .* exist/i.test(question) || /exist in your repo/i.test(question)) {
      return fileMatch ? `File existence check: ${fileLabel(fileMatch[1])}` : "File existence check";
    }
    return "Yes/no verification";
  }

  match = text.match(/^reply with exactly:\s*(.+)$/i);
  if (match) {
    const expected = compactWhitespace(match[1]).replace(/^["']|["']$/g, "");
    if (/^(alive|nyx-ok|ok|pong)$/i.test(expected)) return "Ping check";
    return `Exact reply check: ${expected.slice(0, 24)}`;
  }

  if (/^in your .* repo, reply with only:/i.test(text)) return "Repo state check";
  if (/^run `?pwd`?/i.test(text)) return "Path check";

  const cleaned = text
    .replace(/^work in\s+\S+\.\s*/i, "")
    .replace(/^(goal|mission):\s*/i, "")
    .replace(/^implement\s+/i, "")
    .replace(/^start\s+/i, "")
    .replace(/^build\s+/i, "");

  return compactWhitespace(cleaned);
}

export function generateTitle(message: string): string {
  const normalized = message.replace(/\r/g, "").trim();
  const goal = extractTaggedSection(normalized, "Goal");
  const mission = extractTaggedSection(normalized, "Mission");
  const candidate = readablePromptTitle(goal ?? "")
    ?? readablePromptTitle(mission ?? "")
    ?? readablePromptTitle(normalized)
    ?? goal
    ?? mission
    ?? normalized;
  const trimmed = compactWhitespace(candidate).slice(0, 60).trim();
  if (trimmed.length < compactWhitespace(candidate).length) {
    const lastSpace = trimmed.lastIndexOf(" ");
    if (lastSpace > 24) return trimmed.slice(0, lastSpace);
  }
  return trimmed || "New Thread";
}

/** Convert a ThreadRow (SQLite integers) to a Thread (JS booleans + parsed JSON) */
function rowToThread(row: ThreadRow): Thread {
  let metadata: Record<string, unknown> | null = null;
  if (row.metadata) {
    try { metadata = JSON.parse(row.metadata); } catch { /* invalid JSON — ignore */ }
  }
  return {
    ...row,
    archived: row.archived === 1,
    branch: row.branch ?? null,
    base_branch: row.base_branch ?? null,
    worktree_path: row.worktree_path ?? null,
    commit_hash: row.commit_hash ?? null,
    pr_url: row.pr_url ?? null,
    category: row.category ?? null,
    metadata,
  };
}

export class ThreadDB {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec(SCHEMA);
    this.ensureCascadeDelete("thread_file_changes");
    this.ensureCascadeDelete("thread_execution_events");
    try { this.db.exec("ALTER TABLE thread_execution_events ADD COLUMN turn INTEGER"); } catch { /* already exists */ }
    // Migration: add category column if missing
    try { this.db.exec("ALTER TABLE threads ADD COLUMN category TEXT"); } catch { /* already exists */ }
    logger.info("[threads] ThreadDB ready");
  }

  private ensureCascadeDelete(tableName: "thread_file_changes" | "thread_execution_events"): void {
    const foreignKeys = this.db.query(`PRAGMA foreign_key_list(${tableName})`).all() as Array<{ on_delete?: string }>;
    const hasCascade = foreignKeys.some((fk) => String(fk.on_delete ?? "").toUpperCase() === "CASCADE");
    if (hasCascade) return;

    const tempTable = `${tableName}__cascade_tmp`;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (tableName === "thread_file_changes") {
        this.db.exec(`
CREATE TABLE ${tempTable} (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  message_id TEXT,
  file_path TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('write', 'edit', 'create', 'delete')),
  lines_added INTEGER DEFAULT 0,
  lines_removed INTEGER DEFAULT 0,
  diff_summary TEXT,
  timestamp INTEGER NOT NULL,
  FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
)
        `);
        this.db.exec(`
INSERT INTO ${tempTable} (id, thread_id, message_id, file_path, operation, lines_added, lines_removed, diff_summary, timestamp)
SELECT id, thread_id, message_id, file_path, operation, lines_added, lines_removed, diff_summary, timestamp
FROM thread_file_changes
        `);
      } else {
        this.db.exec(`
CREATE TABLE ${tempTable} (
  thread_id TEXT NOT NULL,
  id TEXT NOT NULL,
  message_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('command', 'file_change', 'mcp_tool', 'web_search', 'status')),
  phase TEXT NOT NULL CHECK (phase IN ('started', 'updated', 'completed', 'failed')),
  turn INTEGER,
  title TEXT NOT NULL,
  subtitle TEXT,
  details TEXT,
  command TEXT,
  output_preview TEXT,
  exit_code INTEGER,
  changes_json TEXT,
  timestamp INTEGER NOT NULL,
  PRIMARY KEY (thread_id, id),
  FOREIGN KEY (thread_id) REFERENCES threads(id) ON DELETE CASCADE
)
        `);
        this.db.exec(`
INSERT INTO ${tempTable} (thread_id, id, message_id, kind, phase, turn, title, subtitle, details, command, output_preview, exit_code, changes_json, timestamp)
SELECT thread_id, id, message_id, kind, phase, turn, title, subtitle, details, command, output_preview, exit_code, changes_json, timestamp
FROM thread_execution_events
        `);
      }

      this.db.exec(`DROP TABLE ${tableName}`);
      this.db.exec(`ALTER TABLE ${tempTable} RENAME TO ${tableName}`);
      if (tableName === "thread_file_changes") {
        this.db.exec("CREATE INDEX IF NOT EXISTS idx_tfc_thread ON thread_file_changes(thread_id)");
      } else {
        this.db.exec("CREATE INDEX IF NOT EXISTS idx_tee_thread ON thread_execution_events(thread_id)");
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  // --- Projects ---

  createProject(project: NewProject): Project {
    const id = randomUUID();
    const now = Date.now();
    this.db.run(
      `INSERT INTO projects (id, name, instance, repo_path, default_agent, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, project.name, project.instance, project.repo_path ?? null, project.default_agent ?? null, now, now],
    );
    return this.getProject(id)!;
  }

  getProject(id: string): Project | null {
    return this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as Project | null;
  }

  listProjects(): (Project & { thread_count: number; running_count: number })[] {
    return this.db
      .prepare(
        `SELECT p.*,
           (SELECT COUNT(*) FROM threads WHERE project_id = p.id) as thread_count,
           (SELECT COUNT(*) FROM threads WHERE project_id = p.id AND status IN ('queued', 'processing')) as running_count
         FROM projects p
         ORDER BY p.updated_at DESC`,
      )
      .all() as (Project & { thread_count: number; running_count: number })[];
  }

  updateProject(id: string, updates: Partial<Pick<Project, "name" | "instance" | "repo_path" | "default_agent">>): Project | null {
    const project = this.getProject(id);
    if (!project) return null;

    const now = Date.now();
    const name = updates.name ?? project.name;
    const instance = updates.instance ?? project.instance;
    const repoPath = updates.repo_path !== undefined ? updates.repo_path : project.repo_path;
    const defaultAgent = updates.default_agent !== undefined ? updates.default_agent : project.default_agent;

    this.db.run(
      "UPDATE projects SET name = ?, instance = ?, repo_path = ?, default_agent = ?, updated_at = ? WHERE id = ?",
      [name, instance, repoPath, defaultAgent, now, id],
    );
    return this.getProject(id);
  }

  deleteProject(id: string): boolean {
    const threadCount = this.db.prepare("SELECT COUNT(*) as count FROM threads WHERE project_id = ?").get(id) as { count: number };
    if (threadCount.count > 0) {
      return false; // Can't delete project with threads
    }
    const result = this.db.run("DELETE FROM projects WHERE id = ?", [id]);
    return result.changes > 0;
  }

  // --- Threads ---

  createThread(thread: NewThread): Thread {
    const id = randomUUID();
    const now = Date.now();
    const title = thread.title || generateTitle(thread.message);
    const status: ThreadStatus = "created";
    const metadataStr = thread.metadata ? JSON.stringify(thread.metadata) : null;

    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.run(
        `INSERT INTO threads (id, title, project_id, instance, agent, status, message, metadata, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, title, thread.project_id ?? null, thread.instance, thread.agent ?? null, status, thread.message, metadataStr, now, now],
      );

      // Insert initial user message
      const msgId = randomUUID();
      this.db.run(
        `INSERT INTO thread_messages (id, thread_id, role, content, timestamp)
         VALUES (?, ?, 'user', ?, ?)`,
        [msgId, id, thread.message, now],
      );

      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }

    this.indexThreadForSearch(id, title, thread.message);

    return this.getThread(id)!;
  }

  getThread(id: string): Thread | null {
    const row = this.db.prepare("SELECT * FROM threads WHERE id = ?").get(id) as ThreadRow | null;
    if (!row) return null;

    const messages = this.getThreadMessages(id);
    return { ...rowToThread(row), messages };
  }

  /**
   * Create a session (a thread variant with no initial message and category='session').
   * Used by the sessions API for multi-turn CLI chat.
   */
  createSession(opts: {
    id?: string;
    title?: string;
    agent?: string;
    instance: string;
    metadata?: Record<string, unknown>;
  }): Thread {
    const id = opts.id ?? randomUUID();
    const now = Date.now();
    const title = opts.title ?? "New Session";
    const metadataStr = opts.metadata ? JSON.stringify(opts.metadata) : null;

    this.db.run(
      `INSERT INTO threads (id, title, project_id, instance, agent, status, message, category, metadata, created_at, updated_at)
       VALUES (?, ?, NULL, ?, ?, 'created', '', 'session', ?, ?, ?)`,
      [id, title, opts.instance, opts.agent ?? null, metadataStr, now, now],
    );

    this.indexThreadForSearch(id, title, title);

    return this.getThread(id)!;
  }

  listThreads(filters: {
    project_id?: string;
    status?: string;
    agent?: string;
    archived?: boolean;
    category?: string;
    limit?: number;
    offset?: number;
  } = {}): { threads: Thread[]; total: number } {
    const conditions: string[] = [];
    const params: (string | number)[] = [];

    if (filters.project_id) {
      conditions.push("project_id = ?");
      params.push(filters.project_id);
    }
    if (filters.status) {
      const statuses = filters.status.split(",").map((s) => s.trim());
      conditions.push(`status IN (${statuses.map(() => "?").join(",")})`);
      params.push(...statuses);
    }
    if (filters.agent) {
      conditions.push("agent = ?");
      params.push(filters.agent);
    }
    if (filters.category !== undefined) {
      conditions.push("category = ?");
      params.push(filters.category);
    }
    // Default: hide archived
    const showArchived = filters.archived ?? false;
    if (!showArchived) {
      conditions.push("archived = 0");
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = Math.min(filters.limit ?? 50, 200);
    const offset = filters.offset ?? 0;

    const totalRow = this.db
      .prepare(`SELECT COUNT(*) as count FROM threads ${where}`)
      .get(...params) as { count: number };

    const rows = this.db
      .prepare(`SELECT *, (SELECT COUNT(*) FROM thread_messages WHERE thread_id = threads.id) as message_count FROM threads ${where} ORDER BY updated_at DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset) as (ThreadRow & { message_count: number })[];

    return {
      threads: rows.map((r) => ({ ...rowToThread(r), _message_count: r.message_count })),
      total: totalRow.count,
    };
  }

  updateThread(
    id: string,
    updates: Partial<Pick<Thread, "title" | "project_id" | "status" | "response" | "message_id" | "trace_id" | "cost_cents" | "total_tokens" | "duration_ms" | "completed_at" | "archived" | "branch" | "base_branch" | "worktree_path" | "commit_hash" | "pr_url" | "category" | "metadata">>,
  ): Thread | null {
    const thread = this.db.prepare("SELECT * FROM threads WHERE id = ?").get(id) as ThreadRow | null;
    if (!thread) return null;

    const now = Date.now();
    const fields: string[] = ["updated_at = ?"];
    const values: (string | number | null)[] = [now];

    if (updates.title !== undefined) { fields.push("title = ?"); values.push(updates.title); }
    if (updates.project_id !== undefined) { fields.push("project_id = ?"); values.push(updates.project_id); }
    if (updates.status !== undefined) { fields.push("status = ?"); values.push(updates.status); }
    if (updates.response !== undefined) { fields.push("response = ?"); values.push(updates.response); }
    if (updates.message_id !== undefined) { fields.push("message_id = ?"); values.push(updates.message_id); }
    if (updates.trace_id !== undefined) { fields.push("trace_id = ?"); values.push(updates.trace_id); }
    if (updates.cost_cents !== undefined) { fields.push("cost_cents = ?"); values.push(updates.cost_cents); }
    if (updates.total_tokens !== undefined) { fields.push("total_tokens = ?"); values.push(updates.total_tokens); }
    if (updates.duration_ms !== undefined) { fields.push("duration_ms = ?"); values.push(updates.duration_ms); }
    if (updates.completed_at !== undefined) { fields.push("completed_at = ?"); values.push(updates.completed_at); }
    if (updates.archived !== undefined) { fields.push("archived = ?"); values.push(updates.archived ? 1 : 0); }
    if (updates.branch !== undefined) { fields.push("branch = ?"); values.push(updates.branch); }
    if (updates.base_branch !== undefined) { fields.push("base_branch = ?"); values.push(updates.base_branch); }
    if (updates.worktree_path !== undefined) { fields.push("worktree_path = ?"); values.push(updates.worktree_path); }
    if (updates.commit_hash !== undefined) { fields.push("commit_hash = ?"); values.push(updates.commit_hash); }
    if (updates.pr_url !== undefined) { fields.push("pr_url = ?"); values.push(updates.pr_url); }
    if (updates.category !== undefined) { fields.push("category = ?"); values.push(updates.category); }
    if (updates.metadata !== undefined) { fields.push("metadata = ?"); values.push(updates.metadata ? JSON.stringify(updates.metadata) : null); }

    this.db.run(
      `UPDATE threads SET ${fields.join(", ")} WHERE id = ?`,
      [...values, id],
    );

    // Re-index for search if title or response changed
    if (updates.title !== undefined || updates.response !== undefined) {
      const updated = this.db.prepare("SELECT * FROM threads WHERE id = ?").get(id) as ThreadRow | null;
      if (updated) {
        this.indexThreadForSearch(id, updated.title, updated.response ?? updated.message);
      }
    }

    return this.getThread(id);
  }

  archiveThread(id: string): Thread | null {
    return this.updateThread(id, { archived: true });
  }

  deleteThread(id: string): boolean {
    const result = this.db.run("DELETE FROM threads WHERE id = ?", [id]);
    return result.changes > 0;
  }

  // --- Thread Messages ---

  addThreadMessage(threadId: string, message: NewThreadMessage): ThreadMessage {
    const id = randomUUID();
    const now = Date.now();
    this.db.run(
      `INSERT INTO thread_messages (id, thread_id, role, content, agent, message_id, trace_id, cost_cents, tokens, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        threadId,
        message.role,
        message.content,
        message.agent ?? null,
        message.message_id ?? null,
        message.trace_id ?? null,
        message.cost_cents ?? 0,
        message.tokens ?? 0,
        now,
      ],
    );
    this.db.run("UPDATE threads SET updated_at = ? WHERE id = ?", [now, threadId]);

    // Index message content for full-text search
    const thread = this.db.prepare("SELECT title, message FROM threads WHERE id = ?").get(threadId) as { title: string; message: string } | null;
    if (thread) {
      this.indexThreadForSearch(threadId, thread.title, message.content);
    }

    return this.db.prepare("SELECT * FROM thread_messages WHERE id = ?").get(id) as ThreadMessage;
  }

  getThreadMessageByMessageId(threadId: string, messageId: string): ThreadMessage | null {
    return this.db
      .prepare("SELECT * FROM thread_messages WHERE thread_id = ? AND message_id = ? LIMIT 1")
      .get(threadId, messageId) as ThreadMessage | null;
  }

  countThreadMessages(threadId: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as count FROM thread_messages WHERE thread_id = ?")
      .get(threadId) as { count: number };
    return row.count;
  }

  /** Update the content of an existing thread message (used for partial streaming saves) */
  updateThreadMessage(messageId: string, content: string, extra?: { tokens?: number; cost_cents?: number }): void {
    if (extra?.tokens !== undefined || extra?.cost_cents !== undefined) {
      const fields = ["content = ?"];
      const values: (string | number)[] = [content];
      if (extra.tokens !== undefined) { fields.push("tokens = ?"); values.push(extra.tokens); }
      if (extra.cost_cents !== undefined) { fields.push("cost_cents = ?"); values.push(extra.cost_cents); }
      values.push(messageId);
      this.db.run(`UPDATE thread_messages SET ${fields.join(", ")} WHERE id = ?`, values);
    } else {
      this.db.run("UPDATE thread_messages SET content = ? WHERE id = ?", [content, messageId]);
    }
  }

  /**
   * Remove the last exchange (last assistant message + the user message before it).
   * Returns the number of messages deleted (0, 1, or 2).
   */
  undoLastExchange(threadId: string): number {
    const thread = this.db
      .prepare("SELECT id FROM threads WHERE id = ?")
      .get(threadId) as { id: string } | null;
    if (!thread) return 0;

    // Get last 2 messages ordered newest-first
    const rows = this.db
      .prepare("SELECT id, role, cost_cents FROM thread_messages WHERE thread_id = ? ORDER BY timestamp DESC, rowid DESC LIMIT 2")
      .all(threadId) as { id: string; role: string; cost_cents: number }[];

    if (rows.length === 0) return 0;

    // Always remove the topmost message (could be assistant or user)
    const toDelete = [rows[0]!.id];
    // If that was assistant and the next is user, remove both
    if (rows[0]!.role === "assistant" && rows[1]?.role === "user") {
      toDelete.push(rows[1].id);
    }

    for (const id of toDelete) {
      this.db.run("DELETE FROM thread_messages WHERE id = ?", [id]);
    }

    const costRow = this.db
      .prepare("SELECT COALESCE(SUM(cost_cents), 0) as total FROM thread_messages WHERE thread_id = ? AND role = 'assistant'")
      .get(threadId) as { total: number };
    const now = Date.now();
    this.db.run(
      "UPDATE threads SET cost_cents = ?, updated_at = ? WHERE id = ?",
      [costRow.total, now, threadId],
    );

    return toDelete.length;
  }

  getThreadMessages(threadId: string, limit?: number): ThreadMessage[] {
    if (limit) {
      // Fetch last N messages (DESC + LIMIT), then reverse to chronological order
      const rows = this.db
        .prepare("SELECT * FROM thread_messages WHERE thread_id = ? ORDER BY timestamp DESC, rowid DESC LIMIT ?")
        .all(threadId, limit) as ThreadMessage[];
      return rows.reverse();
    }
    return this.db
      .prepare("SELECT * FROM thread_messages WHERE thread_id = ? ORDER BY timestamp ASC, rowid ASC")
      .all(threadId) as ThreadMessage[];
  }

  // --- File Changes ---

  recordFileChange(change: {
    id: string;
    threadId: string;
    messageId?: string;
    filePath: string;
    operation: 'write' | 'edit' | 'create' | 'delete';
    linesAdded?: number;
    linesRemoved?: number;
    diffSummary?: string;
  }): void {
    this.db.run(
      `INSERT INTO thread_file_changes (id, thread_id, message_id, file_path, operation, lines_added, lines_removed, diff_summary, timestamp)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [change.id, change.threadId, change.messageId ?? null, change.filePath, change.operation,
       change.linesAdded ?? 0, change.linesRemoved ?? 0, change.diffSummary ?? null, Date.now()],
    );
  }

  getFileChanges(threadId: string): FileChange[] {
    return this.db.query(
      `SELECT id, thread_id as threadId, message_id as messageId, file_path as filePath,
              operation, lines_added as linesAdded, lines_removed as linesRemoved,
              diff_summary as diffSummary, timestamp
       FROM thread_file_changes WHERE thread_id = ? ORDER BY timestamp`,
    ).all(threadId) as FileChange[];
  }

  // --- Execution Events ---

  recordExecutionEvent(event: {
    threadId: string;
    id: string;
    messageId?: string;
    kind: ThreadExecutionEvent["kind"];
    phase: ThreadExecutionEvent["phase"];
    turn?: number;
    title: string;
    subtitle?: string;
    details?: string;
    command?: string;
    outputPreview?: string;
    exitCode?: number | null;
    changes?: ThreadExecutionEvent["changes"];
    timestamp?: number;
  }): void {
    const existing = this.db.prepare(
      "SELECT timestamp FROM thread_execution_events WHERE thread_id = ? AND id = ?",
    ).get(event.threadId, event.id) as { timestamp: number } | null;
    const timestamp = existing?.timestamp ?? event.timestamp ?? Date.now();
    const changesJson = event.changes ? JSON.stringify(event.changes) : null;

    this.db.run(
      `INSERT INTO thread_execution_events (
        thread_id, id, message_id, kind, phase, turn, title, subtitle, details, command, output_preview, exit_code, changes_json, timestamp
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(thread_id, id) DO UPDATE SET
        message_id = excluded.message_id,
        kind = excluded.kind,
        phase = excluded.phase,
        turn = excluded.turn,
        title = excluded.title,
        subtitle = excluded.subtitle,
        details = excluded.details,
        command = excluded.command,
        output_preview = excluded.output_preview,
        exit_code = excluded.exit_code,
        changes_json = excluded.changes_json`,
      [
        event.threadId,
        event.id,
        event.messageId ?? null,
        event.kind,
        event.phase,
        event.turn ?? null,
        event.title,
        event.subtitle ?? null,
        event.details ?? null,
        event.command ?? null,
        event.outputPreview ?? null,
        event.exitCode ?? null,
        changesJson,
        timestamp,
      ],
    );
  }

  getExecutionEvents(threadId: string, limit?: number): ThreadExecutionEvent[] {
    const rows = limit
      ? this.db
        .prepare(
          `SELECT thread_id as threadId, id, message_id as messageId, kind, phase, title, subtitle, details,
                  turn, command, output_preview as outputPreview, exit_code as exitCode, changes_json as changesJson, timestamp
           FROM thread_execution_events
           WHERE thread_id = ?
           ORDER BY timestamp DESC
           LIMIT ?`,
        )
        .all(threadId, limit)
      : this.db
        .prepare(
          `SELECT thread_id as threadId, id, message_id as messageId, kind, phase, title, subtitle, details,
                  turn, command, output_preview as outputPreview, exit_code as exitCode, changes_json as changesJson, timestamp
           FROM thread_execution_events
           WHERE thread_id = ?
           ORDER BY timestamp ASC`,
        )
        .all(threadId);

    const normalized = rows as Array<ThreadExecutionEvent & { changesJson?: string | null }>;
    const events = normalized.map((row) => {
      let changes: ThreadExecutionEvent["changes"];
      if (row.changesJson) {
        try {
          changes = JSON.parse(row.changesJson) as ThreadExecutionEvent["changes"];
        } catch {
          changes = undefined;
        }
      }
      return {
        id: row.id,
        threadId: row.threadId,
        messageId: row.messageId ?? undefined,
        kind: row.kind,
        phase: row.phase,
        turn: typeof row.turn === "number" ? row.turn : undefined,
        title: row.title,
        subtitle: row.subtitle ?? undefined,
        details: row.details ?? undefined,
        command: row.command ?? undefined,
        outputPreview: row.outputPreview ?? undefined,
        exitCode: row.exitCode ?? null,
        changes,
        timestamp: row.timestamp,
      };
    });

    return limit ? events.reverse() : events;
  }

  // --- Full-Text Search ---

  searchThreads(query: string, limit = 20): Array<Thread & { snippet: string; lastActivity: number; _message_count: number }> {
    if (!query.trim()) return [];
    // Escape FTS5 special chars and add prefix matching
    const escaped = query.replace(/['"*()]/g, '').trim();
    if (!escaped) return [];
    const ftsQuery = escaped.split(/\s+/).map(w => `"${w}"*`).join(' ');
    try {
      return this.db.query(
        `SELECT DISTINCT t.*,
                snippet(threads_fts, 1, '**', '**', '...', 32) as snippet,
                t.updated_at as lastActivity,
                (SELECT COUNT(*) FROM thread_messages WHERE thread_id = t.id) as _message_count
         FROM threads_fts f
         JOIN threads t ON t.id = f.thread_id
         WHERE threads_fts MATCH ?
           AND t.archived = 0
         ORDER BY rank
         LIMIT ?`
      ).all(ftsQuery, limit).map((row) => ({
        ...rowToThread(row as ThreadRow),
        snippet: (row as { snippet?: string }).snippet ?? "",
        lastActivity: (row as { lastActivity?: number }).lastActivity ?? Date.now(),
        _message_count: (row as { _message_count?: number })._message_count ?? 0,
      }));
    } catch {
      return [];
    }
  }

  indexThreadForSearch(threadId: string, title: string, content: string): void {
    this.db.run("DELETE FROM threads_fts WHERE thread_id = ?", [threadId]);
    this.db.run(
      "INSERT INTO threads_fts (thread_id, title, content) VALUES (?, ?, ?)",
      [threadId, title, content],
    );
  }

  /** Get the underlying database for sharing with other modules */
  getDb(): Database {
    return this.db;
  }

  close(): void {
    this.db.close();
  }
}

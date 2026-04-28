/**
 * Tests that stale SQLite schemas are detected and handled gracefully.
 *
 * Fresh in-memory DBs never catch schema drift — these tests pre-create
 * tables with old/wrong columns, then verify each module's init recovers.
 *
 * See: commit 24a1550 (scheduler fix), LEARNINGS.md "SQLite schema migration"
 */

import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { QueueDB } from "../queue/db.js";
import { PairingStore } from "../pairing/pairing.js";
import { MemoryStore } from "../memory/store.js";
import { GraphMemory } from "../memory/graph.js";
import { KnowledgeStore } from "../memory/knowledge.js";

function getColumnNames(db: Database, table: string): string[] {
  const cols = db.query(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return cols.map(c => c.name);
}

// ─── Queue (ephemeral — DROP+recreate) ───

describe("Schema migration: QueueDB", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nyxhive-schema-queue-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("recreates stale messages table with missing columns", () => {
    // Pre-create with old schema (missing from_agent, claimed_by, etc.)
    const db = new Database(join(tmpDir, "nyxhive.db"));
    db.exec(`CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL UNIQUE,
      channel TEXT NOT NULL,
      sender TEXT NOT NULL,
      message TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at INTEGER NOT NULL
    )`);
    db.close();

    const queue = new QueueDB(tmpDir);
    const cols = getColumnNames(
      new Database(join(tmpDir, "nyxhive.db")),
      "messages",
    );

    expect(cols).toContain("from_agent");
    expect(cols).toContain("claimed_by");
    expect(cols).toContain("retry_count");
    expect(cols).toContain("updated_at");
    expect(cols).toContain("conversation_id");

    queue.close();
  });

  test("recreates stale responses table with missing columns", () => {
    const db = new Database(join(tmpDir, "nyxhive.db"));
    db.exec(`CREATE TABLE responses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`);
    db.close();

    const queue = new QueueDB(tmpDir);
    const cols = getColumnNames(
      new Database(join(tmpDir, "nyxhive.db")),
      "responses",
    );

    expect(cols).toContain("original_message");
    expect(cols).toContain("acked_at");
    expect(cols).toContain("sender");

    queue.close();
  });

  test("leaves correct schema untouched", () => {
    // First init creates correct schema
    const queue1 = new QueueDB(tmpDir);
    queue1.enqueueMessage({ channel: "test", sender: "user", message: "hello" });
    queue1.close();

    // Second init should not drop the table (data survives)
    const queue2 = new QueueDB(tmpDir);
    expect(queue2.getPendingCount()).toBe(1);
    queue2.close();
  });

  describe("resetOrphans", () => {
    test("resets processing messages to pending", () => {
      // Create a fresh QueueDB (constructor calls resetOrphans, but it's empty)
      const q = new QueueDB(tmpDir, "test-orphan");

      // Enqueue and claim a message to get it into 'processing'
      q.enqueueMessage({ channel: "test", sender: "user", message: "orphan1" });
      const claimed = q.claimMessage("nyx");
      expect(claimed).toBeTruthy();

      // Manually call resetOrphans (simulating what constructor does on restart)
      const reset = q.resetOrphans();
      expect(reset).toBe(1);

      // Verify it's back to pending
      expect(q.getPendingCount()).toBe(1);

      q.close();
    });

    test("does not affect pending or completed messages", () => {
      const q = new QueueDB(tmpDir, "test-orphan2");

      // One pending, one completed
      q.enqueueMessage({ channel: "test", sender: "user", message: "pending-msg" });
      q.enqueueMessage({ channel: "test", sender: "user", message: "done-msg" });
      const claimed = q.claimMessage("nyx");
      if (claimed) q.completeMessage(claimed.message_id);

      const reset = q.resetOrphans();
      expect(reset).toBe(0);

      q.close();
    });
  });
});

// ─── Pairing (ephemeral — DROP+recreate) ───

describe("Schema migration: PairingStore", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nyxhive-schema-pairing-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("recreates stale pairing_pending table", () => {
    const db = new Database(join(tmpDir, "nyxhive.db"));
    db.exec(`CREATE TABLE pairing_pending (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel TEXT NOT NULL,
      sender_id TEXT NOT NULL
    )`);
    db.close();

    const store = new PairingStore(tmpDir);
    const cols = getColumnNames(
      new Database(join(tmpDir, "nyxhive.db")),
      "pairing_pending",
    );

    expect(cols).toContain("sender");
    expect(cols).toContain("code");
    expect(cols).toContain("created_at");
  });

  test("recreates stale pairing_approved table", () => {
    const db = new Database(join(tmpDir, "nyxhive.db"));
    db.exec(`CREATE TABLE pairing_approved (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel TEXT NOT NULL,
      sender_id TEXT NOT NULL
    )`);
    db.close();

    const store = new PairingStore(tmpDir);
    const cols = getColumnNames(
      new Database(join(tmpDir, "nyxhive.db")),
      "pairing_approved",
    );

    expect(cols).toContain("sender");
    expect(cols).toContain("approved_at");
  });

  test("leaves correct schema untouched", () => {
    const store1 = new PairingStore(tmpDir);
    const code = store1.generateCode("telegram", "123", "User");
    store1.approve(code);

    const store2 = new PairingStore(tmpDir);
    expect(store2.isApproved("telegram", "123")).toBe(true);
  });
});

// ─── Memory Store (persistent — ALTER TABLE ADD COLUMN) ───

describe("Schema migration: MemoryStore", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nyxhive-schema-memory-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("adds missing columns to conversations table, preserving data", () => {
    // Pre-create with old schema missing channel_id and updated_at
    const db = new Database(join(tmpDir, "memory.db"));
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(`CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )`);
    db.exec("INSERT INTO conversations (id, channel, created_at) VALUES ('c1', 'telegram', 1000)");
    db.close();

    const store = new MemoryStore(tmpDir);
    const storeDb = store.getDb();

    const cols = getColumnNames(storeDb, "conversations");
    expect(cols).toContain("channel_id");
    expect(cols).toContain("updated_at");

    // Verify existing data survived
    const row = storeDb.query("SELECT * FROM conversations WHERE id = 'c1'").get() as any;
    expect(row.channel).toBe("telegram");
    expect(row.created_at).toBe(1000);

    store.close();
  });

  test("adds missing columns to execution_traces table", () => {
    const db = new Database(join(tmpDir, "memory.db"));
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    // Old schema: only id, channel, sender, input_message, status, created_at
    db.exec(`CREATE TABLE execution_traces (
      id TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      sender TEXT NOT NULL,
      input_message TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      created_at INTEGER NOT NULL
    )`);
    db.exec("INSERT INTO execution_traces (id, channel, sender, input_message, created_at) VALUES ('t1', 'telegram', 'User', 'test', 1000)");
    db.close();

    const store = new MemoryStore(tmpDir);
    const storeDb = store.getDb();

    const cols = getColumnNames(storeDb, "execution_traces");
    expect(cols).toContain("origin_message_id");
    expect(cols).toContain("sender_id");
    expect(cols).toContain("total_tokens_in");
    expect(cols).toContain("agent_count");
    expect(cols).toContain("completed_at");

    // Existing data survived
    const row = storeDb.query("SELECT * FROM execution_traces WHERE id = 't1'").get() as any;
    expect(row.channel).toBe("telegram");
    expect(row.sender).toBe("User");

    store.close();
  });

  test("adds metadata_json to trace_events table", () => {
    const db = new Database(join(tmpDir, "memory.db"));
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(`CREATE TABLE trace_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trace_id TEXT NOT NULL,
      parent_event_id INTEGER,
      agent TEXT NOT NULL,
      task TEXT NOT NULL,
      response_excerpt TEXT,
      status TEXT NOT NULL DEFAULT 'running',
      error TEXT,
      tokens_in INTEGER DEFAULT 0,
      tokens_out INTEGER DEFAULT 0,
      cost REAL DEFAULT 0,
      duration_ms INTEGER DEFAULT 0,
      model TEXT,
      task_type TEXT,
      model_hint TEXT,
      billing_type TEXT,
      started_at INTEGER NOT NULL,
      completed_at INTEGER
    )`);
    db.close();

    const store = new MemoryStore(tmpDir);
    const cols = getColumnNames(store.getDb(), "trace_events");
    expect(cols).toContain("metadata_json");
    store.close();
  });

  test("adds importance_score to messages table, preserving rows", () => {
    const db = new Database(join(tmpDir, "memory.db"));
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec(`CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    db.exec(`CREATE TABLE messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      model TEXT,
      provider TEXT,
      tokens_in INTEGER DEFAULT 0,
      tokens_out INTEGER DEFAULT 0,
      cost_usd REAL DEFAULT 0,
      created_at INTEGER NOT NULL
    )`);
    db.exec("INSERT INTO conversations (id, channel, channel_id, created_at, updated_at) VALUES ('c1', 'api', 'sender', 1000, 1000)");
    db.exec("INSERT INTO messages (conversation_id, role, content, created_at) VALUES ('c1', 'user', 'hello', 1000)");
    db.close();

    const store = new MemoryStore(tmpDir);
    const storeDb = store.getDb();
    const cols = getColumnNames(storeDb, "messages");
    expect(cols).toContain("importance_score");

    const row = storeDb.query("SELECT content, importance_score FROM messages WHERE conversation_id = 'c1'").get() as any;
    expect(row.content).toBe("hello");
    expect(row.importance_score).toBeNull();

    store.close();
  });

  test("leaves correct schema untouched with data intact", () => {
    const store1 = new MemoryStore(tmpDir);
    store1.ensureConversation("conv-1", "telegram", "123");
    store1.saveMessage("conv-1", "user", "hello", null, null, 0, 0, 0);
    store1.close();

    const store2 = new MemoryStore(tmpDir);
    expect(store2.getMessageCount("conv-1")).toBe(1);
    store2.close();
  });
});

// ─── Graph Memory (persistent — ALTER TABLE ADD COLUMN) ───

describe("Schema migration: GraphMemory", () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nyxhive-schema-graph-"));
    dbPath = join(tmpDir, "graph.db");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("adds missing columns to memory_nodes table, preserving data", () => {
    // Pre-create with old schema missing expires_at, access_count
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE memory_nodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      content TEXT NOT NULL,
      importance REAL DEFAULT 0.5,
      created_at INTEGER NOT NULL,
      accessed_at INTEGER NOT NULL
    )`);
    db.exec("INSERT INTO memory_nodes (type, content, importance, created_at, accessed_at) VALUES ('fact', 'test memory', 0.8, 1000, 1000)");
    db.close();

    const db2 = new Database(dbPath);
    const graph = new GraphMemory(db2);

    const cols = getColumnNames(db2, "memory_nodes");
    expect(cols).toContain("source_conversation");
    expect(cols).toContain("source_channel");
    expect(cols).toContain("access_count");
    expect(cols).toContain("expires_at");

    // Existing data survived
    const node = db2.query("SELECT * FROM memory_nodes WHERE id = 1").get() as any;
    expect(node.type).toBe("fact");
    expect(node.content).toBe("test memory");
    expect(node.importance).toBe(0.8);

    db2.close();
  });

  test("adds missing columns to memory_edges table", () => {
    const db = new Database(dbPath);
    // Old schema: missing type column
    db.exec(`CREATE TABLE memory_edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id INTEGER NOT NULL,
      target_id INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    )`);
    db.close();

    const db2 = new Database(dbPath);
    const graph = new GraphMemory(db2);

    const cols = getColumnNames(db2, "memory_edges");
    expect(cols).toContain("type");

    db2.close();
  });

  test("leaves correct schema untouched", () => {
    const db = new Database(dbPath);
    const graph1 = new GraphMemory(db);
    const nodeId = graph1.addNode("fact", "persistent data");

    // Re-init should preserve data
    const graph2 = new GraphMemory(db);
    const node = graph2.getNode(nodeId);
    expect(node).not.toBeNull();
    expect(node!.content).toBe("persistent data");

    db.close();
  });
});

// ─── Knowledge Store (persistent — ALTER TABLE ADD COLUMN) ───

describe("Schema migration: KnowledgeStore", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nyxhive-schema-knowledge-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("adds missing columns to knowledge_chunks table, preserving data", () => {
    // Pre-create with old schema missing category, updated_at
    const db = new Database(join(tmpDir, "knowledge_knowledge.db"));
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(`CREATE TABLE knowledge_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      section TEXT,
      content TEXT NOT NULL,
      source_path TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      embedding BLOB NOT NULL,
      created_at INTEGER NOT NULL
    )`);
    // Insert a row with a dummy embedding
    const embedding = new Float32Array(3).fill(0.5);
    const blob = Buffer.from(embedding.buffer);
    db.exec(`INSERT INTO knowledge_chunks (title, section, content, source_path, content_hash, embedding, created_at)
             VALUES ('Test', 'intro', 'test content', '/test.md', 'abc123', x'${blob.toString("hex")}', 1000)`);
    db.close();

    const store = new KnowledgeStore(tmpDir);
    const storeDb = new Database(join(tmpDir, "knowledge_knowledge.db"));

    const cols = getColumnNames(storeDb, "knowledge_chunks");
    expect(cols).toContain("category");
    expect(cols).toContain("updated_at");
    const ftsRows = storeDb.query("SELECT COUNT(*) AS count FROM knowledge_chunks_fts").get() as { count: number };
    expect(ftsRows.count).toBe(1);

    // Existing data survived
    const row = storeDb.query("SELECT * FROM knowledge_chunks WHERE id = 1").get() as any;
    expect(row.title).toBe("Test");
    expect(row.content).toBe("test content");
    expect(row.source_path).toBe("/test.md");

    storeDb.close();
    store.close();
  });

  test("leaves correct schema untouched", () => {
    const store1 = new KnowledgeStore(tmpDir);
    const embedding = new Float32Array(1536).fill(0.1);
    store1.upsertChunk("Test", "intro", "content", "docs", "/test.md", "hash1", embedding);
    store1.close();

    const store2 = new KnowledgeStore(tmpDir);
    const stats = store2.getStats();
    expect(stats.totalChunks).toBe(1);
    store2.close();
  });
});

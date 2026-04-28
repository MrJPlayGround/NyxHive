import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { TraceStore } from "../memory/traces.js";

function setupDb(): Database {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE execution_traces (
      id TEXT PRIMARY KEY,
      origin_message_id TEXT,
      channel TEXT,
      sender TEXT,
      sender_id TEXT,
      input_message TEXT,
      final_response TEXT,
      status TEXT DEFAULT 'running',
      total_tokens_in INTEGER DEFAULT 0,
      total_tokens_out INTEGER DEFAULT 0,
      total_cost REAL DEFAULT 0,
      total_duration_ms INTEGER DEFAULT 0,
      agent_count INTEGER DEFAULT 0,
      created_at INTEGER,
      completed_at INTEGER
    );
    CREATE TABLE trace_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trace_id TEXT,
      parent_event_id INTEGER,
      agent TEXT,
      task TEXT,
      status TEXT DEFAULT 'running',
      response_excerpt TEXT,
      tokens_in INTEGER DEFAULT 0,
      tokens_out INTEGER DEFAULT 0,
      cost REAL DEFAULT 0,
      duration_ms INTEGER DEFAULT 0,
      model TEXT,
      task_type TEXT,
      model_hint TEXT,
      billing_type TEXT,
      metadata_json TEXT,
      error TEXT,
      started_at INTEGER,
      completed_at INTEGER
    );
    CREATE TABLE scheduled_run_artifacts (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      task_name TEXT NOT NULL,
      trace_id TEXT,
      question TEXT NOT NULL,
      decision TEXT NOT NULL,
      outcome TEXT NOT NULL,
      evidence_json TEXT NOT NULL,
      artifacts_json TEXT NOT NULL,
      notified INTEGER NOT NULL DEFAULT 0,
      suppression_reason TEXT,
      notification_signature TEXT,
      model_trust_tier TEXT,
      started_at INTEGER NOT NULL,
      completed_at INTEGER NOT NULL
    );
  `);
  return db;
}

describe("TraceStore.getTraceCost", () => {
  let db: Database;
  let store: TraceStore;

  beforeEach(() => {
    db = setupDb();
    store = new TraceStore(db);
  });

  test("returns 0 for trace with no events", () => {
    store.startTrace({ id: "t1", channel: "test", sender: "user", inputMessage: "hello" });
    expect(store.getTraceCost("t1")).toBe(0);
  });

  test("sums cost from completed events", () => {
    store.startTrace({ id: "t2", channel: "test", sender: "user", inputMessage: "hello" });
    const e1 = store.startEvent("t2", "forge", "task1");
    store.completeEvent(e1, { cost: 0.05, tokensIn: 100, tokensOut: 50 });
    const e2 = store.startEvent("t2", "tester", "task2");
    store.completeEvent(e2, { cost: 0.03, tokensIn: 80, tokensOut: 30 });
    const cost = store.getTraceCost("t2");
    expect(cost).toBeCloseTo(0.08, 4);
  });

  test("includes running events in cost", () => {
    store.startTrace({ id: "t3", channel: "test", sender: "user", inputMessage: "hello" });
    const e1 = store.startEvent("t3", "forge", "task1");
    store.completeEvent(e1, { cost: 0.10 });
    store.startEvent("t3", "tester", "task2");
    expect(store.getTraceCost("t3")).toBeCloseTo(0.10, 4);
  });

  test("returns 0 for non-existent trace", () => {
    expect(store.getTraceCost("nonexistent")).toBe(0);
  });

  test("completeEvent persists metadata_json", () => {
    store.startTrace({ id: "t-meta", channel: "test", sender: "User", inputMessage: "test" });
    const eventId = store.startEvent("t-meta", "nyx", "coding");

    store.completeEvent(eventId, {
      model: "gpt-5.5",
      taskType: "coding",
      metadata: {
        authority: {
          sandboxMode: "workspace-write",
          approvalPolicy: "never",
        },
      },
    });

    const row = db.query("SELECT metadata_json FROM trace_events WHERE id = ?").get(eventId) as { metadata_json: string };
    expect(JSON.parse(row.metadata_json)).toEqual({
      modelTrust: {
        tier: "tier_4_frontier",
        authorityRole: "authoritative",
      },
      authority: {
        sandboxMode: "workspace-write",
        approvalPolicy: "never",
      },
    });
  });

  test("completeEvent records draft-only trust metadata for cheap models", () => {
    store.startTrace({ id: "t-cheap", channel: "test", sender: "User", inputMessage: "summarize" });
    const eventId = store.startEvent("t-cheap", "analyst", "summary");

    store.completeEvent(eventId, {
      model: "qwen/qwen-turbo",
      taskType: "summarization",
      metadata: { source: "test" },
    });

    const row = db.query("SELECT metadata_json FROM trace_events WHERE id = ?").get(eventId) as { metadata_json: string };
    expect(JSON.parse(row.metadata_json)).toMatchObject({
      source: "test",
      modelTrust: {
        tier: "tier_1_draft",
        authorityRole: "draft_only",
      },
    });
  });

  test("records scheduled run artifacts linked to traces", () => {
    store.recordScheduledRunArtifact({
      taskId: "task-1",
      taskName: "heartbeat:presence",
      traceId: "trace-1",
      question: "Is there a real signal User needs to know?",
      decision: "quiet",
      outcome: "completed",
      evidence: { empty: true },
      artifacts: [{ kind: "trace", ref: "trace-1" }],
      notified: false,
      suppressionReason: "empty_result",
      notificationSignature: "abc123",
      modelTrustTier: "tier_1_draft",
      startedAt: 1000,
      completedAt: 2000,
    });

    const artifacts = store.getRecentScheduledRunArtifacts(5);
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({
      task_id: "task-1",
      task_name: "heartbeat:presence",
      trace_id: "trace-1",
      question: "Is there a real signal User needs to know?",
      decision: "quiet",
      outcome: "completed",
      notified: 0,
      suppression_reason: "empty_result",
      notification_signature: "abc123",
      model_trust_tier: "tier_1_draft",
    });
    expect(JSON.parse(artifacts[0].evidence_json)).toEqual({ empty: true });
    expect(JSON.parse(artifacts[0].artifacts_json)).toEqual([{ kind: "trace", ref: "trace-1" }]);
  });
});

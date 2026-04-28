import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { MemoryStore } from "../memory/store.js";
import { TraceStore } from "../memory/traces.js";

describe("model quality ledger", () => {
  let store: MemoryStore;
  let db: Database;
  let traces: TraceStore;

  beforeEach(() => {
    store = new MemoryStore(mkdtempSync(join(tmpdir(), "model-ledger-")));
    db = store.getDb();
    traces = new TraceStore(db);
  });

  afterEach(() => store.close());

  test("aggregates quality and cost per model", () => {
    traces.startTrace({ id: "t-ledger", channel: "api", sender: "User", inputMessage: "test" });
    const ok = traces.startEvent("t-ledger", "nyx", "implement");
    traces.completeEvent(ok, {
      model: "gpt-5.5",
      taskType: "coding",
      tokensIn: 1000,
      tokensOut: 500,
      cost: 0.02,
      durationMs: 12_000,
      metadata: { verification: { passed: true } },
    });
    const failed = traces.startEvent("t-ledger", "nyx", "empty");
    traces.failEvent(failed, "Codex SDK completed without an assistant response");
    db.prepare("UPDATE trace_events SET model = ?, task_type = ?, duration_ms = ? WHERE id = ?")
      .run("gpt-5.5", "coding", 3000, failed);

    const ledger = traces.getModelQualityLedger({ sinceMs: 0 });

    expect(ledger[0]).toMatchObject({
      model: "gpt-5.5",
      taskType: "coding",
      runs: 2,
      completed: 1,
      failed: 1,
      emptyRuns: 1,
      cost: 0.02,
      tokensIn: 1000,
      tokensOut: 500,
    });
  });
});

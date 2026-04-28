import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { parseActorMentions } from "../agents/actor.js";
import { resolveModelHint, getModelTier, MODEL_TIERS } from "../defaults.js";
import { TraceStore } from "../memory/traces.js";

const knownAgents = new Set(["forge", "analyst", "tester", "nyx"]);

// --- Model Hint Parsing ---

describe("parseActorMentions with model hints", () => {
  test("parses [@agent(hint): task] syntax", () => {
    const { mentions } = parseActorMentions(
      "[@forge(light): fix the typo in README]",
      knownAgents,
    );
    expect(mentions).toHaveLength(1);
    expect(mentions[0].agent).toBe("forge");
    expect(mentions[0].modelHint).toBe("light");
    expect(mentions[0].task).toBe("fix the typo in README");
  });

  test("parses sonnet hint", () => {
    const { mentions } = parseActorMentions(
      "[@forge(sonnet): implement the feature]",
      knownAgents,
    );
    expect(mentions).toHaveLength(1);
    expect(mentions[0].modelHint).toBe("sonnet");
  });

  test("parses opus hint", () => {
    const { mentions } = parseActorMentions(
      "[@forge(opus): complex architecture review]",
      knownAgents,
    );
    expect(mentions).toHaveLength(1);
    expect(mentions[0].modelHint).toBe("opus");
  });

  test("parses heavy hint", () => {
    const { mentions } = parseActorMentions(
      "[@analyst(heavy): deep analysis of cost patterns]",
      knownAgents,
    );
    expect(mentions).toHaveLength(1);
    expect(mentions[0].agent).toBe("analyst");
    expect(mentions[0].modelHint).toBe("heavy");
  });

  test("no hint when not provided", () => {
    const { mentions } = parseActorMentions(
      "[@forge: regular task]",
      knownAgents,
    );
    expect(mentions).toHaveLength(1);
    expect(mentions[0].modelHint).toBeUndefined();
  });

  test("hint is case insensitive", () => {
    const { mentions } = parseActorMentions(
      "[@forge(Light): task]",
      knownAgents,
    );
    expect(mentions).toHaveLength(1);
    expect(mentions[0].modelHint).toBe("light");
  });

  test("mixed hints and no-hints", () => {
    const { mentions } = parseActorMentions(
      "[@forge(light): simple task] [@analyst: normal task] [@tester(sonnet): run tests]",
      knownAgents,
    );
    expect(mentions).toHaveLength(3);
    expect(mentions[0].modelHint).toBe("light");
    expect(mentions[1].modelHint).toBeUndefined();
    expect(mentions[2].modelHint).toBe("sonnet");
  });

  test("hint with instance-qualified mention", () => {
    const { mentions } = parseActorMentions(
      "[@trading.forge(light): build dashboard]",
      knownAgents,
    );
    expect(mentions).toHaveLength(1);
    expect(mentions[0].agent).toBe("forge");
    expect(mentions[0].instance).toBe("trading");
    expect(mentions[0].modelHint).toBe("light");
  });

  test("strips hinted mentions from response", () => {
    const { cleanedResponse } = parseActorMentions(
      "Delegating.\n\n[@forge(sonnet): do it]\n\nDone.",
      knownAgents,
    );
    expect(cleanedResponse).toBe("Delegating.\n\nDone.");
    expect(cleanedResponse).not.toContain("[@forge");
  });

  test("ignores hinted mentions inside code fences", () => {
    const { mentions } = parseActorMentions(
      "Example:\n```\n[@forge(light): task]\n```",
      knownAgents,
    );
    expect(mentions).toHaveLength(0);
  });

  test("backward compatible — existing tests still work", () => {
    const { mentions } = parseActorMentions(
      "[@forge: build the retry logic]",
      knownAgents,
    );
    expect(mentions).toHaveLength(1);
    expect(mentions[0]).toMatchObject({
      agent: "forge",
      task: "build the retry logic",
    });
    expect(mentions[0].modelHint).toBeUndefined();
  });
});

// --- resolveModelHint ---

describe("resolveModelHint", () => {
  test("resolves 'light' to haiku", () => {
    const result = resolveModelHint("light");
    expect(result).toBeDefined();
    expect(result!.model).toBe("claude-haiku-4-5-20251001");
    expect(result!.provider).toBe("anthropic");
  });

  test("resolves 'heavy' to opus", () => {
    const result = resolveModelHint("heavy");
    expect(result).toBeDefined();
    expect(result!.model).toBe("claude-opus-4-6");
    expect(result!.provider).toBe("anthropic");
  });

  test("resolves 'sonnet' to sonnet", () => {
    const result = resolveModelHint("sonnet");
    expect(result).toBeDefined();
    expect(result!.model).toBe("claude-sonnet-4-6");
  });

  test("resolves 'flash' to deepseek", () => {
    const result = resolveModelHint("flash");
    expect(result).toBeDefined();
    expect(result!.model).toBe("deepseek/deepseek-v3.2");
    expect(result!.provider).toBe("openrouter");
  });

  test("is case insensitive", () => {
    expect(resolveModelHint("LIGHT")).toEqual(resolveModelHint("light"));
    expect(resolveModelHint("Sonnet")).toEqual(resolveModelHint("sonnet"));
  });

  test("returns undefined for unknown hints", () => {
    expect(resolveModelHint("unknown")).toBeUndefined();
    expect(resolveModelHint("gpt4")).toBeUndefined();
  });

  test("all hints resolve to models in MODEL_TIERS", () => {
    const hints = ["light", "heavy", "haiku", "sonnet", "opus", "flash"];
    for (const hint of hints) {
      const result = resolveModelHint(hint);
      expect(result).toBeDefined();
      expect(getModelTier(result!.model)).toBeGreaterThanOrEqual(1);
    }
  });

  test("light < sonnet < heavy in tier order", () => {
    const light = resolveModelHint("light")!;
    const sonnet = resolveModelHint("sonnet")!;
    const heavy = resolveModelHint("heavy")!;
    expect(getModelTier(light.model)).toBeLessThan(getModelTier(sonnet.model));
    expect(getModelTier(sonnet.model)).toBeLessThan(getModelTier(heavy.model));
  });
});

// --- TraceStore success rates ---

describe("TraceStore routing feedback", () => {
  function makeTraceStore(): TraceStore {
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
        error TEXT,
        tokens_in INTEGER DEFAULT 0,
        tokens_out INTEGER DEFAULT 0,
        cost REAL DEFAULT 0,
        duration_ms INTEGER DEFAULT 0,
        model TEXT,
        task_type TEXT,
        model_hint TEXT,
        billing_type TEXT,
        metadata_json TEXT,
        started_at INTEGER,
        completed_at INTEGER
      );
    `);
    return new TraceStore(db);
  }

  test("completeEvent records model, task_type, and model_hint", () => {
    const store = makeTraceStore();
    store.startTrace({ id: "t1", channel: "api", sender: "user", inputMessage: "test" });
    const eventId = store.startEvent("t1", "forge", "fix bug");

    store.completeEvent(eventId, {
      responseExcerpt: "Fixed.",
      tokensIn: 100,
      tokensOut: 50,
      cost: 0.01,
      durationMs: 5000,
      model: "claude-sonnet-4-6",
      taskType: "coding",
      modelHint: "sonnet",
    });

    const events = store.getTraceEvents("t1");
    expect(events).toHaveLength(1);
    expect(events[0].model).toBe("claude-sonnet-4-6");
    expect(events[0].task_type).toBe("coding");
    expect(events[0].model_hint).toBe("sonnet");
    expect(events[0].status).toBe("completed");
  });

  test("completeEvent works without model fields (backward compat)", () => {
    const store = makeTraceStore();
    store.startTrace({ id: "t1", channel: "api", sender: "user", inputMessage: "test" });
    const eventId = store.startEvent("t1", "forge", "task");

    store.completeEvent(eventId, {
      responseExcerpt: "Done.",
      tokensIn: 100,
      tokensOut: 50,
    });

    const events = store.getTraceEvents("t1");
    expect(events[0].model).toBeNull();
    expect(events[0].task_type).toBeNull();
    expect(events[0].model_hint).toBeNull();
  });

  test("getSuccessRates returns empty for no data", () => {
    const store = makeTraceStore();
    expect(store.getSuccessRates()).toEqual([]);
  });

  test("getSuccessRates groups by model and task_type", () => {
    const store = makeTraceStore();
    const now = Date.now();

    store.startTrace({ id: "t1", channel: "api", sender: "user", inputMessage: "test" });

    // Add 4 completed events for sonnet/coding (need >= 3 for threshold)
    for (let i = 0; i < 4; i++) {
      const eid = store.startEvent("t1", "forge", `task${i}`);
      store.completeEvent(eid, {
        tokensIn: 100, tokensOut: 50, cost: 0.01, durationMs: 5000,
        model: "claude-sonnet-4-6", taskType: "coding",
      });
    }

    // Add 1 failed event for sonnet/coding
    const failId = store.startEvent("t1", "forge", "fail-task");
    // Manually set model/task_type then fail
    const db = (store as any).db as Database;
    db.prepare("UPDATE trace_events SET model = ?, task_type = ? WHERE id = ?")
      .run("claude-sonnet-4-6", "coding", failId);
    store.failEvent(failId, "something broke");

    const rates = store.getSuccessRates();
    expect(rates).toHaveLength(1);
    expect(rates[0].model).toBe("claude-sonnet-4-6");
    expect(rates[0].task_type).toBe("coding");
    expect(rates[0].total).toBe(5);
    expect(rates[0].completed).toBe(4);
    expect(rates[0].failed).toBe(1);
    expect(rates[0].success_rate).toBe(80);
  });

  test("getSuccessRates excludes entries with < 3 events", () => {
    const store = makeTraceStore();
    store.startTrace({ id: "t1", channel: "api", sender: "user", inputMessage: "test" });

    // Add only 2 events (below threshold)
    for (let i = 0; i < 2; i++) {
      const eid = store.startEvent("t1", "forge", `task${i}`);
      store.completeEvent(eid, {
        tokensIn: 100, tokensOut: 50, cost: 0.01, durationMs: 5000,
        model: "claude-opus-4-6", taskType: "expert",
      });
    }

    expect(store.getSuccessRates()).toEqual([]);
  });

  test("getHintStats tracks model hint usage", () => {
    const store = makeTraceStore();
    store.startTrace({ id: "t1", channel: "api", sender: "user", inputMessage: "test" });

    // 3 hinted events
    for (let i = 0; i < 3; i++) {
      const eid = store.startEvent("t1", "forge", `task${i}`);
      store.completeEvent(eid, {
        tokensIn: 100, tokensOut: 50, cost: 0.005, durationMs: 2000,
        model: "claude-haiku-4-5-20251001", taskType: "coding", modelHint: "light",
      });
    }

    const stats = store.getHintStats();
    expect(stats).toHaveLength(1);
    expect(stats[0].model_hint).toBe("light");
    expect(stats[0].resolved_model).toBe("claude-haiku-4-5-20251001");
    expect(stats[0].total).toBe(3);
    expect(stats[0].completed).toBe(3);
  });

  test("getHintStats returns empty when no hints used", () => {
    const store = makeTraceStore();
    store.startTrace({ id: "t1", channel: "api", sender: "user", inputMessage: "test" });
    const eid = store.startEvent("t1", "forge", "task");
    store.completeEvent(eid, {
      tokensIn: 100, tokensOut: 50, model: "claude-sonnet-4-6", taskType: "coding",
    });

    expect(store.getHintStats()).toEqual([]);
  });
});

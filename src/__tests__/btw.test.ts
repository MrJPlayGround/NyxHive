import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { z } from "zod";

// --- Task 1: Schema validation tests ---

const btwRequestSchema = z.object({
  question: z.string().min(1).max(2000),
  conversation_id: z.string().optional(),
  source: z.string().default("human"),
});

const steerRequestSchema = z.object({
  message: z.string().min(1).max(5000),
  conversation_id: z.string().optional(),
  priority: z.enum(["normal", "interrupt"]).default("normal"),
  source: z.string().default("human"),
  ttl_seconds: z.number().int().positive().optional().default(300),
  on_expire: z.enum(["discard"]).optional().default("discard"),
});

describe("BTW request validation", () => {
  it("accepts valid request", () => {
    const result = btwRequestSchema.safeParse({ question: "what are you doing?" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.source).toBe("human");
    }
  });

  it("rejects empty question", () => {
    const result = btwRequestSchema.safeParse({ question: "" });
    expect(result.success).toBe(false);
  });

  it("rejects missing question", () => {
    const result = btwRequestSchema.safeParse({ source: "human" });
    expect(result.success).toBe(false);
  });
});

describe("Steer request validation", () => {
  it("accepts valid request with defaults", () => {
    const result = steerRequestSchema.safeParse({ message: "check migrations" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.priority).toBe("normal");
      expect(result.data.ttl_seconds).toBe(300);
      expect(result.data.on_expire).toBe("discard");
    }
  });

  it("rejects invalid priority", () => {
    const result = steerRequestSchema.safeParse({ message: "x", priority: "urgent" });
    expect(result.success).toBe(false);
  });

  it("accepts interrupt priority", () => {
    const result = steerRequestSchema.safeParse({ message: "stop", priority: "interrupt" });
    expect(result.success).toBe(true);
  });
});

// --- Task 2: QueueDB.getActiveTasks tests ---

import { QueueDB } from "../queue/db.js";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("QueueDB.getActiveTasks", () => {
  let db: QueueDB;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "btw-test-"));
    db = new QueueDB(tmpDir);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns empty array when no tasks processing", () => {
    const tasks = db.getActiveTasks("nyx");
    expect(tasks).toEqual([]);
  });

  it("returns processing tasks for agent", () => {
    const msgId = db.enqueueMessage({
      channel: "discord",
      sender: "jay",
      sender_id: "jay_1",
      message: "do something",
      agent: "nyx",
      conversation_id: "conv_1",
    });
    db.claimMessage("nyx");

    const tasks = db.getActiveTasks("nyx");
    expect(tasks).toHaveLength(1);
    expect(tasks[0].message_id).toBe(msgId);
    expect(tasks[0].conversation_id).toBe("conv_1");
  });

  it("does not return tasks for other agents", () => {
    db.enqueueMessage({
      channel: "discord",
      sender: "jay",
      message: "do something",
      agent: "coder",
      conversation_id: "conv_1",
    });
    db.claimMessage("coder");

    const tasks = db.getActiveTasks("nyx");
    expect(tasks).toEqual([]);
  });

  it("returns multiple active tasks", () => {
    db.enqueueMessage({
      channel: "discord",
      sender: "jay",
      message: "task 1",
      agent: "nyx",
      conversation_id: "conv_1",
    });
    db.enqueueMessage({
      channel: "slack",
      sender: "jay",
      message: "task 2",
      agent: "nyx",
      conversation_id: "conv_2",
    });
    db.claimMessage("nyx");
    db.claimMessage("nyx");

    const tasks = db.getActiveTasks("nyx");
    expect(tasks).toHaveLength(2);
  });
});

// --- Task 3: BtwContextCache and BtwRateLimiter tests ---

import { BtwContextCache, BtwRateLimiter, buildBtwMessages } from "../queue/btw.js";

describe("BtwContextCache", () => {
  it("stores and retrieves context", () => {
    const cache = new BtwContextCache();
    cache.set("msg_1", {
      systemPrompt: "You are Nyx",
      conversationHistory: [
        { role: "user", content: "fix the bug" },
        { role: "assistant", content: "On it" },
      ],
      agentKey: "nyx",
      conversationId: "conv_1",
    });

    const ctx = cache.get("msg_1");
    expect(ctx).not.toBeNull();
    expect(ctx!.systemPrompt).toBe("You are Nyx");
    expect(ctx!.conversationHistory).toHaveLength(2);
  });

  it("returns null for missing entries", () => {
    const cache = new BtwContextCache();
    expect(cache.get("nonexistent")).toBeNull();
  });

  it("evicts entries", () => {
    const cache = new BtwContextCache();
    cache.set("msg_1", {
      systemPrompt: "test",
      conversationHistory: [],
      agentKey: "nyx",
      conversationId: "conv_1",
    });
    cache.evict("msg_1");
    expect(cache.get("msg_1")).toBeNull();
  });

  it("prunes entries older than maxAge", () => {
    const cache = new BtwContextCache();
    cache.set("msg_old", {
      systemPrompt: "old",
      conversationHistory: [],
      agentKey: "nyx",
      conversationId: "conv_1",
    });

    // Manually backdate the entry
    const entry = (cache as any).cache.get("msg_old");
    entry.createdAt = Date.now() - 61 * 60 * 1000; // 61 minutes ago

    cache.prune(60 * 60 * 1000); // 60 min max age
    expect(cache.get("msg_old")).toBeNull();
  });
});

describe("BtwRateLimiter", () => {
  it("allows requests under limit", () => {
    const limiter = new BtwRateLimiter(5, 60_000);
    for (let i = 0; i < 5; i++) {
      expect(limiter.check("human")).toBe(true);
    }
  });

  it("blocks requests over limit", () => {
    const limiter = new BtwRateLimiter(2, 60_000);
    expect(limiter.check("human")).toBe(true);
    expect(limiter.check("human")).toBe(true);
    expect(limiter.check("human")).toBe(false);
  });

  it("tracks sources independently", () => {
    const limiter = new BtwRateLimiter(1, 60_000);
    expect(limiter.check("human")).toBe(true);
    expect(limiter.check("scout")).toBe(true);
    expect(limiter.check("human")).toBe(false);
  });
});

// --- Task 4: Route tests ---

import { btwSteerRoutes } from "../server/routes/btw-steer.js";
import { Hono } from "hono";
import type { AuthEnv } from "../auth/types.js";

function withAuth(routes: Hono, basePath: string): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.use("/*", async (c, next) => {
    c.set("auth" as never, { type: "api_key", role: "owner" } as never);
    return next();
  });
  app.route(basePath, routes);
  return app;
}

describe("POST /api/agents/:agentKey/btw", () => {
  it("returns 409 when agent is idle", async () => {
    const mockProcessor = {
      resolveActiveTaskTarget: () => ({ error: "agent_idle", status: 409 }),
      getBtwContext: () => null,
    };
    const app = withAuth(btwSteerRoutes(mockProcessor as any), "/api/agents");

    const res = await app.request("/api/agents/nyx/btw", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "what are you doing?", source: "human" }),
    });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("agent_idle");
  });

  it("returns 400 when agent has ambiguous tasks and no conversation_id", async () => {
    const mockProcessor = {
      resolveActiveTaskTarget: () => ({
        error: "ambiguous_target",
        status: 400,
        active_conversations: [
          { message_id: "m1", conversation_id: "c1" },
          { message_id: "m2", conversation_id: "c2" },
        ],
      }),
      getBtwContext: () => null,
    };
    const app = withAuth(btwSteerRoutes(mockProcessor as any), "/api/agents");

    const res = await app.request("/api/agents/nyx/btw", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "what?", source: "human" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("ambiguous_target");
    expect(body.active_conversations).toHaveLength(2);
  });
});

describe("POST /api/agents/:agentKey/steer", () => {
  it("returns 409 when agent is idle", async () => {
    const mockProcessor = {
      resolveActiveTaskTarget: () => ({ error: "agent_idle", status: 409 }),
    };
    const app = withAuth(btwSteerRoutes(mockProcessor as any), "/api/agents");

    const res = await app.request("/api/agents/nyx/steer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "check migrations", source: "human" }),
    });
    expect(res.status).toBe(409);
  });

  it("returns 201 when steer queued successfully", async () => {
    const mockProcessor = {
      resolveActiveTaskTarget: () => ({ message_id: "m1", conversation_id: "c1" }),
      handleSteer: async () => ({
        steer_id: "steer_abc123",
        status: "queued",
        target_message_id: "m1",
        estimated_delivery: "next_turn",
      }),
    };
    const app = withAuth(btwSteerRoutes(mockProcessor as any), "/api/agents");

    const res = await app.request("/api/agents/nyx/steer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: "check migrations", source: "human" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.steer_id).toBe("steer_abc123");
  });
});

describe("buildBtwMessages", () => {
  it("includes history capped at maxMessages", () => {
    const history = Array.from({ length: 30 }, (_, i) => ({
      role: "user" as const,
      content: `msg ${i}`,
    }));
    const msgs = buildBtwMessages(
      { systemPrompt: "test", conversationHistory: history, agentKey: "nyx", conversationId: "c1" },
      "what are you doing?",
      {},
      20,
    );
    expect(msgs).toHaveLength(21);
    expect(msgs[0].content).toBe("msg 10");
    expect(msgs[20].content).toBe("what are you doing?");
  });

  it("includes progress context in question", () => {
    const msgs = buildBtwMessages(
      { systemPrompt: "test", conversationHistory: [], agentKey: "nyx", conversationId: "c1" },
      "what file?",
      { activity: "Reading processor.ts", text: "Found 3 issues" },
    );
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toContain("Agent is currently: Reading processor.ts");
    expect(msgs[0].content).toContain("Progress so far: Found 3 issues");
    expect(msgs[0].content).toContain("what file?");
  });

  it("works with no progress", () => {
    const msgs = buildBtwMessages(
      { systemPrompt: "test", conversationHistory: [], agentKey: "nyx", conversationId: "c1" },
      "status?",
      {},
    );
    expect(msgs).toHaveLength(1);
    expect(msgs[0].content).toBe("status?");
  });
});

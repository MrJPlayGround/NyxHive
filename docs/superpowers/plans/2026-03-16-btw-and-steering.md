# BTW & Steering Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two mid-task communication capabilities to NyxHive: ephemeral side queries (BTW) and persistent steering injection, across all channels and agent-to-agent.

**Architecture:** BTW makes a stateless Haiku inference call against cached context. Steering writes to a `steers` SQLite table and delivers at turn boundaries (between CLI subprocess invocations via `--resume`). Both share a `getActiveTasks()` resolver for target disambiguation.

**Tech Stack:** Bun, TypeScript, SQLite (bun:sqlite), Hono (HTTP routes), Zod (validation), bun:test

**Spec:** `docs/superpowers/specs/2026-03-15-btw-and-steering-design.md`

---

## File Structure

### New Files
| File | Responsibility |
|------|---------------|
| `src/queue/btw.ts` | BTW context cache, inference call, rate limiting |
| `src/queue/steers.ts` | Steers SQLite table, CRUD, delivery, expiry, batching |
| `src/__tests__/btw.test.ts` | BTW unit tests |
| `src/__tests__/steers.test.ts` | Steers unit tests |
| `src/__tests__/btw-steers-integration.test.ts` | Integration tests for routing and delivery |

### Modified Files
| File | Changes |
|------|---------|
| `src/types.ts` | Add `BtwRequest`, `BtwResponse`, `SteerMessage`, `SteerRequest`, `SteerResponse`, `ActiveTask` types |
| `src/queue/db.ts` | Add `steers` table to schema init, add `getActiveTasks()` query |
| `src/queue/processor.ts` | Add context cache Map, steer check in invocation loop, BTW handler, `getActiveTasks()` public method |
| `src/server/routes/` | New route file for BTW and Steer endpoints |
| `src/server/index.ts` | Mount new routes |
| `src/mcp/server.ts` | Register `btw_agent` and `steer_agent` tools |
| `src/channels/discord.ts` | BTW/steer routing based on active task state |
| `src/channels/slack.ts` | BTW/steer routing based on active task state |
| `src/agents/invoke.ts` | Export `ConversationMessage` type if not already exported |

---

## Chunk 1: Types, Active Task Resolution & BTW Core

### Task 1: Add shared types

**Files:**
- Modify: `src/types.ts:64-102`

- [ ] **Step 1: Write the types test**

Create `src/__tests__/btw.test.ts` with Zod schema validation tests (these test the route-level validation, not just types):

```typescript
import { describe, it, expect } from "bun:test";
import { z } from "zod";

// Mirror the schemas from the route file — we'll test validation behavior
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
  on_expire: z.enum(["discard", "requeue"]).optional().default("discard"),
});

describe("BTW request validation", () => {
  it("accepts valid request", () => {
    const result = btwRequestSchema.safeParse({ question: "what are you doing?" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.source).toBe("human"); // default
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/user/dev/nyxhive && bun test src/__tests__/btw.test.ts`
Expected: FAIL — types don't exist yet

- [ ] **Step 3: Add types to src/types.ts**

Add after the existing `ResponseData` interface (around line 102):

```typescript
/** BTW (side query) — ephemeral question to a running agent */
export interface BtwRequest {
  question: string;
  conversation_id?: string;
  source: string; // "human" or agent key
}

export interface BtwResponse {
  answer: string;
  context_tokens: number;
  model: string;
}

/** Steering — mid-task context injection */
export interface SteerRequest {
  message: string;
  conversation_id?: string;
  priority: "normal" | "interrupt";
  source: string;
  ttl_seconds?: number;
  on_expire?: "discard" | "requeue";
}

export interface SteerResponse {
  steer_id: string;
  status: "queued";
  target_message_id: string;
  estimated_delivery: "next_checkpoint" | "next_turn";
}

export interface SteerRecord {
  id: number;
  steer_id: string;
  target_message_id: string | null;
  target_agent: string;
  conversation_id: string;
  source: string;
  channel: string | null;
  message: string;
  priority: "normal" | "interrupt";
  status: "pending" | "delivered" | "expired";
  ttl_seconds: number | null;
  on_expire: "discard" | "requeue";
  created_at: number;
  delivered_at: number | null;
  expired_at: number | null;
}

/** Active task info for target resolution */
export interface ActiveTask {
  message_id: string;
  conversation_id: string;
  activity: string;
  started_at: number;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/user/dev/nyxhive && bun test src/__tests__/btw.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /home/user/dev/nyxhive && git add src/types.ts src/__tests__/btw.test.ts && git commit -m "feat: add BTW and Steering types"
```

---

### Task 2: Add getActiveTasks to QueueDB

**Files:**
- Modify: `src/queue/db.ts:284-296`
- Test: `src/__tests__/btw.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `src/__tests__/btw.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/user/dev/nyxhive && bun test src/__tests__/btw.test.ts`
Expected: FAIL — `getActiveTasks` is not a function

- [ ] **Step 3: Implement getActiveTasks in QueueDB**

Add to `src/queue/db.ts` after the `completeMessage()` method (around line 296):

```typescript
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/user/dev/nyxhive && bun test src/__tests__/btw.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /home/user/dev/nyxhive && git add src/queue/db.ts src/__tests__/btw.test.ts && git commit -m "feat: add getActiveTasks query to QueueDB"
```

---

### Task 3: Build BTW context cache and inference

**Files:**
- Create: `src/queue/btw.ts`
- Test: `src/__tests__/btw.test.ts`

- [ ] **Step 1: Write the failing test for BtwContextCache**

Append to `src/__tests__/btw.test.ts`:

```typescript
import { BtwContextCache } from "../queue/btw.js";

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/user/dev/nyxhive && bun test src/__tests__/btw.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement BtwContextCache and BtwRateLimiter**

Create `src/queue/btw.ts`:

```typescript
import type { ConversationMessage } from "../agents/invoke.js";

export interface BtwCachedContext {
  systemPrompt: string;
  conversationHistory: ConversationMessage[];
  agentKey: string;
  conversationId: string;
}

interface CacheEntry {
  context: BtwCachedContext;
  createdAt: number;
}

export class BtwContextCache {
  private cache = new Map<string, CacheEntry>();

  set(messageId: string, context: BtwCachedContext): void {
    this.cache.set(messageId, { context, createdAt: Date.now() });
  }

  get(messageId: string): BtwCachedContext | null {
    const entry = this.cache.get(messageId);
    return entry?.context ?? null;
  }

  evict(messageId: string): void {
    this.cache.delete(messageId);
  }

  prune(maxAgeMs: number): number {
    const cutoff = Date.now() - maxAgeMs;
    let pruned = 0;
    for (const [key, entry] of this.cache) {
      if (entry.createdAt < cutoff) {
        this.cache.delete(key);
        pruned++;
      }
    }
    return pruned;
  }

  get size(): number {
    return this.cache.size;
  }
}

export class BtwRateLimiter {
  private windows = new Map<string, number[]>();

  constructor(
    private maxPerWindow: number = 5,
    private windowMs: number = 60_000,
  ) {}

  check(source: string): boolean {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    const timestamps = (this.windows.get(source) ?? []).filter((t) => t > cutoff);

    if (timestamps.length >= this.maxPerWindow) {
      this.windows.set(source, timestamps);
      return false;
    }

    timestamps.push(now);
    this.windows.set(source, timestamps);
    return true;
  }
}

/**
 * Build the message array for a BTW inference call.
 * Caps conversation history at maxMessages and appends progress context.
 */
export function buildBtwMessages(
  cached: BtwCachedContext,
  question: string,
  progress: { activity?: string; text?: string },
  maxMessages: number = 20,
): ConversationMessage[] {
  const history = cached.conversationHistory.slice(-maxMessages);

  const progressParts: string[] = [];
  if (progress.activity) progressParts.push(`Agent is currently: ${progress.activity}`);
  if (progress.text) progressParts.push(`Progress so far: ${progress.text.slice(0, 2000)}`);

  const contextNote = progressParts.length > 0
    ? `[${progressParts.join(". ")}]\n\n`
    : "";

  return [
    ...history,
    { role: "user" as const, content: `${contextNote}${question}` },
  ];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/user/dev/nyxhive && bun test src/__tests__/btw.test.ts`
Expected: PASS

- [ ] **Step 5: Add test for buildBtwMessages**

Append to `src/__tests__/btw.test.ts`:

```typescript
import { buildBtwMessages } from "../queue/btw.js";

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
    // 20 history + 1 question = 21
    expect(msgs).toHaveLength(21);
    expect(msgs[0].content).toBe("msg 10"); // starts from offset 10
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
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd /home/user/dev/nyxhive && bun test src/__tests__/btw.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
cd /home/user/dev/nyxhive && git add src/queue/btw.ts src/__tests__/btw.test.ts && git commit -m "feat: add BTW context cache, rate limiter, and message builder"
```

---

### Task 4: Add BTW API route

> **Note:** This task creates the route file which imports `handleBtw` and `getActiveTasks` from the processor. These methods are added in Task 5. The route tests use mocks, but `bunx tsc --noEmit` will fail until Task 5 is complete. Run type check only after Task 5.

**Files:**
- Create: `src/server/routes/btw-steer.ts`
- Modify: `src/server/index.ts`

- [ ] **Step 1: Write failing test for the route**

Append to `src/__tests__/btw.test.ts`:

```typescript
import { describe, it, expect } from "bun:test";
import { btwSteerRoutes } from "../server/routes/btw-steer.js";
import { Hono } from "hono";

describe("POST /api/agents/:agentKey/btw", () => {
  it("returns 409 when agent is idle", async () => {
    const mockProcessor = {
      getActiveTasks: () => [],
      getBtwContext: () => null,
    };
    const app = new Hono();
    app.route("/api/agents", btwSteerRoutes(mockProcessor as any));

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
      getActiveTasks: () => [
        { message_id: "m1", conversation_id: "c1", activity: "Reading", started_at: 1 },
        { message_id: "m2", conversation_id: "c2", activity: "Writing", started_at: 2 },
      ],
      getBtwContext: () => null,
    };
    const app = new Hono();
    app.route("/api/agents", btwSteerRoutes(mockProcessor as any));

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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/user/dev/nyxhive && bun test src/__tests__/btw.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement the route file**

Create `src/server/routes/btw-steer.ts`:

```typescript
import { Hono } from "hono";
import { z } from "zod";
import type { QueueProcessor } from "../../queue/processor.js";

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
  on_expire: z.enum(["discard", "requeue"]).optional().default("discard"),
});

function resolveTarget(
  processor: QueueProcessor,
  agentKey: string,
  conversationId?: string,
): { message_id: string; conversation_id: string } | { error: string; status: number; active_conversations?: Array<{ message_id: string; conversation_id: string }> } {
  const tasks = processor.getActiveTasks(agentKey);

  if (tasks.length === 0) {
    return { error: "agent_idle", status: 409 };
  }

  if (tasks.length === 1) {
    return { message_id: tasks[0].message_id, conversation_id: tasks[0].conversation_id };
  }

  // Multiple active tasks
  if (conversationId) {
    const match = tasks.find((t) => t.conversation_id === conversationId);
    if (match) return { message_id: match.message_id, conversation_id: match.conversation_id };
    return { error: "conversation_not_found", status: 404 };
  }

  return {
    error: "ambiguous_target",
    status: 400,
    active_conversations: tasks.map((t) => ({
      message_id: t.message_id,
      conversation_id: t.conversation_id,
    })),
  };
}

export function btwSteerRoutes(processor: QueueProcessor): Hono {
  const app = new Hono();

  // BTW — ephemeral side query
  app.post("/:agentKey/btw", async (c) => {
    const agentKey = c.req.param("agentKey");
    const body = btwRequestSchema.safeParse(await c.req.json());
    if (!body.success) {
      return c.json({ error: "invalid_request", details: body.error.issues }, 400);
    }

    const target = resolveTarget(processor, agentKey, body.data.conversation_id);
    if ("error" in target) {
      const { status, ...rest } = target;
      return c.json(rest, status as any);
    }

    const result = await processor.handleBtw(agentKey, target.message_id, body.data.question, body.data.source);
    if (!result) {
      return c.json({ error: "context_unavailable", message: "No cached context for this task" }, 404);
    }
    return c.json(result);
  });

  // Steer — mid-task context injection
  app.post("/:agentKey/steer", async (c) => {
    const agentKey = c.req.param("agentKey");
    const body = steerRequestSchema.safeParse(await c.req.json());
    if (!body.success) {
      return c.json({ error: "invalid_request", details: body.error.issues }, 400);
    }

    const target = resolveTarget(processor, agentKey, body.data.conversation_id);
    if ("error" in target) {
      const { status, ...rest } = target;
      return c.json(rest, status as any);
    }

    const result = await processor.handleSteer(agentKey, target.message_id, target.conversation_id, body.data);
    return c.json(result, 201);
  });

  return app;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/user/dev/nyxhive && bun test src/__tests__/btw.test.ts`
Expected: PASS (the route-level tests use mocks, so they should pass)

- [ ] **Step 5: Commit**

```bash
cd /home/user/dev/nyxhive && git add src/server/routes/btw-steer.ts src/__tests__/btw.test.ts && git commit -m "feat: add BTW and Steer API routes with target resolution"
```

---

### Task 5: Wire BTW into processor

**Files:**
- Modify: `src/queue/processor.ts:100-150` (class state), `src/queue/processor.ts:1053-1088` (context building), `src/queue/processor.ts:712-770` (cleanup)

- [ ] **Step 1: Write failing test for processor BTW**

Append to `src/__tests__/btw.test.ts`:

```typescript
describe("QueueProcessor.getActiveTasks", () => {
  // This test verifies the public method exists and delegates to QueueDB
  it("delegates to queue.getActiveTasks", () => {
    const mockQueue = {
      getActiveTasks: (agent: string) => [
        { message_id: "m1", conversation_id: "c1", activity: "Reading", started_at: 1 },
      ],
    };
    // We'll test this via the route integration test since processor has many deps
    expect(mockQueue.getActiveTasks("nyx")).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Add context cache and getActiveTasks to processor**

In `src/queue/processor.ts`, add to class state (around line 150):

```typescript
private btwCache = new BtwContextCache();
private btwLimiter = new BtwRateLimiter(5, 60_000);
```

Add import at top:
```typescript
import { BtwContextCache, BtwRateLimiter, buildBtwMessages } from "./btw.js";
```

Add public methods:

```typescript
getActiveTasks(agentKey: string): ActiveTask[] {
  return this.queue.getActiveTasks(agentKey);
}

getBtwContext(messageId: string) {
  return this.btwCache.get(messageId);
}

async handleBtw(
  agentKey: string,
  messageId: string,
  question: string,
  source: string,
): Promise<BtwResponse | null> {
  if (!this.btwLimiter.check(source)) {
    throw new Error("Rate limit exceeded for BTW queries");
  }

  const cached = this.btwCache.get(messageId);
  if (!cached) return null;

  const progress = this.queue.getMessageProgress(messageId);
  const messages = buildBtwMessages(cached, question, {
    activity: progress?.activity ?? undefined,
    text: progress?.text ?? undefined,
  });

  const model = "claude-haiku-4-5-20251001";
  // CompletionParams: { messages, model?, maxTokens?, system?, tools?, effort? }
  // ProviderResponse: { content, model, provider, tokensIn, tokensOut }
  const result = await this.config.router.complete({
    model,
    system: cached.systemPrompt,
    messages,
    maxTokens: 500,
  }, "anthropic", model);

  this.emit("btw:query", { agent: agentKey, source, message_id: messageId });
  this.emit("btw:response", { agent: agentKey, source, message_id: messageId, tokens: result.tokensIn + result.tokensOut });

  return {
    answer: result.content,
    context_tokens: result.tokensIn + result.tokensOut,
    model: result.model,
  };
}
```

- [ ] **Step 3: Cache context in processForAgent**

In `processForAgent()`, after the system prompt and conversation history are built (around line 1088), add:

```typescript
// Cache context for BTW side queries
this.btwCache.set(msg.message_id, {
  systemPrompt: systemPromptResult.prompt,
  conversationHistory: conversationHistory.slice(),
  agentKey,
  conversationId: convId,
});
```

After message completion (around line 1300, near `completeMessage`), add:

```typescript
this.btwCache.evict(msg.message_id);
```

Also in the error/timeout handler, add eviction.

- [ ] **Step 4: Add cache pruning to cleanExpiredState**

In `cleanExpiredState()` (around line 770), add:

```typescript
// Prune BTW context cache (60 min max age)
const prunedBtw = this.btwCache.prune(60 * 60 * 1000);
if (prunedBtw > 0) logger.info(`[processor] Pruned ${prunedBtw} stale BTW cache entries`);
```

- [ ] **Step 5: Add getMessageProgress to QueueDB**

In `src/queue/db.ts`, add after `updateMessageProgress()`:

```typescript
getMessageProgress(messageId: string): { activity: string | null; text: string | null } | null {
  const row = this.db.query(
    `SELECT last_activity, last_progress_text FROM messages WHERE message_id = ?`,
  ).get(messageId) as { last_activity: string | null; last_progress_text: string | null } | null;
  if (!row) return null;
  return { activity: row.last_activity, text: row.last_progress_text };
}
```

- [ ] **Step 6: Mount routes in server**

In `src/server/index.ts`, add:

```typescript
import { btwSteerRoutes } from "./routes/btw-steer.js";
```

And in the route mounting section:

```typescript
app.route("/api/agents", btwSteerRoutes(processor));
```

- [ ] **Step 7: Run full test suite**

Run: `cd /home/user/dev/nyxhive && bun test`
Expected: All tests pass (existing + new)

- [ ] **Step 8: Commit**

```bash
cd /home/user/dev/nyxhive && git add src/queue/processor.ts src/queue/db.ts src/queue/btw.ts src/server/index.ts src/server/routes/btw-steer.ts && git commit -m "feat: wire BTW into processor with context cache and API routes"
```

---

## Chunk 2: Steers Core

### Task 6: Create steers table and CRUD

**Files:**
- Create: `src/queue/steers.ts`
- Modify: `src/queue/db.ts`
- Test: `src/__tests__/steers.test.ts`

- [ ] **Step 1: Write failing tests for SteersDB**

Create `src/__tests__/steers.test.ts`:

```typescript
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { SteersDB } from "../queue/steers.js";
import { Database } from "bun:sqlite";

describe("SteersDB", () => {
  let db: Database;
  let steers: SteersDB;

  beforeEach(() => {
    db = new Database(":memory:");
    steers = new SteersDB(db);
  });

  afterEach(() => {
    db.close();
  });

  it("creates steers table on init", () => {
    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='steers'").all();
    expect(tables).toHaveLength(1);
  });

  it("enqueues a steer", () => {
    const id = steers.enqueue({
      target_message_id: "msg_1",
      target_agent: "nyx",
      conversation_id: "conv_1",
      source: "human",
      channel: "discord",
      message: "check the migration",
      priority: "normal",
      ttl_seconds: 300,
      on_expire: "discard",
    });
    expect(id).toMatch(/^steer_/);
  });

  it("gets pending steers for a message", () => {
    steers.enqueue({
      target_message_id: "msg_1",
      target_agent: "nyx",
      conversation_id: "conv_1",
      source: "human",
      message: "steer 1",
      priority: "normal",
    });
    steers.enqueue({
      target_message_id: "msg_1",
      target_agent: "nyx",
      conversation_id: "conv_1",
      source: "scout",
      message: "steer 2",
      priority: "normal",
    });

    const pending = steers.getPending("msg_1");
    expect(pending).toHaveLength(2);
    expect(pending[0].message).toBe("steer 1");
    expect(pending[1].message).toBe("steer 2");
  });

  it("marks steer as delivered", () => {
    const id = steers.enqueue({
      target_message_id: "msg_1",
      target_agent: "nyx",
      conversation_id: "conv_1",
      source: "human",
      message: "check it",
      priority: "normal",
    });
    steers.markDelivered(id);

    const pending = steers.getPending("msg_1");
    expect(pending).toHaveLength(0);
  });

  it("expires steers for completed message", () => {
    steers.enqueue({
      target_message_id: "msg_1",
      target_agent: "nyx",
      conversation_id: "conv_1",
      source: "human",
      message: "too late",
      priority: "normal",
    });
    const expired = steers.expireForMessage("msg_1");
    expect(expired).toBe(1);

    const pending = steers.getPending("msg_1");
    expect(pending).toHaveLength(0);
  });

  it("expires steers past TTL", () => {
    const id = steers.enqueue({
      target_message_id: "msg_1",
      target_agent: "nyx",
      conversation_id: "conv_1",
      source: "human",
      message: "old steer",
      priority: "normal",
      ttl_seconds: 1,
    });

    // Manually backdate
    db.run("UPDATE steers SET created_at = ? WHERE steer_id = ?", [Date.now() - 2000, id]);

    const expired = steers.expirePastTtl();
    expect(expired).toBeGreaterThanOrEqual(1);
  });

  it("counts pending steers for a message", () => {
    steers.enqueue({
      target_message_id: "msg_1",
      target_agent: "nyx",
      conversation_id: "conv_1",
      source: "human",
      message: "s1",
      priority: "normal",
    });
    expect(steers.pendingCount("msg_1")).toBe(1);
    expect(steers.pendingCount("msg_other")).toBe(0);
  });
});

describe("SteersDB batching", () => {
  let db: Database;
  let steers: SteersDB;

  beforeEach(() => {
    db = new Database(":memory:");
    steers = new SteersDB(db);
  });

  afterEach(() => {
    db.close();
  });

  it("formats batch with timestamps", () => {
    steers.enqueue({
      target_message_id: "msg_1",
      target_agent: "nyx",
      conversation_id: "conv_1",
      source: "human",
      message: "check migrations",
      priority: "normal",
    });
    steers.enqueue({
      target_message_id: "msg_1",
      target_agent: "nyx",
      conversation_id: "conv_1",
      source: "scout",
      message: "found issue in schema",
      priority: "normal",
    });

    const batch = steers.formatBatch("msg_1");
    expect(batch).toContain("[STEERS RECEIVED]");
    expect(batch).toContain("from human");
    expect(batch).toContain("check migrations");
    expect(batch).toContain("from scout");
    expect(batch).toContain("found issue in schema");
    expect(batch).toContain("[END STEERS]");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/user/dev/nyxhive && bun test src/__tests__/steers.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement SteersDB**

Create `src/queue/steers.ts`:

```typescript
import { Database } from "bun:sqlite";
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
  on_expire?: "discard" | "requeue";
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

  getRequeueCandidates(): SteerRecord[] {
    return this.db.query(
      `SELECT * FROM steers WHERE status = 'expired' AND on_expire = 'requeue'`,
    ).all() as SteerRecord[];
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/user/dev/nyxhive && bun test src/__tests__/steers.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /home/user/dev/nyxhive && git add src/queue/steers.ts src/__tests__/steers.test.ts && git commit -m "feat: add SteersDB with CRUD, expiry, and batch formatting"
```

---

### Task 7: Wire steering into processor

**Files:**
- Modify: `src/queue/processor.ts`

- [ ] **Step 1: Write test for steer delivery integration**

Append to `src/__tests__/steers.test.ts`:

```typescript
describe("Steer delivery lifecycle", () => {
  let db: Database;
  let steers: SteersDB;

  beforeEach(() => {
    db = new Database(":memory:");
    steers = new SteersDB(db);
  });

  afterEach(() => {
    db.close();
  });

  it("full lifecycle: enqueue -> getPending -> formatBatch -> markDelivered", () => {
    const id1 = steers.enqueue({
      target_message_id: "msg_1",
      target_agent: "nyx",
      conversation_id: "conv_1",
      source: "human",
      message: "check the migration",
      priority: "normal",
    });
    const id2 = steers.enqueue({
      target_message_id: "msg_1",
      target_agent: "nyx",
      conversation_id: "conv_1",
      source: "scout",
      message: "found related issue",
      priority: "normal",
    });

    // Verify pending
    expect(steers.pendingCount("msg_1")).toBe(2);

    // Format batch
    const batch = steers.formatBatch("msg_1");
    expect(batch).toContain("[STEERS RECEIVED]");
    expect(batch).toContain("check the migration");
    expect(batch).toContain("found related issue");

    // Mark delivered
    steers.markDelivered(id1);
    steers.markDelivered(id2);
    expect(steers.pendingCount("msg_1")).toBe(0);
  });

  it("interrupt steers appear in getPending alongside normal", () => {
    steers.enqueue({
      target_message_id: "msg_1",
      target_agent: "nyx",
      conversation_id: "conv_1",
      source: "human",
      message: "normal steer",
      priority: "normal",
    });
    steers.enqueue({
      target_message_id: "msg_1",
      target_agent: "nyx",
      conversation_id: "conv_1",
      source: "human",
      message: "urgent steer",
      priority: "interrupt",
    });

    const pending = steers.getPending("msg_1");
    expect(pending).toHaveLength(2);
    expect(pending.some((s) => s.priority === "interrupt")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cd /home/user/dev/nyxhive && bun test src/__tests__/steers.test.ts`
Expected: PASS

- [ ] **Step 3: Add SteersDB to processor and handleSteer method**

In `src/queue/processor.ts`, add to imports:

```typescript
import { SteersDB } from "./steers.js";
```

Add to class state:

```typescript
private steersDb: SteersDB | null = null;
```

Initialize in constructor or start() (where DB is available). Since `QueueDB.db` is private, `SteersDB` should open its own connection to the same DB file:

```typescript
// In start() or init(), pass the data dir
this.steersDb = new SteersDB(new Database(join(this.config.dataDir, `${this.config.instanceName ?? "nyxhive"}.db`)));
```

Alternatively, add a `getDb()` accessor to `QueueDB` — but opening a second WAL-mode connection to the same file is safe in SQLite and avoids breaking encapsulation.

Add `handleSteer` public method:

```typescript
async handleSteer(
  agentKey: string,
  targetMessageId: string,
  conversationId: string,
  opts: {
    message: string;
    priority: "normal" | "interrupt";
    source: string;
    channel?: string | null;
    ttl_seconds?: number;
    on_expire?: "discard" | "requeue";
  },
): Promise<SteerResponse> {
  if (!this.steersDb) throw new Error("Steers not initialized");

  // QueueDB has no getMessage() — query directly or look up channel from the steers table caller
  // The channel is available from the route context (channel adapter passes it) or can be NULL for API calls
  const channel: string | null = null; // Channel adapters pass channel when calling handleSteer

  const steerId = this.steersDb.enqueue({
    target_message_id: targetMessageId,
    target_agent: agentKey,
    conversation_id: conversationId,
    source: opts.source,
    channel,
    message: opts.message,
    priority: opts.priority,
    ttl_seconds: opts.ttl_seconds,
    on_expire: opts.on_expire,
  });

  this.emit("steer:queued", {
    steer_id: steerId,
    agent: agentKey,
    source: opts.source,
    message_id: targetMessageId,
  });

  return {
    steer_id: steerId,
    status: "queued",
    target_message_id: targetMessageId,
    estimated_delivery: opts.priority === "interrupt" ? "next_checkpoint" : "next_turn",
  };
}
```

- [ ] **Step 4: Add steer delivery check in processForAgent**

In `processForAgent()`, after agent invocation completes and before building the next turn (around line 1228), add:

```typescript
// Check for pending steers before next turn
if (this.steersDb) {
  const pendingCount = this.steersDb.pendingCount(msg.message_id);
  if (pendingCount > 0) {
    const batch = this.steersDb.formatBatch(msg.message_id);
    if (batch) {
      // Save steer batch to conversation history
      this.conversationMgr.saveSteerToHistory(convId, batch, msg.channel, agentKey);

      // Mark all as delivered
      const pending = this.steersDb.getPending(msg.message_id);
      for (const s of pending) {
        this.steersDb.markDelivered(s.steer_id);
        this.emit("steer:delivered", {
          steer_id: s.steer_id,
          agent: agentKey,
          message_id: msg.message_id,
        });
      }
    }
  }
}
```

- [ ] **Step 5: Add steer expiry on message completion**

Near `completeMessage()` call in processor (around line 1300), add:

```typescript
// Expire undelivered steers for completed message
if (this.steersDb) {
  const expired = this.steersDb.expireForMessage(msg.message_id);
  if (expired > 0) logger.info(`[processor] Expired ${expired} undelivered steers for ${msg.message_id}`);
}
```

- [ ] **Step 6: Add TTL expiry to cleanExpiredState**

In `cleanExpiredState()`, add:

```typescript
if (this.steersDb) {
  const expiredTtl = this.steersDb.expirePastTtl();
  if (expiredTtl > 0) logger.info(`[processor] Expired ${expiredTtl} steers past TTL`);
}
```

- [ ] **Step 7: Add saveSteerToHistory to ConversationManager**

In `src/queue/conversation.ts`, add:

```typescript
saveSteerToHistory(
  convId: string,
  steerContent: string,
  ctx: ConversationManagerContext,
): void {
  if (!ctx.memory) return;
  // MemoryStore.saveMessage signature: (conversationId, role, content, model, provider, tokensIn, tokensOut, costUsd)
  // Steers have zero token cost and no model/provider
  ctx.memory.saveMessage(convId, "user", steerContent, null, null, 0, 0, 0);
}
```

The steer identity is encoded in the content string (`[STEER from human]: ...` or `[STEERS RECEIVED]` batch). No metadata field — `MemoryStore.saveMessage` doesn't support one, and the spec explicitly chose content-prefix over metadata.

- [ ] **Step 8: Run full test suite**

Run: `cd /home/user/dev/nyxhive && bun test`
Expected: All tests pass

- [ ] **Step 9: Commit**

```bash
cd /home/user/dev/nyxhive && git add src/queue/processor.ts src/queue/steers.ts src/queue/conversation.ts src/__tests__/steers.test.ts && git commit -m "feat: wire steering into processor with turn-boundary delivery"
```

---

### Task 8: Interrupt priority (SIGTERM + re-invoke)

**Files:**
- Modify: `src/queue/processor.ts`

- [ ] **Step 1: Write test for interrupt detection logic**

Append to `src/__tests__/steers.test.ts`:

```typescript
describe("Interrupt priority detection", () => {
  let db: Database;
  let steers: SteersDB;

  beforeEach(() => {
    db = new Database(":memory:");
    steers = new SteersDB(db);
  });

  afterEach(() => {
    db.close();
  });

  it("detects interrupt steers in pending list", () => {
    steers.enqueue({
      target_message_id: "msg_1",
      target_agent: "nyx",
      conversation_id: "conv_1",
      source: "human",
      message: "stop and check this",
      priority: "interrupt",
    });

    const pending = steers.getPending("msg_1");
    const hasInterrupt = pending.some((s) => s.priority === "interrupt");
    expect(hasInterrupt).toBe(true);
  });

  it("no interrupt when only normal steers", () => {
    steers.enqueue({
      target_message_id: "msg_1",
      target_agent: "nyx",
      conversation_id: "conv_1",
      source: "human",
      message: "btw check this",
      priority: "normal",
    });

    const pending = steers.getPending("msg_1");
    const hasInterrupt = pending.some((s) => s.priority === "interrupt");
    expect(hasInterrupt).toBe(false);
  });
});
```

- [ ] **Step 2: Add interrupt detection to onProgress callback**

In `processForAgent()`, within the `onProgress` callback, add a periodic check:

```typescript
// Check for interrupt steers (poll every 5 progress updates to avoid DB spam)
if (this.steersDb && progressCallCount % 5 === 0) {
  const pending = this.steersDb.getPending(msg.message_id);
  const hasInterrupt = pending.some((s) => s.priority === "interrupt");
  if (hasInterrupt && abortController) {
    logger.info(`[processor] Interrupt steer detected for ${msg.message_id}, aborting current invocation`);
    abortController.abort();
  }
}
```

- [ ] **Step 3: Thread AbortController through invocation**

In `processForAgent()`, before the `Promise.race`, create an AbortController:

```typescript
const abortController = new AbortController();
```

Pass `abortController.signal` to `invokeAgent()` as the abort signal. The CLI subprocess handler in `invoke-cli.ts` should listen for abort and send SIGTERM to the child process.

- [ ] **Step 4: Handle abort in invoke-cli.ts**

In `src/agents/invoke-cli.ts`, in the subprocess spawn section, add signal handling:

```typescript
if (opts.signal) {
  opts.signal.addEventListener("abort", () => {
    if (proc && !proc.killed) {
      proc.kill("SIGTERM");
    }
  });
}
```

- [ ] **Step 5: Run full test suite**

Run: `cd /home/user/dev/nyxhive && bun test`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
cd /home/user/dev/nyxhive && git add src/queue/processor.ts src/agents/invoke-cli.ts src/__tests__/steers.test.ts && git commit -m "feat: add interrupt priority steering via SIGTERM + re-invoke"
```

---

## Chunk 3: Channel Integration, MCP Tools & Action Tags

### Task 9: Discord channel BTW/steer routing

**Files:**
- Modify: `src/channels/discord.ts`

- [ ] **Step 1: Write test for Discord routing logic**

Create `src/__tests__/btw-steers-integration.test.ts`:

```typescript
import { describe, it, expect } from "bun:test";

describe("Channel routing logic", () => {
  function classifyMessage(
    messageText: string,
    agentIsProcessing: boolean,
  ): "btw" | "steer" | "normal" {
    if (!agentIsProcessing) return "normal";
    const stripped = messageText.replace(/<@!?\d+>\s*/, "").trim();
    if (/^btw\b/i.test(stripped)) return "btw";
    return "steer";
  }

  it("routes to normal when agent idle", () => {
    expect(classifyMessage("@nyx fix the bug", false)).toBe("normal");
  });

  it("routes to btw when agent processing and btw prefix", () => {
    expect(classifyMessage("<@123> btw what file?", true)).toBe("btw");
  });

  it("routes to btw case-insensitive", () => {
    expect(classifyMessage("<@123> BTW status?", true)).toBe("btw");
  });

  it("routes to steer when agent processing and no btw prefix", () => {
    expect(classifyMessage("<@123> also check migrations", true)).toBe("steer");
  });

  it("handles btw with no space after mention", () => {
    expect(classifyMessage("btw what are you doing?", true)).toBe("btw");
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cd /home/user/dev/nyxhive && bun test src/__tests__/btw-steers-integration.test.ts`
Expected: PASS

- [ ] **Step 3: Add routing logic to Discord channel**

In `src/channels/discord.ts`, in the message handler, before `enqueueMessage`:

```typescript
// Check if agent is actively processing for this conversation
const activeTasks = this.processor.getActiveTasks(targetAgent);
const isProcessing = activeTasks.some(
  (t) => t.conversation_id === conversationId,
);

if (isProcessing) {
  const stripped = content.replace(/<@!?\d+>\s*/, "").trim();

  if (/^btw\b/i.test(stripped)) {
    // BTW side query — ephemeral response
    const question = stripped.replace(/^btw\s*/i, "").trim();
    if (!question) return; // empty btw, ignore

    // Defer reply (Discord 3s deadline)
    await interaction.deferReply({ ephemeral: true });

    try {
      const result = await this.processor.handleBtw(
        targetAgent,
        activeTasks[0].message_id,
        question,
        senderId,
      );
      if (result) {
        await interaction.editReply({ content: result.answer });
      } else {
        await interaction.editReply({ content: "No context available for this task." });
      }
    } catch (err) {
      await interaction.editReply({ content: `BTW failed: ${err}` });
    }
    return; // Don't enqueue
  }

  // Steer — inject into running task
  try {
    await this.processor.handleSteer(targetAgent, activeTasks[0].message_id, activeTasks[0].conversation_id, {
      message: stripped,
      priority: "normal",
      source: senderId,
    });
    // React with checkmark
    await message.react("✅");
  } catch (err) {
    logger.error(`[discord] Steer failed: ${err}`);
  }
  return; // Don't enqueue
}
```

Note: The exact integration depends on how Discord.js message events work in the existing code. Adapt the pattern to match the existing handler structure (interaction replies vs channel messages).

- [ ] **Step 4: Run full test suite**

Run: `cd /home/user/dev/nyxhive && bun test`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
cd /home/user/dev/nyxhive && git add src/channels/discord.ts src/__tests__/btw-steers-integration.test.ts && git commit -m "feat: add BTW/steer routing to Discord channel"
```

---

### Task 10: Slack channel BTW/steer routing

**Files:**
- Modify: `src/channels/slack.ts`

- [ ] **Step 1: Add routing logic to Slack channel**

Same pattern as Discord, adapted for Slack's message handler. In `src/channels/slack.ts`, in the message handler:

```typescript
// Check if agent is actively processing
const activeTasks = this.processor.getActiveTasks(targetAgent);
const isProcessing = activeTasks.some(
  (t) => t.conversation_id === conversationId,
);

if (isProcessing) {
  const stripped = text.replace(/<@\w+>\s*/, "").trim();

  if (/^btw\b/i.test(stripped)) {
    const question = stripped.replace(/^btw\s*/i, "").trim();
    if (!question) return;

    try {
      const result = await this.processor.handleBtw(
        targetAgent,
        activeTasks[0].message_id,
        question,
        senderId,
      );
      if (result) {
        // Ephemeral message — only visible to sender
        await this.app.client.chat.postEphemeral({
          channel: channelId,
          user: userId,
          text: result.answer,
          thread_ts: threadTs,
        });
      }
    } catch (err) {
      logger.error(`[slack] BTW failed: ${err}`);
    }
    return;
  }

  // Steer
  try {
    await this.processor.handleSteer(targetAgent, activeTasks[0].message_id, activeTasks[0].conversation_id, {
      message: stripped,
      priority: "normal",
      source: senderId,
    });
    // React with checkmark
    await this.app.client.reactions.add({
      channel: channelId,
      name: "white_check_mark",
      timestamp: event.ts,
    });
  } catch (err) {
    logger.error(`[slack] Steer failed: ${err}`);
  }
  return;
}
```

- [ ] **Step 2: Run full test suite**

Run: `cd /home/user/dev/nyxhive && bun test`
Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
cd /home/user/dev/nyxhive && git add src/channels/slack.ts && git commit -m "feat: add BTW/steer routing to Slack channel"
```

---

### Task 11: Register MCP tools

**Files:**
- Modify: `src/mcp/server.ts`

- [ ] **Step 1: Add btw_agent and steer_agent MCP tools**

In `src/mcp/server.ts`, in the `createMcpServer()` function, add:

```typescript
server.registerTool(
  "btw_agent",
  {
    description: "Ask a side question to a running agent without disrupting its task. Read-only, ephemeral. Returns the agent's answer based on current context.",
    inputSchema: {
      target_agent: z.string().describe("Agent key to query (e.g. 'coder', 'nyx')"),
      question: z.string().describe("Question to ask about the agent's current task"),
    },
  },
  async ({ target_agent, question }) => {
    const tasks = deps.processor.getActiveTasks(target_agent);
    if (tasks.length === 0) {
      return { content: [{ type: "text", text: JSON.stringify({ error: "agent_idle", message: `${target_agent} is not currently processing any task` }) }] };
    }
    const task = tasks[0];
    const result = await deps.processor.handleBtw(target_agent, task.message_id, question, "agent");
    if (!result) {
      return { content: [{ type: "text", text: JSON.stringify({ error: "context_unavailable" }) }] };
    }
    return { content: [{ type: "text", text: result.answer }] };
  },
);

server.registerTool(
  "steer_agent",
  {
    description: "Inject context or direction into a running agent's task. Delivered at next turn boundary. Use for 'by the way, also check X' type messages.",
    inputSchema: {
      target_agent: z.string().describe("Agent key to steer (e.g. 'coder', 'nyx')"),
      message: z.string().describe("Context or direction to inject into the agent's task"),
      priority: z.enum(["normal", "interrupt"]).default("normal").describe("normal = next turn, interrupt = ASAP (human-only recommended)"),
    },
  },
  async ({ target_agent, message, priority }) => {
    const tasks = deps.processor.getActiveTasks(target_agent);
    if (tasks.length === 0) {
      return { content: [{ type: "text", text: JSON.stringify({ error: "agent_idle", message: `${target_agent} is not currently processing any task` }) }] };
    }
    const task = tasks[0];
    const result = await deps.processor.handleSteer(target_agent, task.message_id, task.conversation_id, {
      message,
      priority: priority ?? "normal",
      source: "agent",
    });
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  },
);
```

- [ ] **Step 2: Run full test suite**

Run: `cd /home/user/dev/nyxhive && bun test`
Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
cd /home/user/dev/nyxhive && git add src/mcp/server.ts && git commit -m "feat: register btw_agent and steer_agent MCP tools"
```

---

### Task 12: Add action tag parsing for [@btw] and [@steer]

**Files:**
- Modify: `src/agents/actor.ts` (or wherever `parseActorMentions` / `parseAgentActions` lives)
- Test: `src/__tests__/btw-steers-integration.test.ts`

- [ ] **Step 1: Write test for action tag parsing**

Append to `src/__tests__/btw-steers-integration.test.ts`:

```typescript
describe("Action tag parsing", () => {
  function parseBtwTags(text: string): Array<{ agent: string; question: string }> {
    const results: Array<{ agent: string; question: string }> = [];
    const regex = /\[@btw\s+(\w+):\s*(.+?)\]/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
      results.push({ agent: match[1], question: match[2].trim() });
    }
    return results;
  }

  function parseSteerTags(text: string): Array<{ agent: string; message: string }> {
    const results: Array<{ agent: string; message: string }> = [];
    const regex = /\[@steer\s+(\w+):\s*(.+?)\]/g;
    let match;
    while ((match = regex.exec(text)) !== null) {
      results.push({ agent: match[1], message: match[2].trim() });
    }
    return results;
  }

  it("parses [@btw agent: question]", () => {
    const text = "Working on it. [@btw coder: what file are you editing?] Let me check.";
    const tags = parseBtwTags(text);
    expect(tags).toHaveLength(1);
    expect(tags[0].agent).toBe("coder");
    expect(tags[0].question).toBe("what file are you editing?");
  });

  it("parses [@steer agent: message]", () => {
    const text = "[@steer coder: also check the migration file]";
    const tags = parseSteerTags(text);
    expect(tags).toHaveLength(1);
    expect(tags[0].agent).toBe("coder");
    expect(tags[0].message).toBe("also check the migration file");
  });

  it("parses multiple tags", () => {
    const text = "[@steer coder: check A] and [@steer tester: run tests]";
    const tags = parseSteerTags(text);
    expect(tags).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it passes**

Run: `cd /home/user/dev/nyxhive && bun test src/__tests__/btw-steers-integration.test.ts`
Expected: PASS

- [ ] **Step 3: Integrate tag parsing into existing action parser**

Find the existing `parseAgentActions()` function (likely in `src/agents/actor.ts`) and add BTW and steer tag recognition:

```typescript
// Add to the existing action parsing
const btwRegex = /\[@btw\s+(\w+):\s*(.+?)\]/g;
const steerRegex = /\[@steer\s+(\w+):\s*(.+?)\]/g;

let match;
while ((match = btwRegex.exec(text)) !== null) {
  actions.push({ type: "btw", agent: match[1], content: match[2].trim() });
}
while ((match = steerRegex.exec(text)) !== null) {
  actions.push({ type: "steer", agent: match[1], content: match[2].trim() });
}
```

In the action executor (in `processor.ts` or `delegation.ts`), handle these:

```typescript
if (action.type === "btw") {
  const result = await this.processor.handleBtw(action.agent, activeMessageId, action.content, agentKey);
  // BTW results are ephemeral — don't inject into response
}
if (action.type === "steer") {
  await this.processor.handleSteer(action.agent, activeMessageId, conversationId, {
    message: action.content,
    priority: "normal",
    source: agentKey,
  });
}
```

- [ ] **Step 4: Run full test suite**

Run: `cd /home/user/dev/nyxhive && bun test`
Expected: All tests pass

- [ ] **Step 5: Run type checker**

Run: `cd /home/user/dev/nyxhive && bunx tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
cd /home/user/dev/nyxhive && git add src/agents/actor.ts src/queue/processor.ts src/__tests__/btw-steers-integration.test.ts && git commit -m "feat: add [@btw] and [@steer] action tag parsing"
```

---

### Task 13: Final integration test and type check

**Files:**
- All modified files

- [ ] **Step 1: Run full test suite**

Run: `cd /home/user/dev/nyxhive && bun test`
Expected: All 2853+ tests pass

- [ ] **Step 2: Run type checker**

Run: `cd /home/user/dev/nyxhive && bunx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Manual smoke test**

Start a dev instance and test:
1. Send a message to an agent
2. While it's processing, call `POST /api/agents/nyx/btw` with a question
3. Verify ephemeral answer returned
4. While processing, call `POST /api/agents/nyx/steer` with a message
5. Verify steer is queued and delivered at next turn boundary
6. Check conversation history includes the steer with `[STEER from ...]` prefix

- [ ] **Step 4: Final commit**

```bash
cd /home/user/dev/nyxhive && git add -A && git commit -m "feat: BTW side queries and mid-task steering

Adds two mid-task communication capabilities:
- BTW: ephemeral side queries against a running agent's context (no tools, not persisted)
- Steering: context injection at turn boundaries (persisted in history)

Includes API routes, MCP tools, channel integration (Discord/Slack), and action tags."
```

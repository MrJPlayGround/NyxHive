/**
 * Tests for notify_channels delivery on scheduled task completion and failure.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Scheduler } from "../scheduler/index.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  cron_expression TEXT,
  run_at INTEGER,
  agent TEXT NOT NULL,
  prompt TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'api',
  recipient TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at INTEGER,
  next_run_at INTEGER NOT NULL,
  last_status TEXT,
  last_error TEXT,
  last_result TEXT,
  category TEXT DEFAULT 'ops',
  run_count INTEGER NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  notify_channels TEXT,
  notify_thread_id TEXT,
  webhook_url TEXT,
  chain_to TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scheduled_next ON scheduled_tasks(enabled, next_run_at);
`;

const BASE_CONFIG = {
  daemon: { name: "test", log_level: "error", data_dir: "/tmp", owner_channel: "telegram", owner_id: "owner-123" },
  server: { port: 3000 },
  agents: {},
  teams: {},
  providers: {},
  routing: { classifier_model: "test", classifier_provider: "test", cli_escalation_tasks: [] },
  context: { max_history: 10, summary_threshold: 5 },
} as any;

function makeDb() {
  const db = new Database(":memory:");
  db.exec(SCHEMA);
  return db;
}

function makeProcessor(response: string | null = "Task completed successfully") {
  const notifications: Array<{ recipientId: string; content: string; channelName: string; replyToId?: string }> = [];
  const scheduledRunArtifacts: Array<Record<string, any>> = [];
  const telegram = {
    name: "telegram",
    sendOutbound: async (recipientId: string, content: string, _agent?: string, replyToId?: string) => {
      notifications.push({ recipientId, content, channelName: "telegram", replyToId });
    },
  };
  const discord = {
    name: "discord",
    sendOutbound: async (recipientId: string, content: string, _agent?: string, replyToId?: string) => {
      notifications.push({ recipientId, content, channelName: "discord", replyToId });
    },
  };
  return {
    notifications,
    scheduledRunArtifacts,
    emitEvent: () => {},
    processImmediate: async () => {
      if (response === null) throw new Error("Agent execution failed");
      return { response, agent: "analyst", trace_id: "trace-notify" };
    },
    shouldRunAutonomousTask: () => true,
    getInflightCount: () => 0,
    getChannels: () => [telegram, discord],
    clearCliSessionsByConvId: () => {},
    getTraces: () => ({
      recordScheduledRunArtifact: (artifact: Record<string, any>) => {
        scheduledRunArtifacts.push(artifact);
      },
    }),
  };
}

function spawnResult(exitCode: number, stdout = "", stderr = ""): ReturnType<typeof Bun.spawnSync> {
  return {
    stdout: Buffer.from(stdout),
    stderr: Buffer.from(stderr),
    exitCode,
    success: exitCode === 0,
  } as ReturnType<typeof Bun.spawnSync>;
}

let spawnSyncSpy: ReturnType<typeof spyOn<typeof Bun, "spawnSync">>;

afterEach(() => {
  spawnSyncSpy?.mockRestore();
});

// ─── Format ─────────────────────────────────────────────────────────

describe("notify_channels — format", () => {
  test("notification includes task name, outcome, and summary", async () => {
    const db = makeDb();
    const processor = makeProcessor("The analysis found 3 items worth reviewing.");
    const scheduler = new Scheduler(db, processor as any, BASE_CONFIG);

    const id = scheduler.addTask({ name: "test:task", agent: "analyst", prompt: "Run analysis", channel: "api" });
    scheduler.updateTask(id, { notify_channels: ["telegram:owner-123"] });
    await scheduler.triggerTask(id);

    expect(processor.notifications).toHaveLength(1);
    const { content } = processor.notifications[0];
    expect(content).toContain("[test:task]");
    expect(content).toContain("completed:");
    expect(content).toContain("The analysis found 3 items worth reviewing.");
  });

  test("long result is truncated to 200 chars with ellipsis", async () => {
    const db = makeDb();
    const processor = makeProcessor("A".repeat(300));
    const scheduler = new Scheduler(db, processor as any, BASE_CONFIG);

    const id = scheduler.addTask({ name: "test:task", agent: "analyst", prompt: "Run", channel: "api" });
    scheduler.updateTask(id, { notify_channels: ["telegram:owner-123"] });
    await scheduler.triggerTask(id);

    expect(processor.notifications).toHaveLength(1);
    const { content } = processor.notifications[0];
    expect(content).toContain("...");
    // Summary portion should be capped at 200 chars
    const afterColon = content.split("completed: ")[1];
    expect(afterColon.replace(/\.\.\.$/, "")).toHaveLength(200);
  });

  test("short result has no ellipsis", async () => {
    const db = makeDb();
    const processor = makeProcessor("Short result.");
    const scheduler = new Scheduler(db, processor as any, BASE_CONFIG);

    const id = scheduler.addTask({ name: "test:task", agent: "analyst", prompt: "Run", channel: "api" });
    scheduler.updateTask(id, { notify_channels: ["telegram:owner-123"] });
    await scheduler.triggerTask(id);

    expect(processor.notifications).toHaveLength(1);
    expect(processor.notifications[0].content).not.toContain("...");
    expect(processor.notifications[0].content).toContain("Short result.");
  });

  test("briefing task sends the full digest directly", async () => {
    const db = makeDb();
    const briefing = `# Morning Briefing\n\n${"A".repeat(300)}`;
    const processor = makeProcessor(briefing);
    const scheduler = new Scheduler(db, processor as any, BASE_CONFIG);

    const id = scheduler.addTask({ name: "briefing:daily", agent: "analyst", prompt: "Run", channel: "api" });
    scheduler.updateTask(id, { notify_channels: ["telegram:owner-123"] });
    await scheduler.triggerTask(id);

    expect(processor.notifications).toHaveLength(1);
    expect(processor.notifications[0].content).toBe(briefing);
  });

  test("self-improvement task sends the full report directly", async () => {
    const db = makeDb();
    const report = `What I did: tightened memory ranking.\n\n${"A".repeat(320)}`;
    const processor = makeProcessor(report);
    const scheduler = new Scheduler(
      db,
      processor as any,
      {
        ...BASE_CONFIG,
        daemon: {
          ...BASE_CONFIG.daemon,
          projects: [{ name: "nyxhive", repo_path: "/repo/nyxhive", default: true }],
        },
      },
    );
    spawnSyncSpy = spyOn(Bun, "spawnSync")
      .mockReturnValueOnce(spawnResult(0, "master\n"))
      .mockReturnValueOnce(spawnResult(0, ""))
      .mockReturnValueOnce(spawnResult(0, "0 0\n"));

    const id = scheduler.addTask({
      name: "evolution:hourly-self-improvement",
      agent: "nyx",
      prompt: "Run self-improvement",
      channel: "scheduler",
      cron_expression: "0 * * * *",
      notify_channels: ["telegram:owner-123"],
    });
    await scheduler.triggerTask(id);

    expect(processor.notifications).toHaveLength(1);
    expect(processor.notifications[0].content).toBe(report);
  });

  test("self-improvement no-op still sends a report instead of being suppressed", async () => {
    const db = makeDb();
    const report = "Nothing to report.";
    const processor = makeProcessor(report);
    const scheduler = new Scheduler(
      db,
      processor as any,
      {
        ...BASE_CONFIG,
        daemon: {
          ...BASE_CONFIG.daemon,
          projects: [{ name: "nyxhive", repo_path: "/repo/nyxhive", default: true }],
        },
      },
    );
    spawnSyncSpy = spyOn(Bun, "spawnSync")
      .mockReturnValueOnce(spawnResult(0, "master\n"))
      .mockReturnValueOnce(spawnResult(0, ""))
      .mockReturnValueOnce(spawnResult(0, "0 0\n"));

    const id = scheduler.addTask({
      name: "evolution:hourly-self-improvement",
      agent: "nyx",
      prompt: "Run self-improvement",
      channel: "scheduler",
      cron_expression: "0 * * * *",
      notify_channels: ["telegram:owner-123"],
    });
    await scheduler.triggerTask(id);

    const task = db.query("SELECT last_result FROM scheduled_tasks WHERE id = ?").get(id) as { last_result: string | null };
    expect(processor.notifications).toHaveLength(1);
    expect(processor.notifications[0].content).toBe(report);
    expect(task.last_result).toBe(report);
  });

  test("heartbeat notification repeats are suppressed by result signature", async () => {
    const db = makeDb();
    const processor = makeProcessor("Disk pressure still at 91%.");
    const scheduler = new Scheduler(db, processor as any, BASE_CONFIG);

    const id = scheduler.addTask({
      name: "heartbeat:presence",
      agent: "analyst",
      prompt: "Run heartbeat",
      channel: "api",
      cron_expression: "*/10 * * * *",
      notify_channels: ["telegram:owner-123"],
    });

    await scheduler.triggerTask(id);
    await scheduler.triggerTask(id);

    expect(processor.notifications).toHaveLength(1);
    expect(processor.scheduledRunArtifacts).toHaveLength(2);
    expect(processor.scheduledRunArtifacts[0]).toMatchObject({
      notified: true,
      suppressionReason: null,
    });
    expect(processor.scheduledRunArtifacts[1]).toMatchObject({
      notified: false,
      suppressionReason: "duplicate_signature",
    });
    const task = db.query("SELECT last_notification_signature, last_notified_at FROM scheduled_tasks WHERE id = ?").get(id) as {
      last_notification_signature: string | null;
      last_notified_at: number | null;
    };
    expect(task.last_notification_signature).toBeString();
    expect(task.last_notified_at).toBeNumber();
  });

  test("failed completed-result notification is not recorded as notified", async () => {
    const db = makeDb();
    const brokenTelegram = {
      name: "telegram",
      sendOutbound: async () => { throw new Error("Telegram message is too long"); },
    };
    const scheduledRunArtifacts: Array<Record<string, any>> = [];
    const processor = {
      emitEvent: () => {},
      processImmediate: async () => ({ response: "Useful report", agent: "analyst", trace_id: "trace-notify" }),
      shouldRunAutonomousTask: () => true,
      getInflightCount: () => 0,
      getChannels: () => [brokenTelegram],
      clearCliSessionsByConvId: () => {},
      getTraces: () => ({
        recordScheduledRunArtifact: (artifact: Record<string, any>) => {
          scheduledRunArtifacts.push(artifact);
        },
      }),
    };
    const scheduler = new Scheduler(db, processor as any, BASE_CONFIG);

    const id = scheduler.addTask({
      name: "heartbeat:presence",
      agent: "analyst",
      prompt: "Run heartbeat",
      channel: "api",
      cron_expression: "*/10 * * * *",
      notify_channels: ["telegram:owner-123"],
    });
    await scheduler.triggerTask(id);

    expect(scheduledRunArtifacts).toHaveLength(1);
    expect(scheduledRunArtifacts[0]).toMatchObject({
      notified: false,
      suppressionReason: "delivery_failed",
    });
    const task = db.query("SELECT last_notification_signature, last_notified_at FROM scheduled_tasks WHERE id = ?").get(id) as {
      last_notification_signature: string | null;
      last_notified_at: number | null;
    };
    expect(task.last_notification_signature).toBeNull();
    expect(task.last_notified_at).toBeNull();
  });

  test("long digest notifications are bounded for telegram delivery", async () => {
    const db = makeDb();
    const report = `# Morning Briefing\n\n${"A".repeat(5000)}`;
    const processor = makeProcessor(report);
    const scheduler = new Scheduler(db, processor as any, BASE_CONFIG);

    const id = scheduler.addTask({
      name: "briefing:daily",
      agent: "analyst",
      prompt: "Run briefing",
      channel: "api",
      notify_channels: ["telegram:owner-123"],
    });
    await scheduler.triggerTask(id);

    const task = db.query("SELECT last_result FROM scheduled_tasks WHERE id = ?").get(id) as { last_result: string | null };
    expect(processor.notifications).toHaveLength(1);
    expect(processor.notifications[0].content.length).toBeLessThanOrEqual(3900);
    expect(processor.notifications[0].content).toContain("truncated");
    expect(task.last_result).toStartWith("# Morning Briefing");
    expect(task.last_result?.length).toBeGreaterThan(processor.notifications[0].content.length);
  });
});

// ─── Routing ─────────────────────────────────────────────────────────

describe("notify_channels — routing", () => {
  test("channel:recipientId format routes to correct channel and recipient", async () => {
    const db = makeDb();
    const processor = makeProcessor("Done.");
    const scheduler = new Scheduler(db, processor as any, BASE_CONFIG);

    const id = scheduler.addTask({ name: "test:task", agent: "analyst", prompt: "Run", channel: "api" });
    scheduler.updateTask(id, { notify_channels: ["telegram:user-456"] });
    await scheduler.triggerTask(id);

    expect(processor.notifications).toHaveLength(1);
    expect(processor.notifications[0].channelName).toBe("telegram");
    expect(processor.notifications[0].recipientId).toBe("user-456");
  });

  test("plain channel name falls back to daemon.owner_id", async () => {
    const db = makeDb();
    const processor = makeProcessor("Done.");
    const scheduler = new Scheduler(db, processor as any, BASE_CONFIG);

    const id = scheduler.addTask({ name: "test:task", agent: "analyst", prompt: "Run", channel: "api" });
    scheduler.updateTask(id, { notify_channels: ["telegram"] });
    await scheduler.triggerTask(id);

    expect(processor.notifications).toHaveLength(1);
    expect(processor.notifications[0].recipientId).toBe("owner-123");
  });

  test("plain channel name with no owner_id configured is skipped silently", async () => {
    const db = makeDb();
    const processor = makeProcessor("Done.");
    const configWithoutOwner = { ...BASE_CONFIG, daemon: { ...BASE_CONFIG.daemon, owner_id: undefined } };
    const scheduler = new Scheduler(db, processor as any, configWithoutOwner);

    const id = scheduler.addTask({ name: "test:task", agent: "analyst", prompt: "Run", channel: "api" });
    scheduler.updateTask(id, { notify_channels: ["telegram"] });
    await scheduler.triggerTask(id);

    expect(processor.notifications).toHaveLength(0);
  });

  test("multiple targets all receive notification", async () => {
    const db = makeDb();
    const processor = makeProcessor("Done.");
    const scheduler = new Scheduler(db, processor as any, BASE_CONFIG);

    const id = scheduler.addTask({ name: "test:task", agent: "analyst", prompt: "Run", channel: "api" });
    scheduler.updateTask(id, { notify_channels: ["telegram:user-1", "discord:channel-2"] });
    await scheduler.triggerTask(id);

    expect(processor.notifications).toHaveLength(2);
    const channels = processor.notifications.map(n => n.channelName).sort();
    expect(channels).toEqual(["discord", "telegram"]);
  });

  test("task without notify_channels sends no notifications", async () => {
    const db = makeDb();
    const processor = makeProcessor("Done.");
    const scheduler = new Scheduler(db, processor as any, BASE_CONFIG);

    const id = scheduler.addTask({ name: "test:task", agent: "analyst", prompt: "Run", channel: "api" });
    await scheduler.triggerTask(id);

    expect(processor.notifications).toHaveLength(0);
  });
});

// ─── Failure path ────────────────────────────────────────────────────

describe("notify_channels — failure path", () => {
  test("failed task sends notification with outcome=failed", async () => {
    const db = makeDb();
    const processor = makeProcessor(null); // throws
    const scheduler = new Scheduler(db, processor as any, BASE_CONFIG);

    const id = scheduler.addTask({ name: "test:task", agent: "analyst", prompt: "Run", channel: "api" });
    scheduler.updateTask(id, { notify_channels: ["telegram:owner-123"] });
    await scheduler.triggerTask(id);

    expect(processor.notifications).toHaveLength(1);
    const { content } = processor.notifications[0];
    expect(content).toContain("[test:task]");
    expect(content).toContain("failed:");
    expect(content).toContain("Agent execution failed");
  });

  test("failed notification delivery does not propagate or block the run", async () => {
    const db = makeDb();
    const brokenTelegram = {
      name: "telegram",
      sendOutbound: async () => { throw new Error("Channel unreachable"); },
    };
    const processor = {
      notifications: [] as unknown[],
      emitEvent: () => {},
      processImmediate: async () => { throw new Error("Agent execution failed"); },
      shouldRunAutonomousTask: () => true,
      getChannels: () => [brokenTelegram],
      clearCliSessionsByConvId: () => {},
    };
    const scheduler = new Scheduler(db, processor as any, BASE_CONFIG);

    const id = scheduler.addTask({ name: "test:task", agent: "analyst", prompt: "Run", channel: "api" });
    scheduler.updateTask(id, { notify_channels: ["telegram:owner-123"] });
    // Should not throw even though both execution and notification fail
    await expect(scheduler.triggerTask(id)).resolves.toBeUndefined();
  });
});

// ─── Reply threading ────────────────────────────────────────────────

describe("notify_channels — reply threading", () => {
  test("notify_thread_id is passed as replyToId to sendOutbound", async () => {
    const db = makeDb();
    const processor = makeProcessor("Done.");
    const scheduler = new Scheduler(db, processor as any, BASE_CONFIG);

    const id = scheduler.addTask({ name: "test:reply", agent: "analyst", prompt: "Run", channel: "api", notify_channels: ["telegram:owner-123"], notify_thread_id: "99887" });
    await scheduler.triggerTask(id);

    expect(processor.notifications).toHaveLength(1);
    expect(processor.notifications[0].replyToId).toBe("99887");
  });

  test("without notify_thread_id, replyToId is undefined", async () => {
    const db = makeDb();
    const processor = makeProcessor("Done.");
    const scheduler = new Scheduler(db, processor as any, BASE_CONFIG);

    const id = scheduler.addTask({ name: "test:noreply", agent: "analyst", prompt: "Run", channel: "api", notify_channels: ["telegram:owner-123"] });
    await scheduler.triggerTask(id);

    expect(processor.notifications).toHaveLength(1);
    expect(processor.notifications[0].replyToId).toBeUndefined();
  });

  test("notify_thread_id set via updateTask is used", async () => {
    const db = makeDb();
    const processor = makeProcessor("Done.");
    const scheduler = new Scheduler(db, processor as any, BASE_CONFIG);

    const id = scheduler.addTask({ name: "test:update-reply", agent: "analyst", prompt: "Run", channel: "api" });
    scheduler.updateTask(id, { notify_channels: ["discord:chan-1"], notify_thread_id: "msg-42" });
    await scheduler.triggerTask(id);

    expect(processor.notifications).toHaveLength(1);
    expect(processor.notifications[0].replyToId).toBe("msg-42");
    expect(processor.notifications[0].channelName).toBe("discord");
  });
});

// ─── Webhook delivery ────────────────────────────────────────────────

describe("webhook_url — task-level webhooks", () => {
  test("completion fires POST to webhook_url with task_name, outcome, summary, completed_at", async () => {
    const webhookCalls: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];
    const origFetch = globalThis.fetch;
    (globalThis as any).fetch = async (url: string | Request | URL, init?: RequestInit) => {
      webhookCalls.push({
        url: String(url),
        body: JSON.parse(init?.body as string),
        headers: init?.headers as Record<string, string>,
      });
      return new Response(null, { status: 200 });
    };

    try {
      const db = makeDb();
      const processor = makeProcessor("Analysis complete: 3 issues found.");
      const scheduler = new Scheduler(db, processor as any, BASE_CONFIG);

      const id = scheduler.addTask({ name: "nightly:scan", agent: "analyst", prompt: "Run scan", channel: "api", webhook_url: "https://example.com/hook" });
      await scheduler.triggerTask(id);
      // Allow microtask queue to flush so fire-and-forget resolves
      await new Promise(r => setTimeout(r, 10));

      expect(webhookCalls).toHaveLength(1);
      expect(webhookCalls[0].url).toBe("https://example.com/hook");
      expect(webhookCalls[0].body.task_name).toBe("nightly:scan");
      expect(webhookCalls[0].body.outcome).toBe("completed");
      expect(webhookCalls[0].body.summary).toContain("Analysis complete");
      expect(webhookCalls[0].body.completed_at).toBeTruthy();
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("failure fires POST to webhook_url with outcome=failed", async () => {
    const webhookCalls: { body: Record<string, unknown> }[] = [];
    const origFetch = globalThis.fetch;
    (globalThis as any).fetch = async (_url: string | Request | URL, init?: RequestInit) => {
      webhookCalls.push({ body: JSON.parse(init?.body as string) });
      return new Response(null, { status: 200 });
    };

    try {
      const db = makeDb();
      const processor = makeProcessor(null); // throws
      const scheduler = new Scheduler(db, processor as any, BASE_CONFIG);

      const id = scheduler.addTask({ name: "nightly:scan", agent: "analyst", prompt: "Run", channel: "api", webhook_url: "https://example.com/hook" });
      await scheduler.triggerTask(id);
      await new Promise(r => setTimeout(r, 10));

      expect(webhookCalls).toHaveLength(1);
      expect(webhookCalls[0].body.outcome).toBe("failed");
      expect(webhookCalls[0].body.task_name).toBe("nightly:scan");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("Authorization header included when daemon.webhook_secret is configured", async () => {
    const webhookCalls: { headers: Record<string, string> }[] = [];
    const origFetch = globalThis.fetch;
    (globalThis as any).fetch = async (_url: string | Request | URL, init?: RequestInit) => {
      webhookCalls.push({ headers: init?.headers as Record<string, string> });
      return new Response(null, { status: 200 });
    };

    try {
      const db = makeDb();
      const processor = makeProcessor("Done.");
      const configWithSecret = { ...BASE_CONFIG, daemon: { ...BASE_CONFIG.daemon, webhook_secret: "my-secret" } };
      const scheduler = new Scheduler(db, processor as any, configWithSecret);

      const id = scheduler.addTask({ name: "test:task", agent: "analyst", prompt: "Run", channel: "api", webhook_url: "https://example.com/hook" });
      await scheduler.triggerTask(id);
      await new Promise(r => setTimeout(r, 10));

      expect(webhookCalls).toHaveLength(1);
      expect(webhookCalls[0].headers["Authorization"]).toBe("Bearer my-secret");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("no webhook when webhook_url is not set", async () => {
    let fetchCalled = false;
    const origFetch = globalThis.fetch;
    (globalThis as any).fetch = async () => {
      fetchCalled = true;
      return new Response(null, { status: 200 });
    };

    try {
      const db = makeDb();
      const processor = makeProcessor("Done.");
      const scheduler = new Scheduler(db, processor as any, BASE_CONFIG);

      const id = scheduler.addTask({ name: "test:task", agent: "analyst", prompt: "Run", channel: "api" });
      await scheduler.triggerTask(id);
      await new Promise(r => setTimeout(r, 10));

      expect(fetchCalled).toBe(false);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("webhook failure does not propagate or block task execution", async () => {
    const origFetch = globalThis.fetch;
    (globalThis as any).fetch = async () => { throw new Error("Network error"); };

    try {
      const db = makeDb();
      const processor = makeProcessor("Done.");
      const scheduler = new Scheduler(db, processor as any, BASE_CONFIG);

      const id = scheduler.addTask({ name: "test:task", agent: "analyst", prompt: "Run", channel: "api", webhook_url: "https://example.com/hook" });
      await expect(scheduler.triggerTask(id)).resolves.toBeUndefined();
      await new Promise(r => setTimeout(r, 10));
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("webhook_url set via updateTask is used", async () => {
    const webhookCalls: { body: Record<string, unknown> }[] = [];
    const origFetch = globalThis.fetch;
    (globalThis as any).fetch = async (_url: string | Request | URL, init?: RequestInit) => {
      webhookCalls.push({ body: JSON.parse(init?.body as string) });
      return new Response(null, { status: 200 });
    };

    try {
      const db = makeDb();
      const processor = makeProcessor("Done.");
      const scheduler = new Scheduler(db, processor as any, BASE_CONFIG);

      const id = scheduler.addTask({ name: "test:task", agent: "analyst", prompt: "Run", channel: "api" });
      scheduler.updateTask(id, { webhook_url: "https://example.com/hook" });
      await scheduler.triggerTask(id);
      await new Promise(r => setTimeout(r, 10));

      expect(webhookCalls).toHaveLength(1);
      expect(webhookCalls[0].body.task_name).toBe("test:task");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test.each([
    ["localhost", "http://localhost:9000/hook"],
  ])("%s webhook_url is blocked", async (_label, webhookUrl) => {
    let fetchCalled = false;
    const origFetch = globalThis.fetch;
    (globalThis as any).fetch = async () => {
      fetchCalled = true;
      return new Response(null, { status: 200 });
    };

    try {
      const db = makeDb();
      const processor = makeProcessor("Done.");
      const scheduler = new Scheduler(db, processor as any, BASE_CONFIG);

      const id = scheduler.addTask({
        name: "test:blocked-webhook",
        agent: "analyst",
        prompt: "Run",
        channel: "api",
        webhook_url: webhookUrl,
      });
      await scheduler.triggerTask(id);
      await new Promise(r => setTimeout(r, 10));

      expect(fetchCalled).toBe(false);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

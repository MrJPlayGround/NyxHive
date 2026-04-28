/**
 * Tests for the processor-level global webhook: fireWebhook() fires on
 * delegation completion/failure when daemon.webhook_url is configured.
 */
import { describe, test, expect } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QueueProcessor } from "../queue/processor.js";
import { QueueDB } from "../queue/db.js";
import type { NyxHiveConfig } from "../types.js";

function makeProcessor(webhookUrl?: string, webhookSecret?: string) {
  const dataDir = mkdtempSync(join(tmpdir(), "nyx-webhook-test-"));
  const db = new QueueDB(dataDir);
  const nyxhiveConfig = webhookUrl
    ? ({
        daemon: {
          name: "test",
          log_level: "error",
          data_dir: dataDir,
          webhook_url: webhookUrl,
          webhook_secret: webhookSecret,
        },
      } as unknown as NyxHiveConfig)
    : undefined;
  return new QueueProcessor(db, {
    agents: {},
    teams: {},
    baseDir: dataDir,
    nyxhiveConfig,
  });
}

describe("processor — fireWebhook", () => {
  test("fires POST to webhook_url on completed with correct payload", async () => {
    const calls: { url: string; body: Record<string, unknown>; headers: Record<string, string> }[] = [];
    const origFetch = globalThis.fetch;
    (globalThis as any).fetch = async (url: string | Request | URL, init?: RequestInit) => {
      calls.push({
        url: String(url),
        body: JSON.parse(init?.body as string),
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      return new Response(null, { status: 200 });
    };

    try {
      const processor = makeProcessor("https://example.com/webhook");
      (processor as any).fireWebhook("completed", "Build nyx CLI", "Done — commit abc123");
      await new Promise(r => setTimeout(r, 10));

      expect(calls).toHaveLength(1);
      expect(calls[0].url).toBe("https://example.com/webhook");
      expect(calls[0].body.task_name).toBe("Build nyx CLI");
      expect(calls[0].body.outcome).toBe("completed");
      expect(calls[0].body.summary).toBe("Done — commit abc123");
      expect(calls[0].body.completed_at).toBeTruthy();
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("fires POST with outcome=failed on delegation failure", async () => {
    const calls: { body: Record<string, unknown> }[] = [];
    const origFetch = globalThis.fetch;
    (globalThis as any).fetch = async (_url: string | Request | URL, init?: RequestInit) => {
      calls.push({ body: JSON.parse(init?.body as string) });
      return new Response(null, { status: 200 });
    };

    try {
      const processor = makeProcessor("https://example.com/webhook");
      (processor as any).fireWebhook("failed", "Run backtest", "Agent timed out");
      await new Promise(r => setTimeout(r, 10));

      expect(calls).toHaveLength(1);
      expect(calls[0].body.outcome).toBe("failed");
      expect(calls[0].body.task_name).toBe("Run backtest");
      expect(calls[0].body.summary).toBe("Agent timed out");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("includes Authorization: Bearer header when webhook_secret is set", async () => {
    const calls: { headers: Record<string, string> }[] = [];
    const origFetch = globalThis.fetch;
    (globalThis as any).fetch = async (_url: string | Request | URL, init?: RequestInit) => {
      calls.push({ headers: (init?.headers ?? {}) as Record<string, string> });
      return new Response(null, { status: 200 });
    };

    try {
      const processor = makeProcessor("https://example.com/webhook", "secret-abc");
      (processor as any).fireWebhook("completed", "task", "result");
      await new Promise(r => setTimeout(r, 10));

      expect(calls).toHaveLength(1);
      expect(calls[0].headers["Authorization"]).toBe("Bearer secret-abc");
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("does not fire when webhook_url is not configured", async () => {
    let fetchCalled = false;
    const origFetch = globalThis.fetch;
    (globalThis as any).fetch = async () => {
      fetchCalled = true;
      return new Response(null, { status: 200 });
    };

    try {
      const processor = makeProcessor(); // no webhook_url
      (processor as any).fireWebhook("completed", "task", "result");
      await new Promise(r => setTimeout(r, 10));

      expect(fetchCalled).toBe(false);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("does not fire for localhost webhook_url", async () => {
    let fetchCalled = false;
    const origFetch = globalThis.fetch;
    (globalThis as any).fetch = async () => {
      fetchCalled = true;
      return new Response(null, { status: 200 });
    };

    try {
      const processor = makeProcessor("http://localhost:9000/webhook");
      (processor as any).fireWebhook("completed", "task", "result");
      await new Promise(r => setTimeout(r, 10));

      expect(fetchCalled).toBe(false);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("webhook failure is silently swallowed and does not throw", async () => {
    const origFetch = globalThis.fetch;
    (globalThis as any).fetch = async () => { throw new Error("Connection refused"); };

    try {
      const processor = makeProcessor("https://example.com/webhook");
      // Should not throw
      expect(() => (processor as any).fireWebhook("completed", "task", "result")).not.toThrow();
      await new Promise(r => setTimeout(r, 10));
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("task_name is truncated to 200 chars in payload", async () => {
    const calls: { body: Record<string, unknown> }[] = [];
    const origFetch = globalThis.fetch;
    (globalThis as any).fetch = async (_url: string | Request | URL, init?: RequestInit) => {
      calls.push({ body: JSON.parse(init?.body as string) });
      return new Response(null, { status: 200 });
    };

    try {
      const processor = makeProcessor("https://example.com/webhook");
      const longDesc = "A".repeat(300);
      (processor as any).fireWebhook("completed", longDesc, "result");
      await new Promise(r => setTimeout(r, 10));

      expect(calls).toHaveLength(1);
      expect((calls[0].body.task_name as string).length).toBe(200);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

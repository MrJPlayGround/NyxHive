import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createHmac } from "crypto";
import { WebhookChannel } from "../channels/webhook.js";
import { QueueDB } from "../queue/db.js";
import type { NyxHiveConfig } from "../types.js";

const TEST_SECRET_ENV = "TEST_GH_SECRET";
const TEST_SECRET = "test-webhook-secret-123";

function sign(body: string, secret: string = TEST_SECRET): string {
  const hmac = createHmac("sha256", secret);
  hmac.update(body);
  return `sha256=${hmac.digest("hex")}`;
}

function makeConfig(override?: Partial<NyxHiveConfig["webhook"]>): NyxHiveConfig {
  return {
    daemon: { name: "test", log_level: "error", data_dir: "/tmp" },
    server: { port: 3000 },
    agents: {
      nyx: { name: "Nyx", provider: "test", model: "test", working_directory: "/tmp" },
    },
    providers: {},
    routing: { classifier_model: "test", classifier_provider: "test", cli_escalation_tasks: [] },
    context: { max_history: 10, summary_threshold: 5 },
    webhook: {
      enabled: true,
      sources: {
        github: {
          secret_env: TEST_SECRET_ENV,
          events: ["pull_request.opened", "pull_request.reopened", "issues.opened", "issue_comment.created"],
          agent: "nyx",
          repos: ["nyxhive"],
        },
      },
      ...override,
    },
  } as NyxHiveConfig;
}

const prPayload = {
  action: "opened",
  number: 42,
  pull_request: {
    title: "Fix auth token refresh",
    user: { login: "contributor" },
    html_url: "https://github.com/AgentNyxAI/nyxhive/pull/42",
    head: { ref: "feature/fix-auth-refresh" },
    base: { ref: "main" },
    changed_files: 3,
  },
  repository: { name: "nyxhive", full_name: "AgentNyxAI/nyxhive" },
};

const prHeaders = (body: string, deliveryId = "abc-123") => ({
  "x-github-event": "pull_request",
  "x-github-delivery": deliveryId,
  "x-hub-signature-256": sign(body),
  "content-type": "application/json",
});

describe("WebhookChannel — interface", () => {
  let tmpDir: string;
  let queue: QueueDB;
  let channel: WebhookChannel;

  beforeEach(() => {
    process.env[TEST_SECRET_ENV] = TEST_SECRET;
    tmpDir = mkdtempSync(join(tmpdir(), "nyxhive-webhook-test-"));
    queue = new QueueDB(tmpDir);
    channel = new WebhookChannel({ config: makeConfig(), queue, processor: {} as never });
  });

  afterEach(() => {
    delete process.env[TEST_SECRET_ENV];
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("has name = 'webhook'", () => {
    expect(channel.name).toBe("webhook");
  });

  it("is not connected before start", () => {
    expect(channel.isConnected()).toBe(false);
  });

  it("is connected after start", async () => {
    await channel.start();
    expect(channel.isConnected()).toBe(true);
    await channel.stop();
  });

  it("is not connected after stop", async () => {
    await channel.start();
    await channel.stop();
    expect(channel.isConnected()).toBe(false);
  });

  it("stats start at zero", () => {
    const stats = channel.getStats();
    expect(stats.messagesReceived).toBe(0);
    expect(stats.messagesSent).toBe(0);
    expect(stats.errors).toBe(0);
  });

  it("getStats returns a copy (not live ref)", async () => {
    const stats1 = channel.getStats();
    stats1.messagesReceived = 999;
    const stats2 = channel.getStats();
    expect(stats2.messagesReceived).toBe(0);
  });
});

describe("WebhookChannel.hasSource", () => {
  let tmpDir: string;
  let queue: QueueDB;

  beforeEach(() => {
    process.env[TEST_SECRET_ENV] = TEST_SECRET;
    tmpDir = mkdtempSync(join(tmpdir(), "nyxhive-webhook-test-"));
    queue = new QueueDB(tmpDir);
  });

  afterEach(() => {
    delete process.env[TEST_SECRET_ENV];
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns true for a configured known source", () => {
    const channel = new WebhookChannel({ config: makeConfig(), queue, processor: {} as never });
    expect(channel.hasSource("github")).toBe(true);
  });

  it("returns false for an unknown source name", () => {
    const channel = new WebhookChannel({ config: makeConfig(), queue, processor: {} as never });
    expect(channel.hasSource("gitlab")).toBe(false);
  });

  it("returns false when webhook config has no sources", () => {
    const config = makeConfig({ enabled: true, sources: undefined });
    const channel = new WebhookChannel({ config, queue, processor: {} as never });
    expect(channel.hasSource("github")).toBe(false);
  });

  it("returns false when webhook config is undefined", () => {
    const config = { ...makeConfig(), webhook: undefined } as NyxHiveConfig;
    const channel = new WebhookChannel({ config, queue, processor: {} as never });
    expect(channel.hasSource("github")).toBe(false);
  });
});

describe("WebhookChannel.handleRequest — integration", () => {
  let tmpDir: string;
  let queue: QueueDB;
  let channel: WebhookChannel;

  beforeEach(async () => {
    process.env[TEST_SECRET_ENV] = TEST_SECRET;
    tmpDir = mkdtempSync(join(tmpdir(), "nyxhive-webhook-test-"));
    queue = new QueueDB(tmpDir);
    channel = new WebhookChannel({ config: makeConfig(), queue, processor: {} as never });
    await channel.start();
  });

  afterEach(async () => {
    await channel.stop();
    delete process.env[TEST_SECRET_ENV];
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("valid GitHub PR event → enqueues message and returns 200", async () => {
    const body = JSON.stringify(prPayload);
    const headers = prHeaders(body, "delivery-001");

    const result = await channel.handleRequest("github", headers, body);
    expect(result.status).toBe(200);
    expect(result.body).toContain("processed");

    const stats = channel.getStats();
    expect(stats.messagesReceived).toBe(1);
  });

  it("invalid signature → returns 401 and increments errors", async () => {
    const body = JSON.stringify(prPayload);
    const headers = {
      ...prHeaders(body, "delivery-002"),
      "x-hub-signature-256": "sha256=badhash",
    };

    const result = await channel.handleRequest("github", headers, body);
    expect(result.status).toBe(401);

    const stats = channel.getStats();
    expect(stats.errors).toBe(1);
    expect(stats.messagesReceived).toBe(0);
  });

  it("unknown source → returns 404", async () => {
    const body = JSON.stringify(prPayload);
    const result = await channel.handleRequest("gitlab", {}, body);
    expect(result.status).toBe(404);
  });

  it("missing secret env var → returns 500", async () => {
    const savedSecret = process.env[TEST_SECRET_ENV];
    delete process.env[TEST_SECRET_ENV];

    const body = JSON.stringify(prPayload);
    const headers = prHeaders(body, "delivery-003");

    const result = await channel.handleRequest("github", headers, body);
    expect(result.status).toBe(500);

    process.env[TEST_SECRET_ENV] = savedSecret;
  });

  it("duplicate delivery ID within 60s → returns 200 but does NOT re-enqueue", async () => {
    const body = JSON.stringify(prPayload);
    const headers = prHeaders(body, "delivery-dup-001");

    const first = await channel.handleRequest("github", headers, body);
    expect(first.status).toBe(200);

    const second = await channel.handleRequest("github", headers, body);
    expect(second.status).toBe(200);

    // Only one message enqueued
    const stats = channel.getStats();
    expect(stats.messagesReceived).toBe(1);
  });

  it("event not in config.events → returns 200, no enqueue", async () => {
    // push event is not in the config
    const pushPayload = { ref: "refs/heads/main", repository: { name: "nyxhive" } };
    const body = JSON.stringify(pushPayload);
    const headers = {
      "x-github-event": "push",
      "x-github-delivery": "delivery-push-001",
      "x-hub-signature-256": sign(body),
    };

    const result = await channel.handleRequest("github", headers, body);
    expect(result.status).toBe(200);

    const stats = channel.getStats();
    expect(stats.messagesReceived).toBe(0);
  });

  it("valid PR event increments messagesReceived stat", async () => {
    const body1 = JSON.stringify(prPayload);
    const body2 = JSON.stringify({ ...prPayload, number: 43 });

    await channel.handleRequest("github", prHeaders(body1, "d-001"), body1);
    await channel.handleRequest("github", prHeaders(body2, "d-002"), body2);

    expect(channel.getStats().messagesReceived).toBe(2);
  });

  it("31st request from same source returns 429", async () => {
    // Rate limit is keyed on the source name ("webhook:github"), not the delivery ID.
    // Use unique delivery IDs per request to avoid the dedup check triggering first.
    let lastResult: Awaited<ReturnType<typeof channel.handleRequest>> | undefined;

    for (let i = 0; i < 31; i++) {
      const body = JSON.stringify({ ...prPayload, number: 100 + i });
      const headers = prHeaders(body, `rate-limit-delivery-${i}`);
      lastResult = await channel.handleRequest("github", headers, body);
    }

    expect(lastResult?.status).toBe(429);
  });

  it("exact re-delivery (same delivery ID + same payload) → caught by dedup", async () => {
    const deliveryId = "dedup-stability-001";
    const body = JSON.stringify(prPayload);

    // First delivery
    const first = await channel.handleRequest("github", prHeaders(body, deliveryId), body);
    expect(first.status).toBe(200);
    expect(first.body).toContain("processed");

    // Exact re-delivery — same payload, same delivery ID
    const second = await channel.handleRequest("github", prHeaders(body, deliveryId), body);
    expect(second.status).toBe(200);
    expect(second.body).toContain("Duplicate");

    // Only one message was actually enqueued
    expect(channel.getStats().messagesReceived).toBe(1);
  });
});

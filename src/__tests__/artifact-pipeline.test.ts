import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { QueueDB } from "../queue/db.js";
import { QueueProcessor } from "../queue/processor.js";
import { DelegationRunStore } from "../runs/store.js";
import { statusRoutes } from "../server/routes/status.js";
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

function createRouter(response = "artifact handled") {
  return {
    classifyLocal: () => "conversation",
    route: () => ({
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
      taskType: "conversation",
      maxTokens: 256,
    }),
    routeWithTier: () => ({
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
      taskType: "conversation",
      maxTokens: 256,
    }),
    complete: mock(async () => ({
      content: response,
      model: "claude-haiku-4-5-20251001",
      provider: "anthropic",
      tokensIn: 12,
      tokensOut: 8,
    })),
  } as any;
}

describe("artifact pipeline v0", () => {
  let tmpDir: string;
  let queue: QueueDB;
  let runs: DelegationRunStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "artifact-pipeline-test-"));
    queue = new QueueDB(tmpDir);
    runs = new DelegationRunStore(tmpDir, "runs-test");
  });

  afterEach(() => {
    queue.close();
    runs?.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("processImmediate persists inbound files as durable artifacts linked to the run", async () => {
    const processor = new QueueProcessor(queue, {
      agents: {
        nyx: {
          name: "nyx",
          role: "lead",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          working_directory: tmpDir,
        },
      },
      teams: {},
      baseDir: tmpDir,
      defaultAgent: "nyx",
      router: createRouter(),
      runs,
    });

    const result = await processor.processImmediate({
      channel: "api",
      sender: "api",
      sender_id: "api_key",
      message: "inspect this file",
      files: [
        {
          name: "note.txt",
          mimeType: "text/plain",
          base64: Buffer.from("artifact boundary").toString("base64"),
          size: 17,
        },
      ],
    });

    const artifacts = runs.listArtifacts({ message_id: result.message_id });
    expect(artifacts).toHaveLength(1);
    expect(artifacts[0]).toMatchObject({
      message_id: result.message_id,
      channel: "api",
      name: "note.txt",
      mime_type: "text/plain",
      size_bytes: 17,
      acquisition_status: "acquired",
      handler_status: "unprocessed",
    });
    expect(artifacts[0].run_id).toBeString();
    expect(artifacts[0].storage_path).toBeString();
    expect(existsSync(artifacts[0].storage_path!)).toBe(true);
    expect(readFileSync(artifacts[0].storage_path!, "utf-8")).toBe("artifact boundary");
  });

  test("queued metadata-only attachments fail before provider invocation", async () => {
    const router = createRouter("should not run");
    const processor = new QueueProcessor(queue, {
      agents: {
        nyx: {
          name: "nyx",
          role: "lead",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          working_directory: tmpDir,
        },
      },
      teams: {},
      baseDir: tmpDir,
      defaultAgent: "nyx",
      router,
      runs,
    }) as any;
    const messageId = queue.enqueueMessage({
      channel: "api",
      sender: "api",
      sender_id: "api_key",
      message: "inspect this image",
      agent: "nyx",
      files: JSON.stringify([{ name: "image.png", mimeType: "image/png", size: 1024 }]),
    });

    await processor.processNext();

    const msg = queue.getMessageByMessageId(messageId);
    expect(router.complete).not.toHaveBeenCalled();
    expect(msg?.status).toBe("dead_letter");
    expect(msg?.last_error).toContain("Attachment content unavailable");
  });

  test("GET /api/status/artifacts exposes pre-run acquisition failures", async () => {
    const artifact = runs.recordInboundArtifactFailure({
      message_id: "external-message-1",
      channel: "discord",
      source: "discord.message.attachments[0]",
      name: "clip.mp4",
      mime_type: "video/mp4",
      acquisition_error: "Unsupported attachment type: clip.mp4 (video/mp4)",
      handler_status: "unsupported",
    });
    const processor = {
      getActiveDelegations: () => new Map(),
      getChannels: () => [],
    };
    const app = withAuth(
      statusRoutes(processor as any, undefined, undefined, {
        config: { daemon: { name: "test" }, server: { port: 3000 }, agents: {}, teams: {}, providers: {} } as any,
        startTime: Date.now(),
        runs,
      }),
      "/api/status",
    );

    const res = await app.request("/api/status/artifacts?channel=discord");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.artifacts).toHaveLength(1);
    expect(body.artifacts[0]).toEqual(artifact);
  });
});

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { QueueDB } from "../queue/db.js";
import { QueueProcessor } from "../queue/processor.js";

function createRouter(response = "ok") {
  return {
    classifyLocal: mock((message: string) => message.includes("fix") ? "coding" : "conversation"),
    route: mock((taskType: string) => ({
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
      taskType,
      maxTokens: 256,
    })),
    routeWithTier: mock((classification: { taskType: string }) => ({
      provider: "anthropic",
      model: "claude-haiku-4-5-20251001",
      taskType: classification.taskType,
      maxTokens: 256,
    })),
    complete: mock(async (_params: unknown) => ({
      content: response,
      model: "claude-haiku-4-5-20251001",
      provider: "anthropic",
      tokensIn: 10,
      tokensOut: 4,
    })),
  };
}

describe("QueueProcessor conversation mode ingress", () => {
  let tmpDir: string;
  let queue: QueueDB;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "processor-mode-test-"));
    queue = new QueueDB(tmpDir);
  });

  afterEach(() => {
    queue.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("auto-resolves Discord engineering turns to build mode at processor ingress", async () => {
    const router = createRouter();
    const processor = new QueueProcessor(queue, {
      agents: {
        nyx: {
          name: "nyx",
          role: "lead",
          provider: "anthropic",
          model: "claude-haiku-4-5-20251001",
          working_directory: tmpDir,
        },
      },
      teams: {},
      baseDir: tmpDir,
      defaultAgent: "nyx",
      router: router as any,
    });

    await processor.processImmediate({
      channel: "discord",
      sender: "User",
      sender_id: "jay",
      message: "fix this bug and commit",
    });

    const completionParams = router.complete.mock.calls[0]?.[0] as { effort?: string; system?: string };
    expect(completionParams.effort).toBe("medium");
    expect(completionParams.system).toContain("Build Mode");
  });

  test("forces public Discord viewer turns to quick conversation mode", async () => {
    const router = createRouter();
    const processor = new QueueProcessor(queue, {
      agents: {
        nyx: {
          name: "nyx",
          role: "lead",
          provider: "anthropic",
          model: "claude-haiku-4-5-20251001",
          working_directory: tmpDir,
        },
      },
      teams: {},
      baseDir: tmpDir,
      defaultAgent: "nyx",
      router: router as any,
    });

    await processor.processImmediate({
      channel: "discord",
      sender: "Public User",
      sender_id: "public-user",
      sender_role: "viewer",
      message: "fix this bug and commit",
    });

    const completionParams = router.complete.mock.calls[0]?.[0] as { effort?: string; system?: string };
    expect(completionParams.effort).toBe("low");
    expect(completionParams.system).toContain("Quick Chat");
    expect(router.classifyLocal).not.toHaveBeenCalled();
  });

  test("explicit build mode forces execution posture even for reflective prompts", async () => {
    const router = createRouter();
    const processor = new QueueProcessor(queue, {
      agents: {
        nyx: {
          name: "nyx",
          role: "lead",
          provider: "anthropic",
          model: "claude-haiku-4-5-20251001",
          working_directory: tmpDir,
        },
      },
      teams: {},
      baseDir: tmpDir,
      defaultAgent: "nyx",
      router: router as any,
    });

    await processor.processImmediate({
      channel: "api",
      sender: "User",
      sender_id: "jay",
      message: "what do you think about this architecture?",
      conversationMode: "build",
    });

    const completionParams = router.complete.mock.calls[0]?.[0] as { system?: string };
    expect(completionParams.system).toContain("Build Mode");
    expect(completionParams.system).toContain("For implementation closeouts");
    expect(completionParams.system).not.toContain("[Reflection mode]");
  });

  test("explicit deep mode avoids automatic build ceremony on coding language", async () => {
    const router = createRouter();
    const processor = new QueueProcessor(queue, {
      agents: {
        nyx: {
          name: "nyx",
          role: "lead",
          provider: "anthropic",
          model: "claude-haiku-4-5-20251001",
          working_directory: tmpDir,
        },
      },
      teams: {},
      baseDir: tmpDir,
      defaultAgent: "nyx",
      router: router as any,
    });

    await processor.processImmediate({
      channel: "api",
      sender: "User",
      sender_id: "jay",
      message: "fix this bug and commit",
      conversationMode: "deep",
    });

    const completionParams = router.complete.mock.calls[0]?.[0] as { effort?: string; system?: string };
    expect(completionParams.effort).toBe("high");
    expect(completionParams.system).toContain("Deep Mode");
    expect(completionParams.system).not.toContain("For implementation closeouts");
    expect(completionParams.system).not.toContain("Build Mode");
  });
});

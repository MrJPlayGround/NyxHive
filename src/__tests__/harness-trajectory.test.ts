import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  appendHarnessTrajectory,
  buildHarnessTrajectoryEntry,
  defaultHarnessTrajectoryPath,
  recordHarnessTrajectoryIfEnabled,
} from "../harness/trajectory.js";

describe("harness trajectory recorder", () => {
  test("builds redacted success entries from harness results", () => {
    const entry = buildHarnessTrajectoryEntry({
      id: "run-1",
      runtime: "codex_app_server",
      provider: "openai",
      model: "gpt-5.4",
      taskType: "coding",
      prompt: "Use OPENAI_API_KEY=fake-secret-key-value to do work",
      now: new Date("2026-04-17T00:00:00.000Z"),
      result: {
        runtime: "codex_app_server",
        providerThreadId: "thread-1",
        providerTurnId: "turn-1",
        response: "done",
        tokensIn: 10,
        tokensOut: 20,
        toolsUsed: ["command_execution"],
        events: [
          { kind: "turn.started", runtime: "codex_app_server", provider: "openai", timestamp: 1 },
          { kind: "tool.started", runtime: "codex_app_server", provider: "openai", message: "command_execution", timestamp: 2 },
        ],
      },
    });

    expect(entry).toMatchObject({
      schema: "nyxhive.harness.trajectory.v1",
      id: "run-1",
      completed: true,
      runtime: "codex_app_server",
      model: "gpt-5.4",
      sessionId: "thread-1",
      turnId: "turn-1",
      tokensIn: 10,
      tokensOut: 20,
      toolsUsed: ["command_execution"],
      eventKinds: ["turn.started", "tool.started"],
    });
    expect(entry.promptPreview).toContain("[REDACTED");
    expect(entry.promptPreview).not.toContain("fake-secret-key-value");
  });

  test("records failed entries when enabled and is a no-op otherwise", () => {
    const dir = mkdtempSync(join(tmpdir(), "nyxhive-harness-trajectory-"));
    const path = join(dir, "harness.jsonl");
    try {
      const entry = buildHarnessTrajectoryEntry({
        id: "run-failed",
        runtime: "codex_app_server",
        prompt: "prompt",
        events: [{ kind: "turn.started", runtime: "codex_app_server", provider: "openai", timestamp: 1 }],
        error: new Error("boom"),
      });

      recordHarnessTrajectoryIfEnabled(entry, { NYXHIVE_HARNESS_TRAJECTORY_PATH: path });
      expect(defaultHarnessTrajectoryPath({ NYXHIVE_HARNESS_TRAJECTORY_PATH: path })).toBe(path);

      recordHarnessTrajectoryIfEnabled(entry, {
        NYXHIVE_HARNESS_TRAJECTORIES: "1",
        NYXHIVE_HARNESS_TRAJECTORY_PATH: path,
      });
      appendHarnessTrajectory({ ...entry, id: "run-explicit" }, path);

      const lines = readFileSync(path, "utf-8").trim().split("\n").map((line) => JSON.parse(line));
      expect(lines.map((line) => line.id)).toEqual(["run-failed", "run-explicit"]);
      expect(lines[0]).toMatchObject({ completed: false, error: "boom" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

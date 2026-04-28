import { describe, expect, test } from "bun:test";
import { runRuntimeSelfAudit } from "../runtime/self-audit.js";

describe("runtime self-audit", () => {
  test("passes GPT-5.5 strict Nyx config with bounded Codex authority", () => {
    const report = runRuntimeSelfAudit({
      agents: {
        Nyx: {
          name: "Nyx",
          provider: "openai",
          model: "gpt-5.5",
          working_directory: "/home/user/dev/nyxhive",
          capabilities: ["tool_use"],
          agentic_mode: "strict",
          role: "lead",
          allowed_directories: ["/home/user/dev/obsidian/ExampleVault"],
        },
      },
      queue: { pending: 0, processing: 0, deadLetters: 0, staleRunning: 0 },
      git: { clean: true, branch: "master", ahead: 0 },
      modelMetadata: {
        hasCostRate: true,
        hasContextWindow: true,
        tier: 4,
      },
    });

    expect(report.ok).toBe(true);
    expect(report.checks.map((check) => check.id)).toContain("codex-authority");
  });

  test("fails broad Codex authority roots", () => {
    const report = runRuntimeSelfAudit({
      agents: {
        Nyx: {
          name: "Nyx",
          provider: "openai",
          model: "gpt-5.5",
          working_directory: "/home/user/dev/nyxhive",
          capabilities: ["tool_use"],
          agentic_mode: "strict",
          role: "lead",
          allowed_directories: ["/home/user"],
        },
      },
      queue: { pending: 0, processing: 0, deadLetters: 0, staleRunning: 0 },
      git: { clean: true, branch: "master", ahead: 0 },
      modelMetadata: {
        hasCostRate: true,
        hasContextWindow: true,
        tier: 4,
      },
    });

    expect(report.ok).toBe(false);
    expect(report.checks.find((check) => check.id === "codex-authority")?.severity).toBe("fail");
  });

  test("marks dead-letter queue audits as warning status", () => {
    const report = runRuntimeSelfAudit({
      agents: {
        Nyx: {
          name: "Nyx",
          provider: "openai",
          model: "gpt-5.5",
          working_directory: "/home/user/dev/nyxhive",
          capabilities: ["tool_use"],
          agentic_mode: "strict",
          role: "lead",
          allowed_directories: ["/home/user/dev/obsidian/ExampleVault"],
        },
      },
      queue: { pending: 0, processing: 0, deadLetters: 6, staleRunning: 0 },
      git: { clean: true, branch: "master", ahead: 0 },
      modelMetadata: {
        hasCostRate: true,
        hasContextWindow: true,
        tier: 4,
      },
    });

    expect(report.ok).toBe(true);
    expect(report.status).toBe("warn");
  });
});

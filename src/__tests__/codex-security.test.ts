import { describe, expect, test } from "bun:test";
import { resolveCodexSecurityDecision } from "../agents/codex-security.js";

describe("Codex security decisions", () => {
  test("explains workspace-write coding authority", () => {
    const decision = resolveCodexSecurityDecision({
      agent: { name: "Nyx", capabilities: ["tool_use"], role: "lead", agentic_mode: "strict" },
      workingDirectory: "/home/user/dev/nyxhive",
      taskType: "coding",
      requireExecutableAuthority: true,
    });

    expect(decision.sandboxMode).toBe("workspace-write");
    expect(decision.authority).toMatchObject({
      agent: "Nyx",
      hasExecutableAuthority: true,
      taskType: "coding",
      nonMutatingTask: false,
      requiresExternalMutation: false,
      selectedReason: "mutating workspace task",
    });
  });

  test("records broad configured directories filtered from authority", () => {
    const decision = resolveCodexSecurityDecision({
      agent: { name: "Nyx", capabilities: ["tool_use"], role: "lead", agentic_mode: "strict" },
      workingDirectory: "/home/user/dev/nyxhive",
      configuredAdditionalDirectories: [
        "/home/user",
        "/Volumes",
        "/home/user/dev/obsidian/ExampleVault",
      ],
      taskType: "coding",
    });

    expect(decision.additionalDirectories).toEqual(["/home/user/dev/obsidian/ExampleVault"]);
    expect(decision.authority.filteredAdditionalDirectories).toEqual(["/home/user", "/Volumes"]);
  });
});

import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  analyzeContextBudget,
  estimateContextTokens,
  formatContextBudgetReport,
} from "../context-budget/audit.js";

function makeFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "nyxhive-context-budget-"));

  mkdirSync(join(root, "skills", "small"), { recursive: true });
  writeFileSync(join(root, "skills", "small", "SKILL.md"), "# Small\n\nUse this rarely.\n");

  mkdirSync(join(root, "skills", "heavy"), { recursive: true });
  writeFileSync(
    join(root, "skills", "heavy", "SKILL.md"),
    ["# Heavy", ...Array.from({ length: 420 }, (_, index) => `- repeated workflow line ${index}`)].join("\n"),
  );

  mkdirSync(join(root, "souls", "_base"), { recursive: true });
  writeFileSync(join(root, "souls", "_base", "identity.md"), "---\nname: Base\nrole: coder\n---\n# Base\n");
  writeFileSync(join(root, "souls", "_base", "rules.md"), "## Must\n- Verify work.\n");
  mkdirSync(join(root, "souls", "_archive"), { recursive: true });
  writeFileSync(join(root, "souls", "_archive", "identity.md"), "---\nname: Archived\n---\n# Archived\n");

  mkdirSync(join(root, "souls", "nyx"), { recursive: true });
  writeFileSync(join(root, "souls", "nyx", "identity.md"), "---\nname: Nyx\nrole: lead\n---\n# Nyx\nLead agent.\n");
  writeFileSync(
    join(root, "souls", "nyx", "tools.md"),
    [
      "---",
      "mcp_tools:",
      ...Array.from({ length: 21 }, (_, index) => `  - tool_${index}`),
      "---",
      "",
    ].join("\n"),
  );

  return root;
}

describe("context budget audit", () => {
  test("estimates prose and code-like content", () => {
    expect(estimateContextTokens("one two three")).toBeGreaterThan(0);
    expect(estimateContextTokens("{\"type\":\"object\",\"properties\":{\"path\":{\"type\":\"string\"}}}")).toBeGreaterThan(0);
  });

  test("summarizes skills, soul prompts, local tools, and MCP allowlists", () => {
    const root = makeFixture();
    try {
      const report = analyzeContextBudget(root);
      const byKind = new Map(report.components.map((component) => [component.kind, component]));

      expect(byKind.get("skills")?.count).toBe(2);
      expect(byKind.get("soul_prompts")?.count).toBe(1);
      expect(byKind.get("local_tools")?.count).toBeGreaterThan(0);
      expect(byKind.get("mcp_tools")?.count).toBe(21);
      expect(report.totalTokens).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("flags heavy skills and broad MCP allowlists", () => {
    const root = makeFixture();
    try {
      const report = analyzeContextBudget(root);
      expect(report.issues.some((issue) => issue.message.includes("Skill heavy is heavy"))).toBe(true);
      expect(report.issues.some((issue) => issue.message.includes("21 unique MCP tools"))).toBe(true);
      expect(report.recommendations.length).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("formats a concise report", () => {
    const root = makeFixture();
    try {
      const report = analyzeContextBudget(root);
      const text = formatContextBudgetReport(report);
      expect(text).toContain("Context Budget Report");
      expect(text).toContain("Estimated overhead");
      expect(text).toContain("Top savings");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

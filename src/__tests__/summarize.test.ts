import { describe, it, expect } from "bun:test";
import { extractMessageEssence } from "../context/summarize.js";

describe("extractMessageEssence", () => {
  it("returns user messages as-is when under limit", () => {
    expect(extractMessageEssence("user", "hello", 300)).toBe("hello");
  });

  it("truncates user messages when over limit", () => {
    const msg = "x".repeat(500);
    expect(extractMessageEssence("user", msg, 300).length).toBe(300);
  });

  it("returns short assistant messages as-is", () => {
    expect(extractMessageEssence("assistant", "Done.", 300)).toBe("Done.");
  });

  it("extracts file paths from long assistant messages", () => {
    const msg = [
      "I'll start by reading the codebase.",
      "Looking at the structure now.",
      "The main entry point is src/index.ts which handles routing.",
      "Configuration is loaded from src/config.ts via TOML parsing.",
      "There are some utility functions scattered around.",
      "The tests live in src/__tests__/ directory.",
      "Overall the architecture looks clean.",
      "Let me also check the package.json for dependencies.",
      "Nothing unusual in the dependency tree.",
      "Here's my analysis of the codebase structure.",
    ].join("\n");

    const essence = extractMessageEssence("assistant", msg, 300);
    expect(essence).toContain("src/index.ts");
    expect(essence).toContain("src/config.ts");
    expect(essence).toContain("src/__tests__/");
  });

  it("extracts action verbs (fixed, implemented, added)", () => {
    const msg = [
      "Starting the task now.",
      "Reading through the code...",
      "I see the issue clearly.",
      "Fixed the circuit breaker decay in router.ts",
      "Also implemented a pre-check for cost ceiling",
      "The logging output looks normal.",
      "Everything seems fine now.",
      "Added 54 new tests covering the changes",
      "All tests pass with zero failures.",
    ].join("\n");

    const essence = extractMessageEssence("assistant", msg, 400);
    expect(essence).toContain("Fixed the circuit breaker");
    expect(essence).toContain("implemented a pre-check");
    expect(essence).toContain("Added 54 new tests");
  });

  it("extracts error/success outcomes", () => {
    const msg = [
      "Let me investigate this further.",
      "Checking the logs now.",
      "Found the bug: error in the parsing logic at line 42",
      "The test suite shows 5 failures in the auth module",
      "After applying the fix, all tests pass successfully",
      "No other issues detected.",
    ].join("\n");

    const essence = extractMessageEssence("assistant", msg, 400);
    expect(essence).toContain("error in the parsing");
    expect(essence).toContain("failures");
    expect(essence).toContain("pass successfully");
  });

  it("extracts bullet points and headers", () => {
    const msg = [
      "Here's what I found:",
      "",
      "## Summary",
      "- First issue: missing validation",
      "- Second issue: race condition",
      "- Third issue: memory leak",
      "",
      "The code has some interesting patterns.",
      "Overall it needs attention.",
    ].join("\n");

    const essence = extractMessageEssence("assistant", msg, 400);
    expect(essence).toContain("## Summary");
    expect(essence).toContain("- First issue");
    expect(essence).toContain("- Second issue");
    expect(essence).toContain("- Third issue");
  });

  it("falls back to head+tail when few high-signal lines", () => {
    const msg = "Lorem ipsum dolor sit amet. ".repeat(30); // no high-signal patterns
    const essence = extractMessageEssence("assistant", msg, 300);
    expect(essence).toContain("...");
    expect(essence.length).toBeLessThanOrEqual(310); // small tolerance for "..."
  });

  it("respects charLimit budget", () => {
    const lines: string[] = [];
    for (let i = 0; i < 50; i++) {
      lines.push(`- Fixed issue number ${i} in src/module${i}.ts`);
    }
    const msg = lines.join("\n");
    const essence = extractMessageEssence("assistant", msg, 300);
    expect(essence.length).toBeLessThanOrEqual(300);
  });

  it("preserves decision rationale", () => {
    const msg = [
      "After reviewing the options, here's my analysis.",
      "We have several approaches available.",
      "The decision to use SQLite was because it avoids external dependencies",
      "This trade-off favors simplicity over distributed scalability",
      "Moving on to implementation details now.",
    ].join("\n");

    const essence = extractMessageEssence("assistant", msg, 400);
    expect(essence).toContain("decision");
    expect(essence).toContain("because");
    expect(essence).toContain("trade-off");
  });
});

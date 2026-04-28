import { describe, test, expect } from "bun:test";
import { parseRalphVerdict, buildRalphInstructions } from "../queue/ralph-loop.js";

describe("parseRalphVerdict", () => {
  test("detects RALPH:PASS", () => {
    const result = parseRalphVerdict("All tests pass. RALPH:PASS");
    expect(result.result).toBe("pass");
  });

  test("detects RALPH:FAIL with reason", () => {
    const result = parseRalphVerdict("Tests failed. RALPH:FAIL 3 tests still failing in auth module");
    expect(result.result).toBe("fail");
    expect(result.reason).toBe("3 tests still failing in auth module");
  });

  test("detects RALPH:BLOCKED with reason", () => {
    const result = parseRalphVerdict("RALPH:BLOCKED missing API key for external service");
    expect(result.result).toBe("blocked");
    expect(result.reason).toBe("missing API key for external service");
  });

  test("returns none when no verdict present", () => {
    const result = parseRalphVerdict("I finished the implementation and all looks good.");
    expect(result.result).toBe("none");
  });

  test("picks the last verdict when multiple present", () => {
    const response = "RALPH:FAIL first attempt\nTrying again...\nRALPH:PASS";
    const result = parseRalphVerdict(response);
    expect(result.result).toBe("pass");
  });

  test("case insensitive matching", () => {
    expect(parseRalphVerdict("ralph:pass").result).toBe("pass");
    expect(parseRalphVerdict("Ralph:Fail reason").result).toBe("fail");
    expect(parseRalphVerdict("RALPH:blocked reason").result).toBe("blocked");
  });

  test("handles empty reason for fail", () => {
    const result = parseRalphVerdict("RALPH:FAIL");
    expect(result.result).toBe("fail");
    expect(result.reason).toBe("");
  });
});

describe("buildRalphInstructions", () => {
  test("includes max rounds in instructions", () => {
    const instructions = buildRalphInstructions(5);
    expect(instructions).toContain("5 rounds");
    expect(instructions).toContain("RALPH:PASS");
    expect(instructions).toContain("RALPH:FAIL");
    expect(instructions).toContain("RALPH:BLOCKED");
  });

  test("includes iteration behavior rules", () => {
    const instructions = buildRalphInstructions(10);
    expect(instructions).toContain("Do NOT repeat the same approach");
    expect(instructions).toContain("Do NOT ask for human input");
  });
});

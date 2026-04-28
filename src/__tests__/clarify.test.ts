import { describe, test, expect } from "bun:test";
import {
  parseClarification,
  CLARIFICATION_INSTRUCTION,
} from "../agents/clarify";

describe("parseClarification", () => {
  test("parses simple clarification tag with two options", () => {
    const input =
      "[@clarify: Which approach? | opt_a: Fast | opt_b: Thorough]";
    const result = parseClarification(input);
    expect(result).not.toBeNull();
    expect(result!.question).toBe("Which approach?");
    expect(result!.options).toEqual([
      { key: "opt_a", description: "Fast" },
      { key: "opt_b", description: "Thorough" },
    ]);
  });

  test("returns null for response without clarification tag", () => {
    const input = "Here is my analysis of the problem. I think we should proceed with option A.";
    expect(parseClarification(input)).toBeNull();
  });

  test("returns null when tag is small part of larger response", () => {
    const filler = "Here is a long explanation of what I found. ".repeat(10);
    const input = `${filler}[@clarify: Which approach? | opt_a: Fast | opt_b: Thorough]`;
    expect(parseClarification(input)).toBeNull();
  });

  test("parses tag with no options (just a question)", () => {
    const input = "[@clarify: What environment should I target?]";
    const result = parseClarification(input);
    expect(result).not.toBeNull();
    expect(result!.question).toBe("What environment should I target?");
    expect(result!.options).toEqual([]);
  });

  test("parses tag with multiple options (4)", () => {
    const input =
      "[@clarify: Which database? | sqlite: Lightweight local | postgres: Full featured | mysql: Legacy compat | mongo: Document store]";
    const result = parseClarification(input);
    expect(result).not.toBeNull();
    expect(result!.question).toBe("Which database?");
    expect(result!.options).toHaveLength(4);
    expect(result!.options[0]).toEqual({
      key: "sqlite",
      description: "Lightweight local",
    });
    expect(result!.options[3]).toEqual({
      key: "mongo",
      description: "Document store",
    });
  });

  test("formatted output includes numbered options", () => {
    const input =
      "[@clarify: Which approach? | opt_a: Fast | opt_b: Thorough]";
    const result = parseClarification(input)!;
    expect(result.formatted).toContain("1. opt_a: Fast");
    expect(result.formatted).toContain("2. opt_b: Thorough");
  });

  test("formatted output includes reply prompt", () => {
    const input =
      "[@clarify: Which approach? | opt_a: Fast | opt_b: Thorough]";
    const result = parseClarification(input)!;
    expect(result.formatted).toContain("Reply with your choice");
  });

  test("question text is trimmed", () => {
    const input = "[@clarify:   What now?   | a: One | b: Two]";
    const result = parseClarification(input)!;
    expect(result.question).toBe("What now?");
  });

  test("CLARIFICATION_INSTRUCTION export contains [@clarify", () => {
    expect(CLARIFICATION_INSTRUCTION).toContain("[@clarify");
  });
});

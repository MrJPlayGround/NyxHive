import { describe, test, expect } from "bun:test";
import { clampInt } from "../utils/parse.js";

describe("clampInt", () => {
  test("returns fallback for undefined", () => {
    expect(clampInt(undefined, 20, 1, 100)).toBe(20);
  });

  test("returns fallback for NaN", () => {
    expect(clampInt("abc", 20, 1, 100)).toBe(20);
  });

  test("clamps to min", () => {
    expect(clampInt("-5", 20, 1, 100)).toBe(1);
  });

  test("clamps to max", () => {
    expect(clampInt("999", 20, 1, 100)).toBe(100);
  });

  test("returns valid value in range", () => {
    expect(clampInt("50", 20, 1, 100)).toBe(50);
  });

  test("handles empty string", () => {
    expect(clampInt("", 20, 1, 100)).toBe(20);
  });
});

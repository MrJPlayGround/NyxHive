import { describe, expect, test } from "bun:test";
import { pickTaskStorePath, resolveTaskStorePaths } from "./tasks.js";

describe("task store paths", () => {
  test("prefers the primary nyxhive task store", () => {
    expect(pickTaskStorePath(true, true)).toBe("primary");
    expect(pickTaskStorePath(false, false)).toBe("primary");
  });

  test("falls back to the legacy onyx task store only when needed", () => {
    expect(pickTaskStorePath(false, true)).toBe("legacy");
  });

  test("builds the expected primary and legacy paths", () => {
    const paths = resolveTaskStorePaths("/tmp/home");
    expect(paths.primary).toBe("/tmp/home/.nyxhive/tasks/active.json");
    expect(paths.legacy).toBe("/tmp/home/dev/onyx/tasks/active.json");
  });
});

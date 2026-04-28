import { describe, expect, test } from "bun:test";
import { resolveAgentRuntimePath, resolveAgentRuntimePaths } from "../agents/paths.js";

describe("agent runtime path resolution", () => {
  test("resolves relative paths from the runtime base directory", () => {
    expect(resolveAgentRuntimePath("/srv/nyx", "./workspace/nyx")).toBe("/srv/nyx/workspace/nyx");
    expect(resolveAgentRuntimePaths("/srv/nyx", ["./repo", "../shared"])).toEqual([
      "/srv/nyx/repo",
      "/srv/shared",
    ]);
  });

  test("preserves absolute paths", () => {
    expect(resolveAgentRuntimePath("/srv/nyx", "/tmp/work")).toBe("/tmp/work");
    expect(resolveAgentRuntimePaths("/srv/nyx", ["/tmp/work"])).toEqual(["/tmp/work"]);
  });
});

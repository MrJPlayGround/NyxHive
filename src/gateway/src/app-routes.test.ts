import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();

function source(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

describe("gateway workspace compatibility routes", () => {
  test("gateway forwards /operations into the workspace instead of 404ing", () => {
    const app = source("src/gateway/src/App.tsx");

    expect(app).toContain('path="/operations"');
    expect(app).toContain("WorkspaceOperationsRedirectPage");
  });
});

import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { saveWorkspaceRegistry } from "../workspaces/registry-store.js";
import { resolveCodexWritableDirectoryGrants } from "../agents/codex-directory-grants.js";

describe("Codex writable directory grants", () => {
  test("includes live NyxHive state and registered agent workspace roots", () => {
    const root = join(tmpdir(), `nyxhive-grants-${Date.now()}`);
    const registryPath = join(root, ".nyxhive", "workspaces.toml");
    const astraRoot = join(root, "astra-trading");
    mkdirSync(astraRoot, { recursive: true });
    saveWorkspaceRegistry(registryPath, {
      workspaces: [{ id: "astra-trading", path: astraRoot }],
    });

    try {
      const grants = resolveCodexWritableDirectoryGrants({
        baseDir: join(root, "nyxhive", ".nyxhive"),
        configuredDirectories: [".."],
        registryPath,
        nyxhiveStateDir: join(root, ".nyxhive"),
      });

      expect(grants).toEqual([
        join(root, "nyxhive"),
        join(root, ".nyxhive"),
        astraRoot,
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

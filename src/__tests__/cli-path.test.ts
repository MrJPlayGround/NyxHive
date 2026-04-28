import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getServicePathEntries, resolveCliBinary } from "../utils/cli-path.js";

describe("resolveCliBinary", () => {
  test("finds executables on PATH", () => {
    const dir = mkdtempSync(join(tmpdir(), "cli-path-test-"));
    const binary = join(dir, "opencode");
    writeFileSync(binary, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    expect(resolveCliBinary("opencode", {
      env: { PATH: dir },
    })).toBe(binary);
  });

  test("falls back to known Claude app bundle path", () => {
    const root = mkdtempSync(join(tmpdir(), "cli-path-test-"));
    const appBundleDir = join(root, "Applications/cmux.app/Contents/Resources/bin");
    const binary = join(appBundleDir, "claude");
    mkdirSync(appBundleDir, { recursive: true });
    writeFileSync(binary, "#!/bin/sh\nexit 0\n", { mode: 0o755 });

    expect(resolveCliBinary("claude", {
      env: { PATH: "/usr/bin:/bin" },
      extraFiles: [binary],
    })).toBe(binary);
  });

  test("returns null when executable is unavailable", () => {
    expect(resolveCliBinary("missing-cli", {
      env: { PATH: "/usr/bin:/bin" },
      extraDirs: [],
      extraFiles: [],
    })).toBeNull();
  });
});

describe("getServicePathEntries", () => {
  test("includes the Claude app bundle bin directory", () => {
    expect(getServicePathEntries()).toContain("/Applications/cmux.app/Contents/Resources/bin");
  });
});

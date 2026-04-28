import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  resolveDeployTarget,
  getGitVersion,
  deployLocal,
  recordDeployHistory,
  loadDeployHistory,
  pollHealthCheck,
  type DeployManifest,
} from "../cli/deploy.js";
import {
  addBookmark,
} from "../cli/instance-registry.js";
import TOML from "@iarna/toml";

describe("resolveDeployTarget", () => {
  let tmpDir: string;
  let bookmarksPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nyxhive-deploy-"));
    bookmarksPath = join(tmpDir, "bookmarks.json");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("resolves from bookmarks by name", () => {
    addBookmark({ name: "test", path: "/some/path", port: 3777 }, bookmarksPath);

    const target = resolveDeployTarget({
      instanceName: "test",
      bookmarksPath,
    });

    expect(target.path).toBe("/some/path");
    expect(target.port).toBe(3777);
  });

  test("resolves from direct path", () => {
    const instDir = join(tmpDir, "instance");
    mkdirSync(instDir, { recursive: true });

    const target = resolveDeployTarget({
      instancePath: instDir,
    });

    expect(target.path).toBe(instDir);
  });

  test("throws if neither name nor path provided", () => {
    expect(() => resolveDeployTarget({})).toThrow("Either --instance");
  });

  test("throws if instance not found in bookmarks", () => {
    expect(() => resolveDeployTarget({
      instanceName: "nonexistent",
      bookmarksPath,
    })).toThrow("not found");
  });

  test("throws if path doesn't exist", () => {
    expect(() => resolveDeployTarget({
      instancePath: "/nonexistent/path",
    })).toThrow("not found");
  });
});

describe("getGitVersion", () => {
  test("returns unknown for non-git directory", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "nyxhive-git-"));
    try {
      const version = getGitVersion(tmpDir);
      expect(version).toBe("unknown");
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("recordDeployHistory", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nyxhive-history-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeManifest(overrides: Partial<DeployManifest> = {}): DeployManifest {
    return {
      timestamp: new Date().toISOString(),
      from_version: "abc1234",
      to_version: "def5678",
      backup_id: "2026-01-01T00-00-00",
      migrations_run: false,
      lockfile_changed: false,
      success: true,
      duration_ms: 1000,
      ...overrides,
    };
  }

  test("creates deploy-history.json if it doesn't exist", () => {
    recordDeployHistory(tmpDir, makeManifest());

    const history = loadDeployHistory(tmpDir);
    expect(history).toHaveLength(1);
    expect(history[0].success).toBe(true);
  });

  test("appends to existing history", () => {
    recordDeployHistory(tmpDir, makeManifest({ from_version: "v1" }));
    recordDeployHistory(tmpDir, makeManifest({ from_version: "v2" }));
    recordDeployHistory(tmpDir, makeManifest({ from_version: "v3" }));

    const history = loadDeployHistory(tmpDir);
    expect(history).toHaveLength(3);
    expect(history[0].from_version).toBe("v1");
    expect(history[2].from_version).toBe("v3");
  });

  test("rotates history to 50 entries max", () => {
    for (let i = 0; i < 55; i++) {
      recordDeployHistory(tmpDir, makeManifest({ from_version: `v${i}` }));
    }

    const history = loadDeployHistory(tmpDir);
    expect(history).toHaveLength(50);
    expect(history[0].from_version).toBe("v5");
    expect(history[49].from_version).toBe("v54");
  });

  test("records failed deploy", () => {
    recordDeployHistory(tmpDir, makeManifest({ success: false, error: "rsync failed" }));

    const history = loadDeployHistory(tmpDir);
    expect(history[0].success).toBe(false);
    expect(history[0].error).toBe("rsync failed");
  });

  test("creates data dir if missing", () => {
    const subDir = join(tmpDir, "nested", "instance");
    recordDeployHistory(subDir, makeManifest());

    expect(existsSync(join(subDir, "data", "deploy-history.json"))).toBe(true);
  });
});

describe("loadDeployHistory", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nyxhive-hist-load-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns empty array if no history file", () => {
    expect(loadDeployHistory(tmpDir)).toEqual([]);
  });

  test("returns empty array for corrupt history file", () => {
    mkdirSync(join(tmpDir, "data"), { recursive: true });
    writeFileSync(join(tmpDir, "data", "deploy-history.json"), "not json");

    expect(loadDeployHistory(tmpDir)).toEqual([]);
  });
});

describe("deployLocal (dry run)", () => {
  let tmpDir: string;
  let sourceDir: string;
  let targetDir: string;
  let bookmarksPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nyxhive-deploy-local-"));
    sourceDir = join(tmpDir, "source");
    targetDir = join(tmpDir, "target");
    bookmarksPath = join(tmpDir, "bookmarks.json");

    // Create source dir with a file
    mkdirSync(join(sourceDir, "src"), { recursive: true });
    writeFileSync(join(sourceDir, "src", "index.ts"), "console.log('hello')");

    // Create target instance
    mkdirSync(join(targetDir, "data"), { recursive: true });
    mkdirSync(join(targetDir, "config"), { recursive: true });

    // Add bookmark
    addBookmark({ name: "dry-test", path: targetDir, port: 3777 }, bookmarksPath);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("dry run completes without making changes", async () => {
    const result = await deployLocal({
      instanceName: "dry-test",
      sourceDir,
      bookmarksPath,
      dryRun: true,
    });

    expect(result.success).toBe(true);
    expect(result.manifest.success).toBe(true);
    expect(result.steps).toContain("backup");
    expect(result.steps).toContain("rsync");
    expect(result.steps).toContain("dependencies");
    expect(result.steps).toContain("migrations");
    expect(result.steps).toContain("restart");
    expect(result.steps).toContain("health-check");
    expect(result.steps).toContain("record");
  });

  test("dry run records deploy history", async () => {
    await deployLocal({
      instanceName: "dry-test",
      sourceDir,
      bookmarksPath,
      dryRun: true,
    });

    const history = loadDeployHistory(targetDir);
    expect(history).toHaveLength(1);
    expect(history[0].success).toBe(true);
  });

  test("deploy with missing target throws", async () => {
    await expect(deployLocal({
      instancePath: "/nonexistent/path",
      sourceDir,
      dryRun: true,
    })).rejects.toThrow("not found");
  });
});

describe("pollHealthCheck", () => {
  test("returns false for unreachable host", async () => {
    // Use a port that's almost certainly not running
    const healthy = await pollHealthCheck("127.0.0.1", 19999, 3000, 1000);
    expect(healthy).toBe(false);
  });
});

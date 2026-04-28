import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";
import {
  rollback,
  findRollbackTarget,
  findBackupDir,
  revertCode,
} from "../cli/rollback.js";
import { createBackupWithManifest } from "../cli/backup-store.js";
import { recordDeployHistory, loadDeployHistory, type DeployManifest } from "../cli/deploy.js";

function makeManifest(overrides: Partial<DeployManifest> = {}): DeployManifest {
  return {
    timestamp: new Date().toISOString(),
    from_version: "abc1234",
    to_version: "def5678",
    backup_id: "none",
    migrations_run: false,
    lockfile_changed: false,
    success: true,
    duration_ms: 1000,
    ...overrides,
  };
}

describe("findRollbackTarget", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nyxhive-rollback-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns null for empty history", () => {
    expect(findRollbackTarget(tmpDir)).toBeNull();
  });

  test("returns most recent successful deploy with backup", () => {
    recordDeployHistory(tmpDir, makeManifest({ backup_id: "2026-01-01T00-00-00", success: true }));
    recordDeployHistory(tmpDir, makeManifest({ backup_id: "2026-01-02T00-00-00", success: true }));

    const target = findRollbackTarget(tmpDir);
    expect(target).not.toBeNull();
    expect(target!.backup_id).toBe("2026-01-02T00-00-00");
  });

  test("skips deploys without backups", () => {
    recordDeployHistory(tmpDir, makeManifest({ backup_id: "2026-01-01T00-00-00", success: true }));
    recordDeployHistory(tmpDir, makeManifest({ backup_id: "none", success: true }));

    const target = findRollbackTarget(tmpDir);
    expect(target!.backup_id).toBe("2026-01-01T00-00-00");
  });

  test("skips failed deploys", () => {
    recordDeployHistory(tmpDir, makeManifest({ backup_id: "good-backup", success: true }));
    recordDeployHistory(tmpDir, makeManifest({ backup_id: "bad-backup", success: false }));

    const target = findRollbackTarget(tmpDir);
    expect(target!.backup_id).toBe("good-backup");
  });

  test("returns specific deploy by index", () => {
    recordDeployHistory(tmpDir, makeManifest({ backup_id: "backup-0", from_version: "v0" }));
    recordDeployHistory(tmpDir, makeManifest({ backup_id: "backup-1", from_version: "v1" }));

    const target = findRollbackTarget(tmpDir, 0);
    expect(target!.backup_id).toBe("backup-0");
    expect(target!.from_version).toBe("v0");
  });

  test("returns null for out-of-range index", () => {
    recordDeployHistory(tmpDir, makeManifest());
    expect(findRollbackTarget(tmpDir, 99)).toBeNull();
  });
});

describe("findBackupDir", () => {
  let tmpDir: string;
  let dataDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nyxhive-rollback-find-"));
    dataDir = join(tmpDir, "data");
    mkdirSync(dataDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("finds existing backup by ID", () => {
    const db = new Database(join(dataDir, "test.db"));
    db.run("CREATE TABLE t (id INTEGER)");
    db.close();

    const backup = createBackupWithManifest({ dataDir });
    const found = findBackupDir(dataDir, backup.backupId);

    expect(found).not.toBeNull();
    expect(found).toContain(backup.backupId);
  });

  test("returns null for missing backup", () => {
    expect(findBackupDir(dataDir, "nonexistent")).toBeNull();
  });
});

describe("revertCode", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nyxhive-revert-code-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("fails for unknown version", () => {
    const result = revertCode(tmpDir, "unknown");
    expect(result.success).toBe(false);
    expect(result.error).toContain("unknown");
  });

  test("fails for empty version", () => {
    const result = revertCode(tmpDir, "");
    expect(result.success).toBe(false);
  });

  test("fails for non-git directory", () => {
    const result = revertCode(tmpDir, "abc1234");
    expect(result.success).toBe(false);
    expect(result.error).toContain("Not a git repository");
  });
});

describe("rollback (integration)", () => {
  let tmpDir: string;
  let instancePath: string;
  let dataDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nyxhive-rollback-int-"));
    instancePath = join(tmpDir, "instance");
    dataDir = join(instancePath, "data");
    mkdirSync(dataDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("fails when instance path doesn't exist", async () => {
    const result = await rollback({
      instancePath: join(tmpDir, "nonexistent"),
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain("does not exist");
  });

  test("fails when no deploy history", async () => {
    const result = await rollback({ instancePath });
    expect(result.success).toBe(false);
    expect(result.error).toContain("No deploy history");
  });

  test("restores databases from backup (db-only)", async () => {
    // Create a database and back it up
    const db = new Database(join(dataDir, "main.db"));
    db.run("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)");
    db.run("INSERT INTO users (name) VALUES ('Alice')");
    db.close();

    const backup = createBackupWithManifest({ dataDir });

    // Modify the database after backup
    const db2 = new Database(join(dataDir, "main.db"));
    db2.run("INSERT INTO users (name) VALUES ('Bob')");
    db2.run("INSERT INTO users (name) VALUES ('Charlie')");
    db2.close();

    // Record deploy with backup ID
    recordDeployHistory(instancePath, makeManifest({
      backup_id: backup.backupId,
      success: true,
    }));

    // Rollback db-only
    const result = await rollback({ instancePath, dbOnly: true });

    expect(result.success).toBe(true);
    expect(result.restored_db).toBe(true);
    expect(result.reverted_code).toBe(false);
    expect(result.steps).toContain("restore-db");
    expect(result.steps).not.toContain("revert-code");

    // Verify restored database only has Alice
    const db3 = new Database(join(dataDir, "main.db"), { readonly: true });
    const rows = db3.query("SELECT name FROM users").all() as Array<{ name: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe("Alice");
    db3.close();
  });

  test("records rollback in deploy history", async () => {
    const db = new Database(join(dataDir, "main.db"));
    db.run("CREATE TABLE t (id INTEGER)");
    db.close();

    const backup = createBackupWithManifest({ dataDir });
    recordDeployHistory(instancePath, makeManifest({
      backup_id: backup.backupId,
      success: true,
      from_version: "old-version",
    }));

    await rollback({ instancePath, dbOnly: true });

    const history = loadDeployHistory(instancePath);
    const last = history[history.length - 1];
    expect(last.from_version).toBe("rollback");
    expect(last.to_version).toBe("old-version");
  });

  test("fails when backup not found", async () => {
    recordDeployHistory(instancePath, makeManifest({
      backup_id: "nonexistent-backup",
      success: true,
    }));

    const result = await rollback({ instancePath });
    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });

  test("uses custom backup ID", async () => {
    const db = new Database(join(dataDir, "test.db"));
    db.run("CREATE TABLE t (id INTEGER, val TEXT)");
    db.run("INSERT INTO t (val) VALUES ('original')");
    db.close();

    const backup = createBackupWithManifest({ dataDir });

    // Modify after backup
    const db2 = new Database(join(dataDir, "test.db"));
    db2.run("UPDATE t SET val = 'modified'");
    db2.close();

    const result = await rollback({
      instancePath,
      backupId: backup.backupId,
      dbOnly: true,
    });

    expect(result.success).toBe(true);

    // Verify restored
    const db3 = new Database(join(dataDir, "test.db"), { readonly: true });
    const row = db3.query("SELECT val FROM t").get() as { val: string };
    expect(row.val).toBe("original");
    db3.close();
  });

  test("code-only skips database restore", async () => {
    recordDeployHistory(instancePath, makeManifest({
      backup_id: "some-backup",
      success: true,
      from_version: "unknown", // Will fail git checkout
    }));

    const result = await rollback({ instancePath, codeOnly: true });

    // Code revert will fail (not a git repo), but db should not be touched
    expect(result.restored_db).toBe(false);
    expect(result.steps).not.toContain("restore-db");
    expect(result.steps).toContain("revert-code");
  });
});

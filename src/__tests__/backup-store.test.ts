import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  createBackupWithManifest,
  listBackupsWithManifest,
  getBackup,
  restoreFromBackup,
  pruneBackups,
  checkIntegrity,
  getRowCounts,
} from "../cli/backup-store.js";
import { mkdtempSync, rmSync, mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";

describe("backup-store", () => {
  let tmpDir: string;
  let dataDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nyxhive-backup-store-"));
    dataDir = join(tmpDir, "data");
    mkdirSync(dataDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function createTestDb(name: string, tables?: Record<string, number>): void {
    const db = new Database(join(dataDir, name));
    if (tables) {
      for (const [table, rows] of Object.entries(tables)) {
        db.run(`CREATE TABLE ${table} (id INTEGER PRIMARY KEY, val TEXT)`);
        for (let i = 0; i < rows; i++) {
          db.run(`INSERT INTO ${table} (val) VALUES ('row-${i}')`);
        }
      }
    } else {
      db.run("CREATE TABLE t (id INTEGER PRIMARY KEY)");
    }
    db.close();
  }

  describe("createBackupWithManifest", () => {
    test("creates backup with manifest file", () => {
      createTestDb("main.db", { messages: 5, responses: 3 });

      const result = createBackupWithManifest({ dataDir });

      expect(result.success).toBe(true);
      expect(result.manifest).not.toBeNull();
      expect(result.manifest!.databases).toHaveLength(1);
      expect(result.manifest!.databases[0].name).toBe("main.db");
      expect(result.manifest!.databases[0].integrity).toBe("ok");
      expect(result.manifest!.databases[0].row_counts.messages).toBe(5);
      expect(result.manifest!.databases[0].row_counts.responses).toBe(3);
      expect(result.manifest!.total_size_bytes).toBeGreaterThan(0);

      // Verify manifest file exists on disk
      const manifestPath = join(result.backupDir, "backup-manifest.json");
      expect(existsSync(manifestPath)).toBe(true);

      const written = JSON.parse(readFileSync(manifestPath, "utf-8"));
      expect(written.timestamp).toBe(result.backupId);
    });

    test("includes version and git sha in manifest", () => {
      createTestDb("test.db");

      const result = createBackupWithManifest({ dataDir });

      expect(result.manifest!.version).toBeDefined();
      expect(result.manifest!.git_sha).toBeDefined();
    });

    test("backs up multiple databases", () => {
      createTestDb("main.db", { t1: 2 });
      createTestDb("memory.db", { t2: 3 });
      createTestDb("knowledge.db", { t3: 1 });

      const result = createBackupWithManifest({ dataDir });

      expect(result.success).toBe(true);
      expect(result.manifest!.databases).toHaveLength(3);
    });

    test("fails when data dir missing", () => {
      const result = createBackupWithManifest({ dataDir: join(tmpDir, "nonexistent") });

      expect(result.success).toBe(false);
      expect(result.error).toContain("does not exist");
    });

    test("fails when no db files", () => {
      const result = createBackupWithManifest({ dataDir });

      expect(result.success).toBe(false);
      expect(result.error).toContain("No database files");
    });

    test("uses custom backup dir", () => {
      createTestDb("test.db");
      const customDir = join(tmpDir, "custom-backups");

      const result = createBackupWithManifest({ dataDir, backupDir: customDir });

      expect(result.success).toBe(true);
      expect(result.backupDir).toContain("custom-backups");
    });

    test("prunes old backups beyond maxBackups", () => {
      createTestDb("test.db");

      for (let i = 0; i < 5; i++) {
        createBackupWithManifest({
          dataDir,
          maxBackups: 3,
          now: new Date(2026, 0, 1, 0, 0, i),
        });
      }

      const backups = listBackupsWithManifest(dataDir);
      expect(backups.length).toBeLessThanOrEqual(3);
    });
  });

  describe("checkIntegrity", () => {
    test("returns ok for valid database", () => {
      const dbPath = join(dataDir, "valid.db");
      const db = new Database(dbPath);
      db.run("CREATE TABLE t (id INTEGER)");
      db.close();

      expect(checkIntegrity(dbPath)).toBe("ok");
    });

    test("returns failed for non-database file", () => {
      const path = join(dataDir, "not-a-db.db");
      writeFileSync(path, "this is not a database");

      expect(checkIntegrity(path)).toBe("failed");
    });

    test("returns failed for missing file", () => {
      expect(checkIntegrity(join(dataDir, "missing.db"))).toBe("failed");
    });
  });

  describe("getRowCounts", () => {
    test("returns counts for all tables", () => {
      const dbPath = join(dataDir, "counts.db");
      const db = new Database(dbPath);
      db.run("CREATE TABLE users (id INTEGER)");
      db.run("INSERT INTO users VALUES (1)");
      db.run("INSERT INTO users VALUES (2)");
      db.run("CREATE TABLE items (id INTEGER)");
      db.run("INSERT INTO items VALUES (1)");
      db.close();

      const counts = getRowCounts(dbPath);
      expect(counts.users).toBe(2);
      expect(counts.items).toBe(1);
    });

    test("returns empty for missing file", () => {
      expect(getRowCounts(join(dataDir, "missing.db"))).toEqual({});
    });
  });

  describe("listBackupsWithManifest", () => {
    test("returns empty when no backups", () => {
      expect(listBackupsWithManifest(dataDir)).toEqual([]);
    });

    test("returns backups sorted newest first", () => {
      createTestDb("test.db");

      createBackupWithManifest({ dataDir, now: new Date(2026, 0, 1, 0, 0, 0) });
      createBackupWithManifest({ dataDir, now: new Date(2026, 0, 1, 0, 0, 1) });

      const backups = listBackupsWithManifest(dataDir);
      expect(backups).toHaveLength(2);
      expect(backups[0].id > backups[1].id).toBe(true);
    });

    test("includes manifest data", () => {
      createTestDb("test.db", { items: 3 });
      createBackupWithManifest({ dataDir });

      const backups = listBackupsWithManifest(dataDir);
      expect(backups[0].manifest).not.toBeNull();
      expect(backups[0].manifest!.databases[0].row_counts.items).toBe(3);
    });
  });

  describe("getBackup", () => {
    test("returns specific backup by id", () => {
      createTestDb("test.db");
      const result = createBackupWithManifest({ dataDir });

      const backup = getBackup(dataDir, result.backupId);
      expect(backup).not.toBeNull();
      expect(backup!.id).toBe(result.backupId);
    });

    test("returns null for nonexistent id", () => {
      expect(getBackup(dataDir, "nonexistent")).toBeNull();
    });
  });

  describe("restoreFromBackup", () => {
    test("restores databases to target directory", () => {
      createTestDb("main.db", { users: 5 });
      const backup = createBackupWithManifest({ dataDir });

      const restoreDir = join(tmpDir, "restored");
      const result = restoreFromBackup(backup.backupDir, restoreDir);

      expect(result.success).toBe(true);
      expect(result.restored).toContain("main.db");

      // Verify restored data
      const db = new Database(join(restoreDir, "main.db"), { readonly: true });
      const row = db.query("SELECT COUNT(*) as cnt FROM users").get() as { cnt: number };
      expect(row.cnt).toBe(5);
      db.close();
    });

    test("fails for missing backup dir", () => {
      const result = restoreFromBackup(join(tmpDir, "nonexistent"), dataDir);
      expect(result.success).toBe(false);
      expect(result.error).toContain("does not exist");
    });

    test("creates target dir if missing", () => {
      createTestDb("test.db");
      const backup = createBackupWithManifest({ dataDir });

      const newDir = join(tmpDir, "new", "nested", "dir");
      const result = restoreFromBackup(backup.backupDir, newDir);

      expect(result.success).toBe(true);
      expect(existsSync(join(newDir, "test.db"))).toBe(true);
    });
  });

  describe("pruneBackups", () => {
    test("removes oldest backups beyond limit", () => {
      createTestDb("test.db");

      for (let i = 0; i < 5; i++) {
        createBackupWithManifest({
          dataDir,
          maxBackups: 100, // don't prune during creation
          now: new Date(2026, 0, 1, 0, 0, i),
        });
      }

      const backupDir = join(dataDir, "backups");
      const pruned = pruneBackups(backupDir, 2);
      expect(pruned).toBe(3);

      const remaining = listBackupsWithManifest(dataDir);
      expect(remaining).toHaveLength(2);
    });

    test("does nothing when under limit", () => {
      createTestDb("test.db");
      createBackupWithManifest({ dataDir });

      const pruned = pruneBackups(join(dataDir, "backups"), 10);
      expect(pruned).toBe(0);
    });
  });
});

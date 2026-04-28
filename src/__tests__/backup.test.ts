import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { createBackup, listBackups } from "../utils/backup.js";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readdirSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";

describe("createBackup", () => {
  let tmpDir: string;
  let dataDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nyxhive-backup-test-"));
    dataDir = join(tmpDir, "data");
    mkdirSync(dataDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("backs up SQLite databases using VACUUM INTO", () => {
    // Create a test database with data
    const dbPath = join(dataDir, "test.db");
    const db = new Database(dbPath);
    db.run("CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT)");
    db.run("INSERT INTO t VALUES (1, 'hello')");
    db.close();

    const result = createBackup({ dataDir });
    expect(result.success).toBe(true);
    expect(result.files).toHaveLength(1);
    expect(result.files[0]).toContain("test.db");

    // Verify the backup is a valid database
    const backupDb = new Database(result.files[0], { readonly: true });
    const row = backupDb.query("SELECT val FROM t WHERE id = 1").get() as any;
    expect(row.val).toBe("hello");
    backupDb.close();
  });

  test("backs up multiple databases", () => {
    for (const name of ["main.db", "knowledge.db", "memory.db"]) {
      const db = new Database(join(dataDir, name));
      db.run("CREATE TABLE t (id INTEGER)");
      db.close();
    }

    const result = createBackup({ dataDir });
    expect(result.success).toBe(true);
    expect(result.files).toHaveLength(3);
  });

  test("fails gracefully when data directory is missing", () => {
    const result = createBackup({ dataDir: join(tmpDir, "nonexistent") });
    expect(result.success).toBe(false);
    expect(result.error).toContain("does not exist");
  });

  test("fails gracefully when no .db files exist", () => {
    const result = createBackup({ dataDir });
    expect(result.success).toBe(false);
    expect(result.error).toContain("No database files");
  });

  test("rotates old backups", () => {
    const db = new Database(join(dataDir, "test.db"));
    db.run("CREATE TABLE t (id INTEGER)");
    db.close();

    // Create 3 backups with maxBackups=2, using injected timestamps
    for (let i = 0; i < 3; i++) {
      createBackup({ dataDir, maxBackups: 2, now: new Date(2024, 0, 1, 0, 0, i) });
    }

    const backups = listBackups(dataDir);
    expect(backups.length).toBeLessThanOrEqual(2);
  });

  test("creates backups in custom directory", () => {
    const customBackupDir = join(tmpDir, "custom-backups");
    const db = new Database(join(dataDir, "test.db"));
    db.run("CREATE TABLE t (id INTEGER)");
    db.close();

    const result = createBackup({ dataDir, backupDir: customBackupDir });
    expect(result.success).toBe(true);
    expect(result.backupDir).toContain("custom-backups");
  });
});

describe("listBackups", () => {
  let tmpDir: string;
  let dataDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nyxhive-backup-test-"));
    dataDir = join(tmpDir, "data");
    mkdirSync(dataDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("returns empty array when no backups exist", () => {
    expect(listBackups(dataDir)).toEqual([]);
  });

  test("returns backups sorted newest first", () => {
    const db = new Database(join(dataDir, "test.db"));
    db.run("CREATE TABLE t (id INTEGER)");
    db.close();

    createBackup({ dataDir, now: new Date(2024, 0, 1, 0, 0, 0) });
    createBackup({ dataDir, now: new Date(2024, 0, 1, 0, 0, 1) });

    const backups = listBackups(dataDir);
    expect(backups).toHaveLength(2);
    expect(backups[0].timestamp > backups[1].timestamp).toBe(true);
  });

  test("includes file list and size", () => {
    const db = new Database(join(dataDir, "test.db"));
    db.run("CREATE TABLE t (id INTEGER)");
    db.close();

    createBackup({ dataDir });

    const backups = listBackups(dataDir);
    expect(backups[0].files).toContain("test.db");
    expect(backups[0].sizeBytes).toBeGreaterThan(0);
  });
});

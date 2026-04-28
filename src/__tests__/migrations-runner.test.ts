import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import {
  runMigrations,
  getCurrentVersion,
  getAppliedVersions,
  getMigrationStatus,
  dryRunMigrations,
  validateMigrations,
  type Migration,
} from "../migrations/runner.js";

function createMigration(version: number, description: string, sql?: string): Migration {
  return {
    version,
    description,
    up(db) {
      if (sql) db.run(sql);
    },
  };
}

describe("migrations runner", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  describe("getCurrentVersion", () => {
    test("returns 0 for fresh database", () => {
      expect(getCurrentVersion(db)).toBe(0);
    });

    test("returns highest applied version", () => {
      const migrations = [
        createMigration(1, "first", "CREATE TABLE t1 (id INTEGER)"),
        createMigration(2, "second", "CREATE TABLE t2 (id INTEGER)"),
      ];
      runMigrations(db, migrations);

      expect(getCurrentVersion(db)).toBe(2);
    });
  });

  describe("getAppliedVersions", () => {
    test("returns empty for fresh database", () => {
      expect(getAppliedVersions(db)).toEqual([]);
    });

    test("returns sorted applied versions", () => {
      const migrations = [
        createMigration(1, "first", "CREATE TABLE t1 (id INTEGER)"),
        createMigration(3, "third", "CREATE TABLE t3 (id INTEGER)"),
      ];
      runMigrations(db, migrations);

      expect(getAppliedVersions(db)).toEqual([1, 3]);
    });
  });

  describe("runMigrations", () => {
    test("applies pending migrations in order", () => {
      const migrations = [
        createMigration(1, "create users", "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)"),
        createMigration(2, "create items", "CREATE TABLE items (id INTEGER PRIMARY KEY, title TEXT)"),
        createMigration(3, "add user email", "ALTER TABLE users ADD COLUMN email TEXT"),
      ];

      const result = runMigrations(db, migrations);

      expect(result.success).toBe(true);
      expect(result.applied).toEqual([1, 2, 3]);

      // Verify tables were created
      const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != 'schema_version'").all() as Array<{ name: string }>;
      const tableNames = tables.map(t => t.name).sort();
      expect(tableNames).toEqual(["items", "users"]);

      // Verify email column exists
      const cols = db.query("PRAGMA table_info(users)").all() as Array<{ name: string }>;
      expect(cols.map(c => c.name)).toContain("email");
    });

    test("skips already-applied migrations", () => {
      const m1 = createMigration(1, "first", "CREATE TABLE t1 (id INTEGER)");
      const m2 = createMigration(2, "second", "CREATE TABLE t2 (id INTEGER)");

      runMigrations(db, [m1]);
      const result = runMigrations(db, [m1, m2]);

      expect(result.success).toBe(true);
      expect(result.applied).toEqual([2]);
    });

    test("returns empty applied when nothing to do", () => {
      const m1 = createMigration(1, "first", "CREATE TABLE t1 (id INTEGER)");

      runMigrations(db, [m1]);
      const result = runMigrations(db, [m1]);

      expect(result.success).toBe(true);
      expect(result.applied).toEqual([]);
    });

    test("rolls back failed migration", () => {
      const migrations = [
        createMigration(1, "good", "CREATE TABLE t1 (id INTEGER)"),
        createMigration(2, "bad", "INVALID SQL HERE"),
      ];

      const result = runMigrations(db, migrations);

      expect(result.success).toBe(false);
      expect(result.applied).toEqual([1]);
      expect(result.error).toContain("v2 failed");

      // v1 should be applied, v2 should not
      expect(getCurrentVersion(db)).toBe(1);

      // t1 should exist
      const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name = 't1'").all();
      expect(tables).toHaveLength(1);
    });

    test("handles out-of-order migration versions", () => {
      const migrations = [
        createMigration(3, "third", "CREATE TABLE t3 (id INTEGER)"),
        createMigration(1, "first", "CREATE TABLE t1 (id INTEGER)"),
        createMigration(2, "second", "CREATE TABLE t2 (id INTEGER)"),
      ];

      const result = runMigrations(db, migrations);

      expect(result.success).toBe(true);
      expect(result.applied).toEqual([1, 2, 3]); // Applied in sorted order
    });

    test("preserves data across migrations", () => {
      runMigrations(db, [
        createMigration(1, "create table", "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)"),
      ]);

      // Insert data between migrations
      db.run("INSERT INTO users (name) VALUES ('Alice')");
      db.run("INSERT INTO users (name) VALUES ('Bob')");

      runMigrations(db, [
        createMigration(1, "create table", "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)"),
        createMigration(2, "add column", "ALTER TABLE users ADD COLUMN active INTEGER DEFAULT 1"),
      ]);

      const rows = db.query("SELECT * FROM users ORDER BY name").all() as Array<{ name: string; active: number }>;
      expect(rows).toHaveLength(2);
      expect(rows[0].name).toBe("Alice");
      expect(rows[0].active).toBe(1); // Default value
    });
  });

  describe("getMigrationStatus", () => {
    test("shows all pending for fresh database", () => {
      const migrations = [
        createMigration(1, "first"),
        createMigration(2, "second"),
      ];

      const status = getMigrationStatus(db, migrations);

      expect(status.current_version).toBe(0);
      expect(status.pending).toHaveLength(2);
      expect(status.applied).toEqual([]);
    });

    test("shows only unapplied as pending", () => {
      const migrations = [
        createMigration(1, "first", "CREATE TABLE t1 (id INTEGER)"),
        createMigration(2, "second"),
        createMigration(3, "third"),
      ];

      runMigrations(db, [migrations[0]]);
      const status = getMigrationStatus(db, migrations);

      expect(status.current_version).toBe(1);
      expect(status.pending).toHaveLength(2);
      expect(status.pending[0].version).toBe(2);
    });
  });

  describe("dryRunMigrations", () => {
    test("reports what would be applied", () => {
      const migrations = [
        createMigration(1, "create users"),
        createMigration(2, "add index"),
      ];

      const result = dryRunMigrations(db, migrations);

      expect(result.current_version).toBe(0);
      expect(result.would_apply).toHaveLength(2);
      expect(result.would_apply[0].version).toBe(1);
      expect(result.would_apply[0].description).toBe("create users");
    });

    test("shows nothing to apply when up to date", () => {
      const m1 = createMigration(1, "first", "CREATE TABLE t1 (id INTEGER)");
      runMigrations(db, [m1]);

      const result = dryRunMigrations(db, [m1]);

      expect(result.current_version).toBe(1);
      expect(result.would_apply).toHaveLength(0);
    });
  });

  describe("validateMigrations", () => {
    test("passes for valid migrations", () => {
      const errors = validateMigrations([
        createMigration(1, "first"),
        createMigration(2, "second"),
      ]);
      expect(errors).toEqual([]);
    });

    test("catches duplicate versions", () => {
      const errors = validateMigrations([
        createMigration(1, "first"),
        createMigration(1, "duplicate"),
      ]);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("Duplicate");
    });

    test("catches invalid version numbers", () => {
      const errors = validateMigrations([
        createMigration(0, "zero"),
        createMigration(-1, "negative"),
      ]);
      expect(errors).toHaveLength(2);
    });

    test("catches empty descriptions", () => {
      const errors = validateMigrations([
        createMigration(1, ""),
        createMigration(2, "  "),
      ]);
      expect(errors).toHaveLength(2);
    });
  });
});

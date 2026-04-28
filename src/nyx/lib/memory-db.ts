/**
 * FTS5-backed cross-session memory for nyx chat.
 * DB lives at ~/.nyxhive/nyx-cli-memory.db
 */

import { Database } from "bun:sqlite";
import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";

const DB_PATH = join(homedir(), ".nyxhive", "nyx-cli-memory.db");

let _db: Database | null = null;

function db(): Database {
  if (_db) return _db;

  mkdirSync(join(homedir(), ".nyxhive"), { recursive: true });
  _db = new Database(DB_PATH);
  _db.exec("PRAGMA journal_mode=WAL;");
  _db.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      content   TEXT    NOT NULL,
      source    TEXT    NOT NULL DEFAULT 'manual',
      created_at INTEGER NOT NULL
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
      content,
      content='memories',
      content_rowid='id'
    );
    CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
    END;
    CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.id, old.content);
    END;
  `);
  return _db;
}

export interface Memory {
  id: number;
  content: string;
  source: string;
  created_at: number;
}

export function insertMemory(content: string, source = "manual"): void {
  db()
    .prepare("INSERT INTO memories (content, source, created_at) VALUES (?, ?, ?)")
    .run(content, source, Date.now());
}

export function searchMemory(query: string, limit = 5): Memory[] {
  return db()
    .prepare(
      `SELECT m.id, m.content, m.source, m.created_at
       FROM memories_fts f
       JOIN memories m ON m.id = f.rowid
       WHERE memories_fts MATCH ?
       ORDER BY rank
       LIMIT ?`,
    )
    .all(query, limit) as Memory[];
}

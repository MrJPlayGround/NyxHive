import type { Migration } from "./runner.js";

export const migration: Migration = {
  version: 1,
  description: "Add classification_log table for router accuracy tracking",
  up(db) {
    db.run(`
      CREATE TABLE IF NOT EXISTS classification_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        prompt TEXT NOT NULL,
        local_result TEXT NOT NULL,
        llm_result TEXT,
        final_result TEXT NOT NULL,
        confidence REAL,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      )
    `);
  },
};

import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";

describe("message priority", () => {
  test("system messages claimed before user messages", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT UNIQUE, channel TEXT, sender TEXT, message TEXT,
        agent TEXT, status TEXT DEFAULT 'pending', priority INTEGER DEFAULT 1,
        created_at INTEGER, updated_at INTEGER
      )
    `);

    const now = Date.now();
    db.prepare("INSERT INTO messages (message_id, channel, sender, message, agent, status, priority, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run("msg-1", "discord", "user1", "Hello", "nyx", "pending", 1, now, now);
    db.prepare("INSERT INTO messages (message_id, channel, sender, message, agent, status, priority, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run("msg-2", "system", "scheduler", "Run evolution", "nyx", "pending", 2, now + 1, now + 1);

    const claimed = db.prepare(
      "SELECT * FROM messages WHERE status = 'pending' ORDER BY priority DESC, created_at ASC LIMIT 1"
    ).get() as any;

    expect(claimed.message_id).toBe("msg-2");
    expect(claimed.priority).toBe(2);
  });

  test("background messages claimed last", () => {
    const db = new Database(":memory:");
    db.exec(`
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT UNIQUE, channel TEXT, sender TEXT, message TEXT,
        agent TEXT, status TEXT DEFAULT 'pending', priority INTEGER DEFAULT 1,
        created_at INTEGER, updated_at INTEGER
      )
    `);

    const now = Date.now();
    db.prepare("INSERT INTO messages (message_id, channel, sender, message, agent, status, priority, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run("msg-bg", "background", "system", "Low priority", "nyx", "pending", 0, now, now);
    db.prepare("INSERT INTO messages (message_id, channel, sender, message, agent, status, priority, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run("msg-normal", "discord", "user1", "Normal message", "nyx", "pending", 1, now + 1, now + 1);

    const claimed = db.prepare(
      "SELECT * FROM messages WHERE status = 'pending' ORDER BY priority DESC, created_at ASC LIMIT 1"
    ).get() as any;

    expect(claimed.message_id).toBe("msg-normal");
    expect(claimed.priority).toBe(1);
  });
});

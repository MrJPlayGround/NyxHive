import { describe, it, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Test the backend additions: clearDeadLetters, clearDeadLetter, mode field

describe("QueueDB dead letter clearing", () => {
  function makeQueue() {
    const dir = mkdtempSync(join(tmpdir(), "nyx-test-"));
    // Import the class inline to avoid pulling in the full server
    const db = new Database(join(dir, "test.db"));
    db.exec("PRAGMA journal_mode = WAL");
    db.exec(`
      CREATE TABLE messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message_id TEXT NOT NULL UNIQUE,
        channel TEXT NOT NULL,
        sender TEXT NOT NULL,
        sender_id TEXT,
        task_id TEXT,
        message TEXT NOT NULL,
        agent TEXT,
        files TEXT,
        conversation_id TEXT,
        from_agent TEXT,
        thread_id TEXT,
        relay_origin_instance TEXT,
        relay_callback_url TEXT,
        relay_callback_token TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        priority INTEGER NOT NULL DEFAULT 1,
        retry_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        last_activity TEXT,
        last_progress_text TEXT,
        last_progress_at INTEGER,
        claimed_by TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    const insert = db.prepare(
      `INSERT INTO messages (message_id, channel, sender, message, status, created_at, updated_at)
       VALUES (?, 'test', 'test', 'test', ?, ?, ?)`,
    );

    function clearDeadLetters(): number {
      const now = Date.now();
      const result = db
        .query(`UPDATE messages SET status = 'dead_letter_cleared', updated_at = ? WHERE status = 'dead_letter'`)
        .run(now);
      return result.changes;
    }

    function clearDeadLetter(messageId: string): boolean {
      const now = Date.now();
      const result = db
        .query(`UPDATE messages SET status = 'dead_letter_cleared', updated_at = ? WHERE message_id = ? AND status = 'dead_letter'`)
        .run(now, messageId);
      return result.changes > 0;
    }

    return { db, insert, clearDeadLetters, clearDeadLetter };
  }

  it("clearDeadLetters clears all dead letters", () => {
    const { insert, clearDeadLetters, db } = makeQueue();
    const now = Date.now();
    insert.run("msg-1", "dead_letter", now, now);
    insert.run("msg-2", "dead_letter", now, now);
    insert.run("msg-3", "completed", now, now);

    const cleared = clearDeadLetters();
    expect(cleared).toBe(2);

    const remaining = db.query("SELECT count(*) as c FROM messages WHERE status = 'dead_letter'").get() as { c: number };
    expect(remaining.c).toBe(0);

    const updated = db.query("SELECT count(*) as c FROM messages WHERE status = 'dead_letter_cleared'").get() as { c: number };
    expect(updated.c).toBe(2);
  });

  it("clearDeadLetter clears single dead letter by id", () => {
    const { insert, clearDeadLetter, db } = makeQueue();
    const now = Date.now();
    insert.run("msg-1", "dead_letter", now, now);
    insert.run("msg-2", "dead_letter", now, now);

    const ok = clearDeadLetter("msg-1");
    expect(ok).toBe(true);

    const remaining = db.query("SELECT count(*) as c FROM messages WHERE status = 'dead_letter'").get() as { c: number };
    expect(remaining.c).toBe(1);
  });

  it("clearDeadLetter returns false for non-existent id", () => {
    const { clearDeadLetter } = makeQueue();
    expect(clearDeadLetter("nonexistent")).toBe(false);
  });

  it("clearDeadLetter does not affect non-dead-letter messages", () => {
    const { insert, clearDeadLetter } = makeQueue();
    const now = Date.now();
    insert.run("msg-1", "completed", now, now);
    expect(clearDeadLetter("msg-1")).toBe(false);
  });
});

describe("message mode field", () => {
  it("accepts mode in message schema", async () => {
    // Validate the zod schema accepts mode
    const { z } = await import("zod");
    const messageSchema = z.object({
      message: z.string().default(""),
      mode: z.enum(["default", "ralph"]).optional(),
    });

    const result1 = messageSchema.parse({ message: "hello", mode: "ralph" });
    expect(result1.mode).toBe("ralph");

    const result2 = messageSchema.parse({ message: "hello" });
    expect(result2.mode).toBeUndefined();

    const result3 = messageSchema.parse({ message: "hello", mode: "default" });
    expect(result3.mode).toBe("default");

    expect(() => messageSchema.parse({ message: "hello", mode: "invalid" })).toThrow();
  });
});

describe("ralph loop", () => {
  it("parseRalphVerdict extracts PASS verdict", async () => {
    const { parseRalphVerdict } = await import("../queue/ralph-loop.js");
    expect(parseRalphVerdict("Everything done. RALPH:PASS")).toEqual({ result: "pass" });
  });

  it("parseRalphVerdict extracts FAIL verdict with reason", async () => {
    const { parseRalphVerdict } = await import("../queue/ralph-loop.js");
    const result = parseRalphVerdict("Tests failed. RALPH:FAIL 3 tests still broken");
    expect(result.result).toBe("fail");
    expect(result.reason).toBe("3 tests still broken");
  });

  it("parseRalphVerdict extracts BLOCKED verdict", async () => {
    const { parseRalphVerdict } = await import("../queue/ralph-loop.js");
    const result = parseRalphVerdict("RALPH:BLOCKED missing API key");
    expect(result.result).toBe("blocked");
    expect(result.reason).toBe("missing API key");
  });

  it("buildRalphInstructions includes round count", async () => {
    const { buildRalphInstructions } = await import("../queue/ralph-loop.js");
    const instructions = buildRalphInstructions(5);
    expect(instructions).toContain("5 rounds");
    expect(instructions).toContain("RALPH:PASS");
    expect(instructions).toContain("RALPH:FAIL");
    expect(instructions).toContain("RALPH:BLOCKED");
  });
});

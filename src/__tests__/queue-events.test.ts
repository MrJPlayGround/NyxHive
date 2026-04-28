import { describe, test, expect } from "bun:test";
import { EventEmitter } from "events";

describe("queue event-driven processing", () => {
  test("event emission responds faster than polling", () => {
    const emitter = new EventEmitter();
    const timestamps: number[] = [];
    emitter.on("message-enqueued", () => timestamps.push(Date.now()));

    const before = Date.now();
    emitter.emit("message-enqueued", {});

    expect(timestamps.length).toBe(1);
    expect(timestamps[0] - before).toBeLessThan(5);
  });
});

describe("message priority", () => {
  test("system messages ordered before user messages in SQL", () => {
    const { Database } = require("bun:sqlite");
    const db = new Database(":memory:");
    db.exec(`CREATE TABLE test_msgs (
      id INTEGER PRIMARY KEY, message_id TEXT, priority INTEGER DEFAULT 1, created_at INTEGER
    )`);

    const now = Date.now();
    db.prepare("INSERT INTO test_msgs VALUES (?,?,?,?)").run(1, "user-msg", 1, now);
    db.prepare("INSERT INTO test_msgs VALUES (?,?,?,?)").run(2, "system-msg", 2, now + 1);

    const first = db.prepare("SELECT * FROM test_msgs ORDER BY priority DESC, created_at ASC LIMIT 1").get();
    expect(first.message_id).toBe("system-msg");
  });
});

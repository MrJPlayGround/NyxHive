import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { QueueDB } from "../queue/db.js";

describe("QueueDB.checkSenderRateLimit", () => {
  let tmpDir: string;
  let db: QueueDB;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nyxhive-ratelimit-test-"));
    db = new QueueDB(tmpDir);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("allows first message from a sender", () => {
    expect(db.checkSenderRateLimit("user1")).toBe(true);
  });

  test("allows messages up to default limit (10)", () => {
    for (let i = 0; i < 10; i++) {
      expect(db.checkSenderRateLimit("user1")).toBe(true);
    }
  });

  test("blocks the 11th message in the same window", () => {
    for (let i = 0; i < 10; i++) {
      db.checkSenderRateLimit("user1");
    }
    expect(db.checkSenderRateLimit("user1")).toBe(false);
  });

  test("independent rate limits per sender", () => {
    for (let i = 0; i < 10; i++) {
      db.checkSenderRateLimit("user1");
    }
    // user1 is rate limited
    expect(db.checkSenderRateLimit("user1")).toBe(false);
    // user2 should still be allowed
    expect(db.checkSenderRateLimit("user2")).toBe(true);
  });

  test("respects custom maxPerMinute", () => {
    db.checkSenderRateLimit("user1", 3);
    db.checkSenderRateLimit("user1", 3);
    db.checkSenderRateLimit("user1", 3);
    expect(db.checkSenderRateLimit("user1", 3)).toBe(false);
  });

  test("allows at exactly the limit boundary", () => {
    // exactly maxPerMinute calls should all succeed
    const max = 5;
    for (let i = 0; i < max; i++) {
      expect(db.checkSenderRateLimit("user1", max)).toBe(true);
    }
    // one more exceeds
    expect(db.checkSenderRateLimit("user1", max)).toBe(false);
  });

  test("different senders with same scope are tracked independently", () => {
    // Simulate two users in the same group (different normalizeSenderId results)
    for (let i = 0; i < 10; i++) {
      db.checkSenderRateLimit("user1:group1");
    }
    expect(db.checkSenderRateLimit("user1:group1")).toBe(false);
    expect(db.checkSenderRateLimit("user2:group1")).toBe(true);
  });

  test("continues blocking after first block", () => {
    for (let i = 0; i < 10; i++) {
      db.checkSenderRateLimit("user1");
    }
    expect(db.checkSenderRateLimit("user1")).toBe(false);
    expect(db.checkSenderRateLimit("user1")).toBe(false);
    expect(db.checkSenderRateLimit("user1")).toBe(false);
  });
});

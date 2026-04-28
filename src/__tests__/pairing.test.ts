import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { PairingStore } from "../pairing/pairing.js";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("PairingStore", () => {
  let tmpDir: string;
  let store: PairingStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nyxhive-pairing-test-"));
    store = new PairingStore(tmpDir);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("generateCode", () => {
    test("creates an 8-char uppercase hex code", () => {
      const code = store.generateCode("telegram", "123", "User");
      expect(code).toMatch(/^[A-F0-9]{8}$/);
    });

    test("upserts — same channel/sender_id gets new code", () => {
      const code1 = store.generateCode("telegram", "123", "User");
      const code2 = store.generateCode("telegram", "123", "User");
      expect(code1).not.toBe(code2);
      const pending = store.listPending();
      const forUser = pending.filter((p) => p.channel === "telegram" && p.sender_id === "123");
      expect(forUser.length).toBe(1);
      expect(forUser[0].code).toBe(code2);
    });
  });

  describe("isApproved", () => {
    test("returns false before approval", () => {
      expect(store.isApproved("telegram", "123")).toBe(false);
    });

    test("returns true after approval", () => {
      const code = store.generateCode("telegram", "123", "User");
      store.approve(code);
      expect(store.isApproved("telegram", "123")).toBe(true);
    });
  });

  describe("approve", () => {
    test("with valid code returns user info", () => {
      const code = store.generateCode("telegram", "123", "User");
      const result = store.approve(code);
      expect(result).not.toBeNull();
      expect(result!.channel).toBe("telegram");
      expect(result!.sender_id).toBe("123");
      expect(result!.sender).toBe("User");
    });

    test("with invalid code returns null", () => {
      expect(store.approve("INVALID")).toBeNull();
    });

    test("removes the pending entry", () => {
      const code = store.generateCode("telegram", "123", "User");
      store.approve(code);
      expect(store.listPending().length).toBe(0);
    });

    test("adds entry to approved list", () => {
      const code = store.generateCode("telegram", "123", "User");
      store.approve(code);
      const approved = store.listApproved();
      expect(approved.length).toBe(1);
      expect(approved[0].channel).toBe("telegram");
      expect(approved[0].sender_id).toBe("123");
      expect(approved[0].sender).toBe("User");
      expect(approved[0].approved_at).toBeGreaterThan(0);
    });

    test("returns null for expired code (>24h old)", () => {
      const code = store.generateCode("telegram", "123", "User");
      // Directly insert old timestamp
      const db = new Database(join(tmpDir, "nyxhive.db"));
      const twentyFiveHoursAgo = Date.now() - 25 * 60 * 60 * 1000;
      db.run("UPDATE pairing_pending SET created_at = ? WHERE code = ?", [twentyFiveHoursAgo, code]);
      db.close();

      expect(store.approve(code)).toBeNull();
    });
  });

  describe("revoke", () => {
    test("removes approved user and returns true", () => {
      const code = store.generateCode("telegram", "123", "User");
      store.approve(code);
      expect(store.revoke("telegram", "123")).toBe(true);
      expect(store.isApproved("telegram", "123")).toBe(false);
    });

    test("returns false for non-existent user", () => {
      expect(store.revoke("telegram", "999")).toBe(false);
    });
  });

  describe("listApproved", () => {
    test("returns entries in descending order by approved_at", () => {
      const code1 = store.generateCode("telegram", "123", "User");
      store.approve(code1);
      const code2 = store.generateCode("discord", "456", "Other");
      store.approve(code2);
      const approved = store.listApproved();
      expect(approved.length).toBe(2);
      expect(approved[0].approved_at).toBeGreaterThanOrEqual(approved[1].approved_at);
    });
  });

  describe("listPending", () => {
    test("returns correct entries", () => {
      store.generateCode("telegram", "123", "User");
      store.generateCode("discord", "456", "Other");
      expect(store.listPending().length).toBe(2);
    });

    test("does not include approved entries", () => {
      const code = store.generateCode("telegram", "123", "User");
      store.generateCode("discord", "456", "Other");
      store.approve(code);
      const pending = store.listPending();
      expect(pending.length).toBe(1);
      expect(pending[0].channel).toBe("discord");
    });
  });
});

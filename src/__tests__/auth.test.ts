import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { AuthStore } from "../auth/store.js";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("AuthStore", () => {
  let tmpDir: string;
  let db: Database;
  let store: AuthStore;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nyxhive-auth-test-"));
    db = new Database(join(tmpDir, "test.db"));
    db.exec("PRAGMA journal_mode = WAL");
    store = new AuthStore(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("createUser", () => {
    test("creates user with bcrypt hash", async () => {
      const user = await store.createUser("test@example.com", "Test User", "password123", "user");
      expect(user.email).toBe("test@example.com");
      expect(user.display_name).toBe("Test User");
      expect(user.role).toBe("user");
      // password_hash should not be in the safe user
      expect((user as any).password_hash).toBeUndefined();
    });

    test("email is lowercased", async () => {
      const user = await store.createUser("Test@Example.COM", "Test", "password123", "user");
      expect(user.email).toBe("test@example.com");
    });

    test("rejects duplicate email", async () => {
      await store.createUser("test@example.com", "Test", "password123", "user");
      expect(
        store.createUser("test@example.com", "Test 2", "password456", "user"),
      ).rejects.toThrow();
    });
  });

  describe("authenticate", () => {
    test("succeeds with correct password", async () => {
      await store.createUser("test@example.com", "Test", "password123", "user");
      const result = await store.authenticate("test@example.com", "password123");
      expect(result).not.toBeNull();
      expect(result!.user.email).toBe("test@example.com");
      expect(result!.session.id).toBeTruthy();
      expect(result!.session.expires_at).toBeTruthy();
    });

    test("fails with wrong password", async () => {
      await store.createUser("test@example.com", "Test", "password123", "user");
      const result = await store.authenticate("test@example.com", "wrongpassword");
      expect(result).toBeNull();
    });

    test("fails with non-existent email", async () => {
      const result = await store.authenticate("nobody@example.com", "password123");
      expect(result).toBeNull();
    });

    test("fails for inactive user", async () => {
      const user = await store.createUser("test@example.com", "Test", "password123", "user");
      store.updateUser(user.id, { is_active: 0 });
      const result = await store.authenticate("test@example.com", "password123");
      expect(result).toBeNull();
    });

    test("updates last_login_at", async () => {
      await store.createUser("test@example.com", "Test", "password123", "user");
      const before = store.getUserByEmail("test@example.com");
      expect(before!.last_login_at).toBeNull();

      await store.authenticate("test@example.com", "password123");
      const after = store.getUserByEmail("test@example.com");
      expect(after!.last_login_at).not.toBeNull();
    });
  });

  describe("validateSession", () => {
    test("returns user for valid session", async () => {
      await store.createUser("test@example.com", "Test", "password123", "user");
      const result = await store.authenticate("test@example.com", "password123");
      const user = store.validateSession(result!.session.id);
      expect(user).not.toBeNull();
      expect(user!.email).toBe("test@example.com");
    });

    test("returns null for invalid session", () => {
      const user = store.validateSession("nonexistent-session-id");
      expect(user).toBeNull();
    });

    test("returns null for expired session", async () => {
      await store.createUser("test@example.com", "Test", "password123", "user");
      const result = await store.authenticate("test@example.com", "password123");

      // Manually expire the session
      db.run("UPDATE sessions SET expires_at = datetime('now', '-1 day') WHERE id = ?", [result!.session.id]);

      const user = store.validateSession(result!.session.id);
      expect(user).toBeNull();
    });
  });

  describe("revokeSession", () => {
    test("revoked session no longer validates", async () => {
      await store.createUser("test@example.com", "Test", "password123", "user");
      const result = await store.authenticate("test@example.com", "password123");
      const sessionId = result!.session.id;

      expect(store.validateSession(sessionId)).not.toBeNull();
      store.revokeSession(sessionId);
      expect(store.validateSession(sessionId)).toBeNull();
    });
  });

  describe("revokeAllSessions", () => {
    test("revokes all sessions for user", async () => {
      const user = await store.createUser("test@example.com", "Test", "password123", "user");
      await store.authenticate("test@example.com", "password123");
      await store.authenticate("test@example.com", "password123");
      expect(store.getSessionCount(user.id)).toBe(2);

      const revoked = store.revokeAllSessions(user.id);
      expect(revoked).toBe(2);
      expect(store.getSessionCount(user.id)).toBe(0);
    });
  });

  describe("changePassword", () => {
    test("succeeds with correct old password", async () => {
      const user = await store.createUser("test@example.com", "Test", "password123", "user");
      const ok = await store.changePassword(user.id, "password123", "newpassword456");
      expect(ok).toBe(true);

      // Old password fails
      const fail = await store.authenticate("test@example.com", "password123");
      expect(fail).toBeNull();

      // New password works
      const success = await store.authenticate("test@example.com", "newpassword456");
      expect(success).not.toBeNull();
    });

    test("fails with wrong old password", async () => {
      const user = await store.createUser("test@example.com", "Test", "password123", "user");
      const ok = await store.changePassword(user.id, "wrongpassword", "newpassword456");
      expect(ok).toBe(false);
    });
  });

  describe("resetPassword", () => {
    test("resets password and revokes sessions", async () => {
      const user = await store.createUser("test@example.com", "Test", "password123", "user");
      await store.authenticate("test@example.com", "password123");
      expect(store.getSessionCount(user.id)).toBe(1);

      await store.resetPassword(user.id, "resetpassword789");
      expect(store.getSessionCount(user.id)).toBe(0);

      const result = await store.authenticate("test@example.com", "resetpassword789");
      expect(result).not.toBeNull();
    });
  });

  describe("invites", () => {
    test("creates and validates invite", async () => {
      const owner = await store.createUser("owner@example.com", "Owner", "password123", "owner");
      const invite = store.createInvite(owner.id, "user");
      expect(invite.code).toHaveLength(8);
      expect(invite.role).toBe("user");

      const valid = store.validateInvite(invite.code);
      expect(valid).not.toBeNull();
      expect(valid!.code).toBe(invite.code);
    });

    test("consume decrements uses", async () => {
      const owner = await store.createUser("owner@example.com", "Owner", "password123", "owner");
      const invite = store.createInvite(owner.id, "user", { maxUses: 1 });

      expect(store.consumeInvite(invite.code)).toBe(true);
      // Now used up
      expect(store.validateInvite(invite.code)).toBeNull();
      expect(store.consumeInvite(invite.code)).toBe(false);
    });

    test("expired invite is invalid", async () => {
      const owner = await store.createUser("owner@example.com", "Owner", "password123", "owner");
      const invite = store.createInvite(owner.id, "user");

      // Manually expire
      db.run("UPDATE invites SET expires_at = datetime('now', '-1 hour') WHERE code = ?", [invite.code]);
      expect(store.validateInvite(invite.code)).toBeNull();
    });

    test("invalid code returns null", () => {
      expect(store.validateInvite("badcode!")).toBeNull();
    });
  });

  describe("user management", () => {
    test("listUsers returns all users", async () => {
      await store.createUser("a@example.com", "A", "password123", "owner");
      await store.createUser("b@example.com", "B", "password123", "user");
      const users = store.listUsers();
      expect(users).toHaveLength(2);
    });

    test("getUserCount", async () => {
      expect(store.getUserCount()).toBe(0);
      await store.createUser("test@example.com", "Test", "password123", "user");
      expect(store.getUserCount()).toBe(1);
    });

    test("updateUser changes role", async () => {
      const user = await store.createUser("test@example.com", "Test", "password123", "user");
      const updated = store.updateUser(user.id, { role: "admin" });
      expect(updated!.role).toBe("admin");
    });

    test("deleteUser removes user", async () => {
      const user = await store.createUser("test@example.com", "Test", "password123", "user");
      expect(store.deleteUser(user.id)).toBe(true);
      expect(store.getUserById(user.id)).toBeNull();
    });
  });

  describe("purgeExpiredSessions", () => {
    test("removes expired sessions", async () => {
      await store.createUser("test@example.com", "Test", "password123", "user");
      const result = await store.authenticate("test@example.com", "password123");

      // Expire the session
      db.run("UPDATE sessions SET expires_at = datetime('now', '-1 day') WHERE id = ?", [result!.session.id]);

      const purged = store.purgeExpiredSessions();
      expect(purged).toBe(1);
    });
  });
});

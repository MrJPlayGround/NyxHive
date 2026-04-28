import { describe, it, expect, beforeEach } from "bun:test"
import { Database } from "bun:sqlite"
import { AuthStore } from "../auth/store.js"

describe("AuthStore", () => {
  let store: AuthStore
  let db: Database

  beforeEach(() => {
    db = new Database(":memory:")
    store = new AuthStore(db)
  })

  describe("user CRUD", () => {
    it("creates a user and returns safe user (no hash)", async () => {
      const user = await store.createUser("test@example.com", "Test User", "password123", "user")
      expect(user.email).toBe("test@example.com")
      expect(user.display_name).toBe("Test User")
      expect(user.role).toBe("user")
      expect(user.is_active).toBe(1)
      expect((user as any).password_hash).toBeUndefined()
    })

    it("lowercases email on create", async () => {
      const user = await store.createUser("TEST@Example.COM", "Test", "pass", "user")
      expect(user.email).toBe("test@example.com")
    })

    it("gets user by email", async () => {
      await store.createUser("test@example.com", "Test", "pass", "user")
      const user = store.getUserByEmail("test@example.com")
      expect(user).not.toBeNull()
      expect(user!.email).toBe("test@example.com")
    })

    it("getUserByEmail is case-insensitive", async () => {
      await store.createUser("test@example.com", "Test", "pass", "user")
      const user = store.getUserByEmail("TEST@Example.COM")
      expect(user).not.toBeNull()
    })

    it("gets user by id", async () => {
      const created = await store.createUser("test@example.com", "Test", "pass", "user")
      const user = store.getUserById(created.id)
      expect(user).not.toBeNull()
      expect(user!.id).toBe(created.id)
    })

    it("returns null for non-existent user", () => {
      expect(store.getUserByEmail("nobody@example.com")).toBeNull()
      expect(store.getUserById("fake-id")).toBeNull()
    })

    it("lists all users", async () => {
      await store.createUser("a@test.com", "A", "pass", "user")
      await store.createUser("b@test.com", "B", "pass", "admin")
      const users = store.listUsers()
      expect(users).toHaveLength(2)
    })

    it("counts users", async () => {
      expect(store.getUserCount()).toBe(0)
      await store.createUser("a@test.com", "A", "pass", "user")
      expect(store.getUserCount()).toBe(1)
    })

    it("updates user fields", async () => {
      const user = await store.createUser("test@example.com", "Test", "pass", "user")
      const updated = store.updateUser(user.id, { display_name: "New Name", role: "admin" })
      expect(updated!.display_name).toBe("New Name")
      expect(updated!.role).toBe("admin")
    })

    it("update with no changes returns user as-is", async () => {
      const user = await store.createUser("test@example.com", "Test", "pass", "user")
      const result = store.updateUser(user.id, {})
      expect(result!.id).toBe(user.id)
    })

    it("deletes a user", async () => {
      const user = await store.createUser("test@example.com", "Test", "pass", "user")
      expect(store.deleteUser(user.id)).toBe(true)
      expect(store.getUserById(user.id)).toBeNull()
    })

    it("deleteUser returns false for non-existent user", () => {
      expect(store.deleteUser("fake-id")).toBe(false)
    })

    it("does not return inactive users by email", async () => {
      const user = await store.createUser("test@example.com", "Test", "pass", "user")
      store.updateUser(user.id, { is_active: 0 })
      expect(store.getUserByEmail("test@example.com")).toBeNull()
    })
  })

  describe("authentication", () => {
    it("authenticates with correct credentials", async () => {
      await store.createUser("test@example.com", "Test", "password123", "user")
      const result = await store.authenticate("test@example.com", "password123")
      expect(result).not.toBeNull()
      expect(result!.user.email).toBe("test@example.com")
      expect(result!.session.user_id).toBe(result!.user.id)
    })

    it("returns null with wrong password", async () => {
      await store.createUser("test@example.com", "Test", "password123", "user")
      const result = await store.authenticate("test@example.com", "wrong")
      expect(result).toBeNull()
    })

    it("returns null for non-existent email", async () => {
      const result = await store.authenticate("nobody@example.com", "pass")
      expect(result).toBeNull()
    })

    it("returns null for inactive user", async () => {
      const user = await store.createUser("test@example.com", "Test", "pass", "user")
      store.updateUser(user.id, { is_active: 0 })
      const result = await store.authenticate("test@example.com", "pass")
      expect(result).toBeNull()
    })

    it("records IP and user agent in session", async () => {
      await store.createUser("test@example.com", "Test", "pass", "user")
      const result = await store.authenticate("test@example.com", "pass", {
        ip: "192.168.1.1",
        userAgent: "TestBrowser/1.0",
      })
      expect(result!.session.ip_address).toBe("192.168.1.1")
      expect(result!.session.user_agent).toBe("TestBrowser/1.0")
    })
  })

  describe("session management", () => {
    it("validates a valid session", async () => {
      await store.createUser("test@example.com", "Test", "pass", "user")
      const auth = await store.authenticate("test@example.com", "pass")
      const user = store.validateSession(auth!.session.id)
      expect(user).not.toBeNull()
      expect(user!.email).toBe("test@example.com")
    })

    it("returns null for non-existent session", () => {
      expect(store.validateSession("fake-session")).toBeNull()
    })

    it("rejects session with IP mismatch", async () => {
      await store.createUser("test@example.com", "Test", "pass", "user")
      const auth = await store.authenticate("test@example.com", "pass", { ip: "1.2.3.4" })
      const user = store.validateSession(auth!.session.id, { ip: "5.6.7.8" })
      expect(user).toBeNull()
    })

    it("accepts session with matching IP", async () => {
      await store.createUser("test@example.com", "Test", "pass", "user")
      const auth = await store.authenticate("test@example.com", "pass", { ip: "1.2.3.4" })
      const user = store.validateSession(auth!.session.id, { ip: "1.2.3.4" })
      expect(user).not.toBeNull()
    })

    it("revokes a session", async () => {
      await store.createUser("test@example.com", "Test", "pass", "user")
      const auth = await store.authenticate("test@example.com", "pass")
      expect(store.revokeSession(auth!.session.id)).toBe(true)
      expect(store.validateSession(auth!.session.id)).toBeNull()
    })

    it("revokes all sessions for a user", async () => {
      const user = await store.createUser("test@example.com", "Test", "pass", "user")
      await store.authenticate("test@example.com", "pass")
      await store.authenticate("test@example.com", "pass")
      expect(store.getSessionCount(user.id)).toBe(2)
      const revoked = store.revokeAllSessions(user.id)
      expect(revoked).toBe(2)
      expect(store.getSessionCount(user.id)).toBe(0)
    })

    it("counts active sessions", async () => {
      const user = await store.createUser("test@example.com", "Test", "pass", "user")
      expect(store.getSessionCount(user.id)).toBe(0)
      await store.authenticate("test@example.com", "pass")
      expect(store.getSessionCount(user.id)).toBe(1)
    })
  })

  describe("password management", () => {
    it("changes password with correct old password", async () => {
      const user = await store.createUser("test@example.com", "Test", "oldpass", "user")
      const result = await store.changePassword(user.id, "oldpass", "newpass")
      expect(result).toBe(true)
      // Can authenticate with new password
      const auth = await store.authenticate("test@example.com", "newpass")
      expect(auth).not.toBeNull()
    })

    it("rejects password change with wrong old password", async () => {
      const user = await store.createUser("test@example.com", "Test", "oldpass", "user")
      const result = await store.changePassword(user.id, "wrongpass", "newpass")
      expect(result).toBe(false)
    })

    it("rejects password change for non-existent user", async () => {
      const result = await store.changePassword("fake-id", "old", "new")
      expect(result).toBe(false)
    })

    it("revokes other sessions on password change but keeps current", async () => {
      const user = await store.createUser("test@example.com", "Test", "oldpass", "user")
      const auth1 = await store.authenticate("test@example.com", "oldpass")
      const auth2 = await store.authenticate("test@example.com", "oldpass")
      expect(store.getSessionCount(user.id)).toBe(2)

      // Change password, keeping auth1's session
      const result = await store.changePassword(user.id, "oldpass", "newpass", auth1!.session.id)
      expect(result).toBe(true)
      expect(store.getSessionCount(user.id)).toBe(1)

      // The kept session is still valid
      const validated = store.validateSession(auth1!.session.id)
      expect(validated).not.toBeNull()

      // The other session is revoked
      const revoked = store.validateSession(auth2!.session.id)
      expect(revoked).toBeNull()
    })

    it("revokes all sessions on password change without currentSessionId", async () => {
      const user = await store.createUser("test@example.com", "Test", "oldpass", "user")
      await store.authenticate("test@example.com", "oldpass")
      await store.authenticate("test@example.com", "oldpass")
      expect(store.getSessionCount(user.id)).toBe(2)

      const result = await store.changePassword(user.id, "oldpass", "newpass")
      expect(result).toBe(true)
      expect(store.getSessionCount(user.id)).toBe(0)
    })

    it("resets password without requiring old password", async () => {
      const user = await store.createUser("test@example.com", "Test", "oldpass", "user")
      await store.authenticate("test@example.com", "oldpass") // Create a session
      await store.resetPassword(user.id, "resetpass")
      // Can authenticate with new password
      const auth = await store.authenticate("test@example.com", "resetpass")
      expect(auth).not.toBeNull()
      // Old sessions are revoked
      expect(store.getSessionCount(user.id)).toBe(1) // only the new one
    })
  })

  describe("invites", () => {
    it("creates an invite with code", async () => {
      const invite = store.createInvite("admin-id", "user")
      expect(invite.code).toBeDefined()
      expect(invite.code.length).toBe(8)
      expect(invite.created_by).toBe("admin-id")
      expect(invite.role).toBe("user")
      expect(invite.max_uses).toBe(1)
      expect(invite.use_count).toBe(0)
    })

    it("validates a valid invite", () => {
      const invite = store.createInvite("admin-id", "user")
      const valid = store.validateInvite(invite.code)
      expect(valid).not.toBeNull()
      expect(valid!.code).toBe(invite.code)
    })

    it("returns null for non-existent invite", () => {
      expect(store.validateInvite("badcode")).toBeNull()
    })

    it("rejects exhausted invite", () => {
      const invite = store.createInvite("admin-id", "user", { maxUses: 1 })
      store.consumeInvite(invite.code) // use it
      expect(store.validateInvite(invite.code)).toBeNull()
    })

    it("allows multiple uses up to max", () => {
      const invite = store.createInvite("admin-id", "user", { maxUses: 3 })
      expect(store.consumeInvite(invite.code)).toBe(true)
      expect(store.consumeInvite(invite.code)).toBe(true)
      expect(store.consumeInvite(invite.code)).toBe(true)
      expect(store.consumeInvite(invite.code)).toBe(false) // exhausted
    })

    it("lists all invites", () => {
      store.createInvite("admin", "user")
      store.createInvite("admin", "admin")
      const invites = store.listInvites()
      expect(invites).toHaveLength(2)
    })

    it("deletes an invite", () => {
      const invite = store.createInvite("admin", "user")
      expect(store.deleteInvite(invite.code)).toBe(true)
      expect(store.validateInvite(invite.code)).toBeNull()
    })

    it("deleteInvite returns false for non-existent code", () => {
      expect(store.deleteInvite("badcode")).toBe(false)
    })
  })
})

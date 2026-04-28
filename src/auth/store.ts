import type { Database } from "bun:sqlite";
import { randomUUID, randomBytes } from "node:crypto";
import { logger } from "../utils/logger.js";
import type { User, SafeUser, Session, Invite, UserRole } from "./types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  ip_address TEXT,
  user_agent TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS invites (
  code TEXT PRIMARY KEY,
  created_by TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  max_uses INTEGER DEFAULT 1,
  use_count INTEGER DEFAULT 0,
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

function stripHash(user: User): SafeUser {
  const { password_hash: _, ...safe } = user;
  return safe;
}

export class AuthStore {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
    this.db.exec(SCHEMA);
    logger.info("[auth] Schema ready");
  }

  // --- User CRUD ---

  async createUser(email: string, displayName: string, password: string, role: UserRole): Promise<SafeUser> {
    const id = randomUUID();
    const hash = await Bun.password.hash(password, "bcrypt");
    const now = new Date().toISOString();

    this.db.run(
      `INSERT INTO users (id, email, display_name, password_hash, role, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, email.toLowerCase(), displayName, hash, role, now, now],
    );

    logger.info(`[auth] Created user ${email} (${role})`);
    return this.getUserById(id)!;
  }

  getUserByEmail(email: string): SafeUser | null {
    const row = this.db
      .query("SELECT * FROM users WHERE email = ? AND is_active = 1")
      .get(email.toLowerCase()) as User | null;
    return row ? stripHash(row) : null;
  }

  getUserById(id: string): SafeUser | null {
    const row = this.db
      .query("SELECT * FROM users WHERE id = ?")
      .get(id) as User | null;
    return row ? stripHash(row) : null;
  }

  listUsers(): SafeUser[] {
    const rows = this.db
      .query("SELECT * FROM users ORDER BY created_at ASC")
      .all() as User[];
    return rows.map(stripHash);
  }

  getUserCount(): number {
    const row = this.db
      .query("SELECT COUNT(*) as count FROM users")
      .get() as { count: number };
    return row.count;
  }

  updateUser(id: string, updates: { display_name?: string; role?: UserRole; is_active?: number }): SafeUser | null {
    const sets: string[] = [];
    const vals: (string | number | null)[] = [];
    if (updates.display_name !== undefined) { sets.push("display_name = ?"); vals.push(updates.display_name); }
    if (updates.role !== undefined) { sets.push("role = ?"); vals.push(updates.role); }
    if (updates.is_active !== undefined) { sets.push("is_active = ?"); vals.push(updates.is_active); }
    if (sets.length === 0) return this.getUserById(id);

    sets.push("updated_at = ?");
    vals.push(new Date().toISOString());
    vals.push(id);

    this.db.run(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`, vals);
    return this.getUserById(id);
  }

  deleteUser(id: string): boolean {
    const result = this.db.run("DELETE FROM users WHERE id = ?", [id]);
    return result.changes > 0;
  }

  // --- Authentication ---

  async authenticate(email: string, password: string, opts?: { ip?: string; userAgent?: string }): Promise<{ user: SafeUser; session: Session } | null> {
    const row = this.db
      .query("SELECT * FROM users WHERE email = ? AND is_active = 1")
      .get(email.toLowerCase()) as User | null;
    if (!row) return null;

    const valid = await Bun.password.verify(password, row.password_hash);
    if (!valid) return null;

    // Update last_login_at
    this.db.run("UPDATE users SET last_login_at = ? WHERE id = ?", [new Date().toISOString(), row.id]);

    const session = this.createSession(row.id, opts);
    return { user: stripHash(row), session };
  }

  private createSession(userId: string, opts?: { ip?: string; userAgent?: string; ttlDays?: number }): Session {
    const id = randomUUID();
    const ttlDays = opts?.ttlDays ?? 7;
    const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000).toISOString();
    const now = new Date().toISOString();

    this.db.run(
      `INSERT INTO sessions (id, user_id, expires_at, created_at, ip_address, user_agent)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [id, userId, expiresAt, now, opts?.ip ?? null, opts?.userAgent ?? null],
    );

    return { id, user_id: userId, expires_at: expiresAt, created_at: now, ip_address: opts?.ip ?? null, user_agent: opts?.userAgent ?? null };
  }

  validateSession(sessionId: string, opts?: { ip?: string }): SafeUser | null {
    const session = this.db
      .query("SELECT * FROM sessions WHERE id = ? AND expires_at > datetime('now')")
      .get(sessionId) as Session | null;
    if (!session) return null;
    // IP binding: if session was created with an IP and caller IP differs, reject
    if (opts?.ip && session.ip_address && session.ip_address !== opts.ip) {
      logger.warn(`[auth] Session ${sessionId.slice(0, 8)}… IP mismatch: expected ${session.ip_address}, got ${opts.ip}`);
      return null;
    }
    return this.getUserById(session.user_id);
  }

  revokeSession(sessionId: string): boolean {
    const result = this.db.run("DELETE FROM sessions WHERE id = ?", [sessionId]);
    return result.changes > 0;
  }

  revokeAllSessions(userId: string): number {
    const result = this.db.run("DELETE FROM sessions WHERE user_id = ?", [userId]);
    return result.changes;
  }

  getSessionCount(userId: string): number {
    const row = this.db
      .query("SELECT COUNT(*) as count FROM sessions WHERE user_id = ? AND expires_at > datetime('now')")
      .get(userId) as { count: number };
    return row.count;
  }

  // --- Password ---

  async changePassword(userId: string, oldPassword: string, newPassword: string, currentSessionId?: string): Promise<boolean> {
    const row = this.db
      .query("SELECT password_hash FROM users WHERE id = ?")
      .get(userId) as { password_hash: string } | null;
    if (!row) return false;

    const valid = await Bun.password.verify(oldPassword, row.password_hash);
    if (!valid) return false;

    const hash = await Bun.password.hash(newPassword, "bcrypt");
    this.db.run("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?", [hash, new Date().toISOString(), userId]);

    // Revoke all other sessions to evict any compromised tokens
    if (currentSessionId) {
      this.db.run("DELETE FROM sessions WHERE user_id = ? AND id != ?", [userId, currentSessionId]);
    } else {
      this.revokeAllSessions(userId);
    }
    return true;
  }

  async resetPassword(userId: string, newPassword: string): Promise<void> {
    const hash = await Bun.password.hash(newPassword, "bcrypt");
    this.db.run("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?", [hash, new Date().toISOString(), userId]);
    // Revoke all sessions on password reset
    this.revokeAllSessions(userId);
  }

  // --- Invites ---

  createInvite(createdBy: string, role: UserRole = "user", opts?: { maxUses?: number; expiresInHours?: number }): Invite {
    const code = randomBytes(4).toString("hex"); // 8-char hex
    const expiresAt = opts?.expiresInHours
      ? new Date(Date.now() + opts.expiresInHours * 60 * 60 * 1000).toISOString()
      : null;

    this.db.run(
      `INSERT INTO invites (code, created_by, role, max_uses, expires_at)
       VALUES (?, ?, ?, ?, ?)`,
      [code, createdBy, role, opts?.maxUses ?? 1, expiresAt],
    );

    return this.db.query("SELECT * FROM invites WHERE code = ?").get(code) as Invite;
  }

  validateInvite(code: string): Invite | null {
    const invite = this.db
      .query("SELECT * FROM invites WHERE code = ?")
      .get(code) as Invite | null;
    if (!invite) return null;
    if (invite.expires_at && new Date(invite.expires_at) < new Date()) return null;
    if (invite.use_count >= invite.max_uses) return null;
    return invite;
  }

  consumeInvite(code: string): boolean {
    const invite = this.validateInvite(code);
    if (!invite) return false;
    this.db.run("UPDATE invites SET use_count = use_count + 1 WHERE code = ?", [code]);
    return true;
  }

  listInvites(): Invite[] {
    return this.db.query("SELECT * FROM invites ORDER BY created_at DESC").all() as Invite[];
  }

  deleteInvite(code: string): boolean {
    const result = this.db.run("DELETE FROM invites WHERE code = ?", [code]);
    return result.changes > 0;
  }

  // --- Cleanup ---

  purgeExpiredSessions(): number {
    const result = this.db.run("DELETE FROM sessions WHERE expires_at <= datetime('now')");
    return result.changes;
  }
}

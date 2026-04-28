import type { Database } from "bun:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS gateway_devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  approved INTEGER NOT NULL DEFAULT 0,
  last_seen INTEGER,
  created_at INTEGER NOT NULL
);
`;

export class DeviceStore {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
    this.db.exec(SCHEMA);
  }

  async registerDevice(deviceId: string, deviceName: string, secret: string): Promise<void> {
    // Use INSERT OR IGNORE to prevent overwriting an existing (possibly approved) device.
    // A re-registration attempt for an existing device is a no-op.
    const existing = this.db.query("SELECT id FROM gateway_devices WHERE id = ?").get(deviceId);
    if (existing) return;
    const secretHash = await Bun.password.hash(secret, { algorithm: "bcrypt", cost: 4 });
    this.db.run(
      "INSERT OR IGNORE INTO gateway_devices (id, name, secret_hash, approved, created_at) VALUES (?, ?, ?, 0, ?)",
      [deviceId, deviceName, secretHash, Date.now()],
    );
  }

  async verifyDevice(deviceId: string, secret: string): Promise<boolean> {
    const row = this.db.query("SELECT secret_hash, approved FROM gateway_devices WHERE id = ?").get(deviceId) as
      | { secret_hash: string; approved: number }
      | null;
    if (!row || !row.approved) return false;
    return Bun.password.verify(secret, row.secret_hash);
  }

  isApproved(deviceId: string): boolean {
    const row = this.db.query("SELECT approved FROM gateway_devices WHERE id = ?").get(deviceId) as
      | { approved: number }
      | null;
    return row?.approved === 1;
  }

  approveDevice(deviceId: string): boolean {
    const result = this.db.run("UPDATE gateway_devices SET approved = 1 WHERE id = ?", [deviceId]);
    return result.changes > 0;
  }

  revokeDevice(deviceId: string): boolean {
    const result = this.db.run("DELETE FROM gateway_devices WHERE id = ?", [deviceId]);
    return result.changes > 0;
  }

  updateLastSeen(deviceId: string) {
    this.db.run("UPDATE gateway_devices SET last_seen = ? WHERE id = ?", [Date.now(), deviceId]);
  }

  listDevices(): Array<{ id: string; name: string; approved: number; last_seen: number | null; created_at: number }> {
    return this.db
      .query("SELECT id, name, approved, last_seen, created_at FROM gateway_devices ORDER BY created_at DESC")
      .all() as Array<{ id: string; name: string; approved: number; last_seen: number | null; created_at: number }>;
  }

  pendingDevices(): Array<{ id: string; name: string; created_at: number }> {
    return this.db
      .query("SELECT id, name, created_at FROM gateway_devices WHERE approved = 0")
      .all() as Array<{ id: string; name: string; created_at: number }>;
  }

  generateChallenge(): { nonce: string } {
    return { nonce: crypto.randomUUID() };
  }
}

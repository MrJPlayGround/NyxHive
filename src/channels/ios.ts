import type { Channel, ChannelStats } from "./types.js";
import type { NyxHiveConfig, iOSChannelDef, OutboundMessage } from "../types.js";
import { Database } from "bun:sqlite";
import { logger } from "../utils/logger.js";
import { sendAPNs, type APNsConfig } from "../utils/apns.js";

export class iOSChannel implements Channel {
  name = "ios";
  private db: Database;
  private config: NyxHiveConfig;
  private apnsConfig?: APNsConfig;
  private stats: ChannelStats = { messagesReceived: 0, messagesSent: 0, errors: 0 };

  constructor(opts: { config: NyxHiveConfig; dataDir: string }) {
    this.config = opts.config;
    this.db = new Database(`${opts.dataDir}/ios-outbound.db`);
    this.db.exec("PRAGMA journal_mode = WAL");
    const walCheck = this.db.query("PRAGMA journal_mode").get() as { journal_mode: string } | null;
    if (walCheck?.journal_mode !== "wal") {
      logger.warn(`[ios] WAL mode not active (journal_mode=${walCheck?.journal_mode}), performance may be degraded`);
    }
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.initDB();

    if (opts.config.apns) {
      this.apnsConfig = {
        keyId: opts.config.apns.key_id,
        teamId: opts.config.apns.team_id,
        keyPath: opts.config.apns.key_path,
        bundleId: opts.config.apns.bundle_id,
        production: opts.config.apns.production,
      };
      logger.info("[ios] APNs push notifications enabled");
    }
  }

  private initDB(): void {
    this.db.run(`CREATE TABLE IF NOT EXISTS outbound_messages (
      id TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      agent TEXT,
      message TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      read_at INTEGER
    )`);
    this.db.run("CREATE INDEX IF NOT EXISTS idx_outbound_channel ON outbound_messages(channel)");
    this.db.run("CREATE INDEX IF NOT EXISTS idx_outbound_created ON outbound_messages(created_at)");

    this.db.run(`CREATE TABLE IF NOT EXISTS ios_devices (
      device_token TEXT PRIMARY KEY,
      sender_id TEXT NOT NULL,
      platform TEXT DEFAULT 'ios',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`);

    this.db.run(`CREATE TABLE IF NOT EXISTS ios_notification_prefs (
      sender_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      level TEXT DEFAULT 'all',
      PRIMARY KEY (sender_id, channel)
    )`);
  }

  async start(): Promise<void> {
    logger.info("[ios] Channel ready (pull-based)");
  }

  async stop(): Promise<void> {
    this.db.close();
  }

  isConnected(): boolean {
    return true;
  }

  getStats(): ChannelStats {
    return { ...this.stats };
  }

  async sendOutbound(channelId: string, message: string, agent?: string): Promise<void> {
    const id = crypto.randomUUID();
    this.db.run(
      "INSERT INTO outbound_messages (id, channel, agent, message, created_at) VALUES (?, ?, ?, ?, ?)",
      [id, channelId, agent ?? null, message, Date.now()],
    );
    this.stats.messagesSent++;
    logger.debug(`[ios] Outbound stored: ${channelId} (${id.slice(0, 8)})`);

    if (this.apnsConfig) {
      const tokens = this.getDeviceTokens();
      const preview = message.length > 100 ? `${message.slice(0, 97)}...` : message;
      const agentName = agent ? agent.charAt(0).toUpperCase() + agent.slice(1) : "Nyx";

      for (const token of tokens) {
        sendAPNs(token, {
          alert: { title: agentName, body: preview },
          sound: "default",
          data: { channel: channelId, type: "agent:outbound" },
        }, this.apnsConfig).catch(err => {
          logger.error(`[ios] APNs send error: ${err}`);
        });
      }
    }
  }

  getOutboundMessages(channel: string, since?: number, limit = 50): OutboundMessage[] {
    if (since) {
      return this.db
        .prepare(
          `SELECT id, channel, agent, message, created_at as timestamp
           FROM outbound_messages WHERE channel = ? AND created_at > ?
           ORDER BY created_at ASC LIMIT ?`,
        )
        .all(channel, since, limit) as OutboundMessage[];
    }
    return this.db
      .prepare(
        `SELECT id, channel, agent, message, created_at as timestamp
         FROM outbound_messages WHERE channel = ?
         ORDER BY created_at DESC LIMIT ?`,
      )
      .all(channel, limit) as OutboundMessage[];
  }

  markRead(messageIds: string[]): void {
    const placeholders = messageIds.map(() => "?").join(",");
    this.db.run(
      `UPDATE outbound_messages SET read_at = ? WHERE id IN (${placeholders})`,
      [Date.now(), ...messageIds],
    );
  }

  getChannels(): iOSChannelDef[] {
    const channels: iOSChannelDef[] = [];
    const agents = this.config.agents ?? {};
    for (const [key, agent] of Object.entries(agents)) {
      channels.push({ id: `ios:${key}`, name: agent.name, type: "agent", agentKey: key });
    }
    const teams = this.config.teams ?? {};
    for (const [key, team] of Object.entries(teams)) {
      channels.push({ id: `ios:${key}`, name: team.name ?? key, type: "team", teamKey: key });
    }
    channels.push({ id: "ios:system", name: "System", type: "system" });
    return channels;
  }

  registerDevice(deviceToken: string, senderId: string): void {
    this.db.prepare(
      "INSERT OR REPLACE INTO ios_devices (device_token, sender_id, platform, created_at, updated_at) VALUES (?, ?, 'ios', ?, ?)",
    ).run(deviceToken, senderId, Date.now(), Date.now());
    logger.info(`[ios] Device registered for ${senderId}`);
  }

  getDeviceTokens(senderId?: string): string[] {
    const rows = senderId
      ? (this.db.prepare("SELECT device_token FROM ios_devices WHERE sender_id = ?").all(senderId) as { device_token: string }[])
      : (this.db.prepare("SELECT device_token FROM ios_devices").all() as { device_token: string }[]);
    return rows.map(r => r.device_token);
  }

  removeDevice(deviceToken: string): void {
    this.db.prepare("DELETE FROM ios_devices WHERE device_token = ?").run(deviceToken);
    logger.info(`[ios] Device removed: ${deviceToken.slice(0, 8)}...`);
  }

  setNotificationPref(senderId: string, channel: string, level: string): void {
    this.db.prepare(
      "INSERT OR REPLACE INTO ios_notification_prefs (sender_id, channel, level) VALUES (?, ?, ?)",
    ).run(senderId, channel, level);
  }

  getNotificationPref(senderId: string, channel: string): string {
    const row = this.db.prepare(
      "SELECT level FROM ios_notification_prefs WHERE sender_id = ? AND channel = ?",
    ).get(senderId, channel) as { level: string } | null;
    return row?.level || "all";
  }

  getDb(): Database {
    return this.db;
  }
}

import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ensureTableSchema } from "../utils/schema.js";
import { resolveRelayCallbackUrl } from "../server/urls.js";
import type { NyxHiveConfig, RelayOriginContext } from "../types.js";

const RELAY_CALLBACK_TTL_MS = 6 * 60 * 60_000;
const RELAY_NONCE_TTL_MS = 24 * 60 * 60_000;
export const RELAY_PRESENTING_INSTANCE_HEADER = "X-NyxRelay-Instance";

const RELAY_SCHEMA = `
CREATE TABLE IF NOT EXISTS relay_tokens (
    token TEXT PRIMARY KEY,
    issued_for TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_relay_tokens_expires ON relay_tokens(expires_at);

CREATE TABLE IF NOT EXISTS relay_nonces (
    token TEXT NOT NULL,
    nonce TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (token, nonce)
);
CREATE INDEX IF NOT EXISTS idx_relay_nonces_created ON relay_nonces(created_at);
`;

interface RelayCallbackRecord {
  expiresAt: number;
  issuedFor?: string;
}

function normalizeRelayIdentity(value?: string | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.toLowerCase() : undefined;
}

export class RelayCallbackManager {
  private readonly db: Database;

  constructor(private readonly config: Pick<NyxHiveConfig, "daemon" | "server">) {
    const dataDir = config.daemon.data_dir || join(process.cwd(), ".nyxhive", "data", (config.daemon.name || "default").toLowerCase());
    mkdirSync(dataDir, { recursive: true });
    this.db = new Database(join(dataDir, "relay.sqlite"));
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    ensureTableSchema(this.db, {
      table: "relay_tokens",
      required: ["token", "issued_for", "created_at", "expires_at"],
      ephemeral: false,
      columnDefs: {
        token: "TEXT",
        issued_for: "TEXT",
        created_at: "INTEGER NOT NULL DEFAULT 0",
        expires_at: "INTEGER NOT NULL DEFAULT 0",
      },
    }, "relay");
    ensureTableSchema(this.db, {
      table: "relay_nonces",
      required: ["token", "nonce", "created_at"],
      ephemeral: false,
      columnDefs: {
        token: "TEXT",
        nonce: "TEXT",
        created_at: "INTEGER NOT NULL DEFAULT 0",
      },
    }, "relay");
    this.db.exec(RELAY_SCHEMA);
    this.prune();
  }

  issue(remoteInstance?: string): RelayOriginContext {
    this.prune();
    const callbackToken = randomUUID();
    const now = Date.now();
    const callbackUrl = resolveRelayCallbackUrl(this.config);
    if (!callbackUrl) {
      throw new Error("Cannot issue relay callback without a resolvable server URL");
    }
    this.db.run(
      `INSERT OR REPLACE INTO relay_tokens (token, issued_for, created_at, expires_at)
       VALUES (?, ?, ?, ?)`,
      [callbackToken, remoteInstance?.trim() || null, now, now + RELAY_CALLBACK_TTL_MS],
    );

    return {
      originInstance: this.config.daemon.name,
      callbackUrl,
      callbackToken,
    };
  }

  validate(token: string, presentedBy?: string): { issuedFor?: string } | null {
    this.prune();
    const record = this.db.query(
      `SELECT issued_for, expires_at FROM relay_tokens WHERE token = ?`,
    ).get(token) as { issued_for: string | null; expires_at: number } | null;
    if (!record) return null;
    if (record.expires_at <= Date.now()) {
      this.db.run("DELETE FROM relay_tokens WHERE token = ?", [token]);
      return null;
    }
    const issuedFor = record.issued_for?.trim() || undefined;
    if (issuedFor && normalizeRelayIdentity(issuedFor) !== normalizeRelayIdentity(presentedBy)) {
      return null;
    }
    return { issuedFor };
  }

  registerCallbackNonce(token: string, nonce?: string, presentedBy?: string): { ok: boolean; duplicate: boolean; issuedFor?: string } {
    const valid = this.validate(token, presentedBy);
    if (!valid) return { ok: false, duplicate: false };
    if (!nonce) return { ok: true, duplicate: false, issuedFor: valid.issuedFor };

    try {
      this.db.run(
        `INSERT INTO relay_nonces (token, nonce, created_at) VALUES (?, ?, ?)`,
        [token, nonce, Date.now()],
      );
      return { ok: true, duplicate: false, issuedFor: valid.issuedFor };
    } catch {
      return { ok: false, duplicate: true, issuedFor: valid.issuedFor };
    }
  }

  private prune(): void {
    const now = Date.now();
    this.db.run("DELETE FROM relay_tokens WHERE expires_at <= ?", [now]);
    this.db.run("DELETE FROM relay_nonces WHERE created_at <= ?", [now - RELAY_NONCE_TTL_MS]);
  }

  close(): void {
    this.db.close();
  }
}

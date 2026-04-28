import type { Database } from "bun:sqlite";

const MAX_FIELD_LENGTH = 900;

interface PresenceProfile {
  id: "nyx" | "vortex";
  displayName: string;
  defaultPreference: string;
  quietTension: string;
  notifiedAction: string;
}

const PRESENCE_PROFILES: Record<PresenceProfile["id"], PresenceProfile> = {
  nyx: {
    id: "nyx",
    displayName: "Nyx",
    defaultPreference: "speak only for signal, drift, blocked autonomy, or a concrete recommendation",
    quietTension: "quiet heartbeat; no useful outbound signal",
    notifiedAction: "notified User from presence heartbeat",
  },
  vortex: {
    id: "vortex",
    displayName: "Vortex",
    defaultPreference: "speak only for blocked work, trading-workflow blockers, product drift, market/workflow risk, or a concrete next move",
    quietTension: "quiet Vortex heartbeat; no useful product or trading-workflow signal",
    notifiedAction: "notified User from Vortex presence heartbeat",
  },
};

export interface AgentPresenceState {
  id: string;
  current_tension: string;
  active_preference: string;
  blocked_loop: string | null;
  last_self_chosen_action: string | null;
  last_outbound_reason: string | null;
  last_outbound_at: number | null;
  last_heartbeat_at: number | null;
  heartbeat_count: number;
  quiet_count: number;
  updated_at: number;
}

export type NyxPresenceState = AgentPresenceState;

function truncate(value: string, max = MAX_FIELD_LENGTH): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, max - 3)}...`;
}

function inferBlockedLoop(response: string): string | null {
  const normalized = response.toLowerCase();
  if (normalized.includes("blocked") || normalized.includes("deferred") || normalized.includes("stalled")) {
    return truncate(response, 300);
  }
  return null;
}

function presenceProfile(agentKey?: string | null): PresenceProfile {
  const normalized = agentKey?.trim().toLowerCase() ?? "";
  if (normalized.includes("vortex") || normalized.includes("nyxlabs")) return PRESENCE_PROFILES.vortex;
  return PRESENCE_PROFILES.nyx;
}

function seedPresenceState(db: Database, profile: PresenceProfile): void {
  const now = Date.now();
  db.run(
    `INSERT OR IGNORE INTO agent_presence_state
      (id, current_tension, active_preference, blocked_loop, last_self_chosen_action, last_outbound_reason, last_outbound_at, last_heartbeat_at, heartbeat_count, quiet_count, updated_at)
     VALUES (?, ?, ?, NULL, NULL, NULL, NULL, NULL, 0, 0, ?)`,
    [profile.id, "not yet observed", profile.defaultPreference, now],
  );
}

function migrateLegacyNyxPresenceState(db: Database): void {
  try {
    const legacy = db.query("SELECT * FROM nyx_presence_state WHERE id = 'nyx'").get() as AgentPresenceState | null;
    if (!legacy) return;
    db.run(
      `INSERT OR IGNORE INTO agent_presence_state
        (id, current_tension, active_preference, blocked_loop, last_self_chosen_action, last_outbound_reason, last_outbound_at, last_heartbeat_at, heartbeat_count, quiet_count, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        "nyx",
        legacy.current_tension,
        legacy.active_preference,
        legacy.blocked_loop,
        legacy.last_self_chosen_action,
        legacy.last_outbound_reason,
        legacy.last_outbound_at,
        legacy.last_heartbeat_at,
        legacy.heartbeat_count,
        legacy.quiet_count,
        legacy.updated_at,
      ],
    );
  } catch {
    // Legacy table does not exist on fresh installs.
  }
}

export function initAgentPresenceStateSchema(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_presence_state (
      id TEXT PRIMARY KEY,
      current_tension TEXT NOT NULL,
      active_preference TEXT NOT NULL,
      blocked_loop TEXT,
      last_self_chosen_action TEXT,
      last_outbound_reason TEXT,
      last_outbound_at INTEGER,
      last_heartbeat_at INTEGER,
      heartbeat_count INTEGER NOT NULL DEFAULT 0,
      quiet_count INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    );
  `);

  migrateLegacyNyxPresenceState(db);
  seedPresenceState(db, PRESENCE_PROFILES.nyx);
}

export function initNyxPresenceStateSchema(db: Database): void {
  initAgentPresenceStateSchema(db);
}

export function getAgentPresenceState(db: Database, agentKey?: string | null): AgentPresenceState {
  initAgentPresenceStateSchema(db);
  const profile = presenceProfile(agentKey);
  seedPresenceState(db, profile);
  return db.query("SELECT * FROM agent_presence_state WHERE id = ?").get(profile.id) as AgentPresenceState;
}

export function getNyxPresenceState(db: Database): NyxPresenceState {
  return getAgentPresenceState(db, "nyx");
}

export function formatAgentPresenceStateForHeartbeat(db: Database, agentKey?: string | null): string {
  const profile = presenceProfile(agentKey);
  const state = getAgentPresenceState(db, profile.id);
  const lines = [
    `### ${profile.displayName} Presence State`,
    `- Current tension: ${state.current_tension}`,
    `- Active preference: ${state.active_preference}`,
    `- Blocked loop: ${state.blocked_loop ?? "none"}`,
    `- Last self-chosen action: ${state.last_self_chosen_action ?? "none"}`,
    `- Last outbound reason: ${state.last_outbound_reason ?? "none"}`,
    `- Heartbeats: ${state.heartbeat_count} total, ${state.quiet_count} quiet`,
  ];
  if (state.last_heartbeat_at) lines.push(`- Last heartbeat: ${new Date(state.last_heartbeat_at).toISOString()}`);
  if (state.last_outbound_at) lines.push(`- Last outbound: ${new Date(state.last_outbound_at).toISOString()}`);
  return lines.join("\n");
}

export function formatNyxPresenceStateForHeartbeat(db: Database): string {
  return formatAgentPresenceStateForHeartbeat(db, "nyx");
}

export function recordPresenceHeartbeat(db: Database, response: string | null | undefined, isEmpty: boolean, now = Date.now(), agentKey?: string | null): void {
  initAgentPresenceStateSchema(db);
  const profile = presenceProfile(agentKey);
  seedPresenceState(db, profile);

  if (isEmpty) {
    db.run(
      `UPDATE agent_presence_state SET
        current_tension = ?,
        active_preference = ?,
        last_heartbeat_at = ?,
        heartbeat_count = heartbeat_count + 1,
        quiet_count = quiet_count + 1,
        updated_at = ?
       WHERE id = ?`,
      [profile.quietTension, profile.defaultPreference, now, now, profile.id],
    );
    return;
  }

  const reason = truncate(response ?? "(no response)");
  db.run(
    `UPDATE agent_presence_state SET
      current_tension = ?,
      active_preference = ?,
      blocked_loop = ?,
      last_self_chosen_action = ?,
      last_outbound_reason = ?,
      last_outbound_at = ?,
      last_heartbeat_at = ?,
      heartbeat_count = heartbeat_count + 1,
      updated_at = ?
     WHERE id = ?`,
    [
      reason,
      profile.defaultPreference,
      inferBlockedLoop(reason),
      profile.notifiedAction,
      reason,
      now,
      now,
      now,
      profile.id,
    ],
  );
}

export function isPresenceHeartbeatTask(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  return normalized === "heartbeat:presence" || (normalized.startsWith("heartbeat:") && normalized.includes("presence"));
}

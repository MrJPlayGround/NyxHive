/**
 * Mutable agent registry with SQLite persistence.
 *
 * Config-defined agents are seeded on boot (created_by='config', protected).
 * Runtime-created agents can be hired/fired/reassigned by a lead/coordinator agent.
 * All consumers (processor, actor model, routing) read from this registry
 * instead of the immutable config.agents.
 */

import type { Database } from "bun:sqlite";
import type { AgentConfig } from "../types.js";
import { getModelTier } from "../defaults.js";
import { MODEL_TIER_REGISTRY } from "../soul/types.js";
import { ensureTableSchema } from "../utils/schema.js";
import { logger } from "../utils/logger.js";
import { loadAndCompileSoul } from "../soul/runtime.js";

export type AgentRole = "orchestrator" | "lead" | "coder" | "reviewer" | "expert" | "worker" | "heartbeat";

export interface AgentRegistryEntry extends AgentConfig {
  enabled: boolean;
  role: AgentRole;
  created_by: string;
  created_at: number;
  updated_at: number;
  // Performance stats
  total_invocations: number;
  total_tokens_in: number;
  total_tokens_out: number;
  total_failures: number;
  last_invoked_at: number | null;
  estimated_cost_cents: number;
  // Delegation tracking
  delegation_expected: number;
  delegation_actual: number;
}

// Tier enforcement: minimum model tiers per role
export const ROLE_MIN_TIERS: Record<string, number> = {
  orchestrator: 3,
  coder: 3,
};

export const ORCHESTRATOR_ALLOWED_MODELS = [
  "claude-sonnet-4-6",
  "claude-opus-4-6",
];

export const CODER_ALLOWED_MODELS = [
  "claude-sonnet-4-6",
  "claude-opus-4-6",
];

export const DEFAULT_WORKER_MODEL = "deepseek/deepseek-v3.2";
export const DEFAULT_WORKER_PROVIDER = "openrouter";

const MAX_ACTIVE_AGENTS = 20;

export function shouldApplySoulModelBounds(agent: AgentConfig): boolean {
  // Soul model tiers currently resolve to Claude model IDs. Keep them from
  // overriding explicit Codex/OpenAI or OpenRouter runtime configuration.
  return agent.provider === "anthropic" && agent.cli_fallback !== "codex";
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agent_registry (
  key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  min_model TEXT,
  max_model TEXT,
  companion_mode INTEGER DEFAULT 0,
  agentic_mode TEXT,
  system_prompt TEXT,
  working_directory TEXT NOT NULL,
  capabilities TEXT,
  always_cli INTEGER DEFAULT 0,
  cli_fallback TEXT,
  effort TEXT,
  anthropic_runtime TEXT,
  sandbox TEXT,
  role TEXT NOT NULL DEFAULT 'worker',
  enabled INTEGER DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  total_invocations INTEGER DEFAULT 0,
  total_tokens_in INTEGER DEFAULT 0,
  total_tokens_out INTEGER DEFAULT 0,
  total_failures INTEGER DEFAULT 0,
  last_invoked_at INTEGER,
  estimated_cost_cents INTEGER DEFAULT 0,
  delegation_expected INTEGER DEFAULT 0,
  delegation_actual INTEGER DEFAULT 0,
  allowed_directories TEXT,
  allowed_tools TEXT,
  disallowed_tools TEXT,
  mcp_tools TEXT,
  timeout_ms INTEGER,
  context_strategy TEXT
);
`;

const REQUIRED_COLUMNS = [
  "key", "name", "provider", "model", "min_model", "max_model", "companion_mode", "agentic_mode", "system_prompt",
  "working_directory", "capabilities", "always_cli", "cli_fallback",
  "effort", "anthropic_runtime", "sandbox", "role", "enabled", "created_by", "created_at", "updated_at",
  "total_invocations", "total_tokens_in", "total_tokens_out",
  "total_failures", "last_invoked_at", "estimated_cost_cents",
  "delegation_expected", "delegation_actual",
  "allowed_directories", "allowed_tools", "disallowed_tools", "mcp_tools",
  "timeout_ms", "context_strategy",
  "consecutive_stuck",
];

const COLUMN_DEFS: Record<string, string> = {
  max_model: "TEXT",
  companion_mode: "INTEGER DEFAULT 0",
  agentic_mode: "TEXT",
  effort: "TEXT",
  anthropic_runtime: "TEXT",
  role: "TEXT NOT NULL DEFAULT 'worker'",
  sandbox: "TEXT",
  total_invocations: "INTEGER DEFAULT 0",
  total_tokens_in: "INTEGER DEFAULT 0",
  total_tokens_out: "INTEGER DEFAULT 0",
  total_failures: "INTEGER DEFAULT 0",
  last_invoked_at: "INTEGER",
  estimated_cost_cents: "INTEGER DEFAULT 0",
  delegation_expected: "INTEGER DEFAULT 0",
  delegation_actual: "INTEGER DEFAULT 0",
  allowed_directories: "TEXT",
  allowed_tools: "TEXT",
  disallowed_tools: "TEXT",
  mcp_tools: "TEXT",
  timeout_ms: "INTEGER",
  context_strategy: "TEXT",
  consecutive_stuck: "INTEGER DEFAULT 0",
};

type RunningEntry = {
  startedAt: number;
  heartbeatAt: number;
  pid?: number;
  abortController?: AbortController;
  taskDescription?: string;
};

export class AgentRegistry {
  private db: Database;
  private agents: Map<string, AgentRegistryEntry> = new Map();
  private globalDirs: string[];
  private baseDir: string;
  private instanceSoulsDir?: string;
  // In-memory only — cleared on restart (which also kills zombie processes)
  private runningAgents = new Map<string, RunningEntry>();

  constructor(
    db: Database,
    configAgents: Record<string, AgentConfig> = {},
    configRoles?: Record<string, AgentRole>,
    globalDirs?: string[],
    baseDir?: string,
    instanceSoulsDir?: string,
  ) {
    this.db = db;
    this.globalDirs = globalDirs ?? [];
    this.baseDir = baseDir ?? process.cwd();
    this.instanceSoulsDir = instanceSoulsDir;
    this.initSchema();
    this.seedFromConfig(configAgents, configRoles, globalDirs);
    this.loadAll();
  }

  private initSchema(): void {
    ensureTableSchema(this.db, {
      table: "agent_registry",
      required: REQUIRED_COLUMNS,
      ephemeral: false,
      columnDefs: COLUMN_DEFS,
    }, "registry");

    this.db.exec(SCHEMA);
  }

  private seedFromConfig(configAgents: Record<string, AgentConfig>, configRoles?: Record<string, AgentRole>, globalDirs?: string[]): void {
    const now = Date.now();
    const configKeys = new Set(Object.keys(configAgents));

    // Disable agents removed from config (but keep system-created agents like heartbeat, scout)
    const allRows = this.db.query("SELECT key, created_by, enabled FROM agent_registry").all() as Array<{ key: string; created_by: string; enabled: number }>;
    for (const row of allRows) {
      if (!configKeys.has(row.key) && row.created_by !== "system" && row.enabled === 1) {
        this.db.run("UPDATE agent_registry SET enabled = 0, updated_at = ? WHERE key = ?", [now, row.key]);
        logger.info(`[registry] Disabled agent '${row.key}' (removed from config)`);
      }
    }

    for (const [key, agent] of Object.entries(configAgents)) {
      const role = configRoles?.[key] ?? this.inferRole(key, agent);
      const existing = this.db.query("SELECT key, created_by FROM agent_registry WHERE key = ?").get(key) as { key: string; created_by: string } | null;

      // Merge allowed_directories: global (config-level) + per-agent TOML + soul (all additive)
      let soul: ReturnType<typeof loadAndCompileSoul> | undefined;
      try {
        soul = loadAndCompileSoul(key, undefined, this.instanceSoulsDir);
      } catch (err) {
        logger.error(`[registry] Soul compilation failed for '${key}', continuing without soul: ${err}`);

      }
      const soulDirs = soul?.capabilities?.allowed_directories ?? [];
      const tomlDirs = agent.allowed_directories ?? [];
      const mergedDirs = [...new Set([...(globalDirs ?? []), ...tomlDirs, ...soulDirs])];

      // Wire max_tool_turns from soul config (controls CLI --max-turns)
      if (soul?.capabilities?.max_tool_turns && !agent.max_tool_turns) {
        agent.max_tool_turns = soul.capabilities.max_tool_turns;
      }
      // Wire model_capabilities from soul → resolve tier names to concrete model IDs.
      // Soul bounds are Claude-tiered; non-Anthropic agents keep their explicit config model.
      if (soul?.model_capabilities && shouldApplySoulModelBounds(agent)) {
        const mc = soul.model_capabilities;
        if (mc.min_model) agent.min_model = MODEL_TIER_REGISTRY[mc.min_model];
        if (mc.max_model) agent.max_model = MODEL_TIER_REGISTRY[mc.max_model];
      }

      if (soulDirs.length > 0) {
        logger.debug(`[registry] ${key}: merged ${soulDirs.length} soul directories into allowed_directories`);
      }

      if (existing) {
        // Config agents: upsert non-stat fields (preserve runtime stats)
        if (existing.created_by === "config") {
          this.db.run(
            `UPDATE agent_registry SET
              name = ?, provider = ?, model = ?, min_model = ?, max_model = ?,
              companion_mode = ?, agentic_mode = ?, system_prompt = ?, working_directory = ?, capabilities = ?,
              always_cli = ?, cli_fallback = ?, effort = ?, anthropic_runtime = ?, sandbox = ?, role = ?,
              allowed_directories = ?, allowed_tools = ?, disallowed_tools = ?, mcp_tools = ?,
              timeout_ms = ?, context_strategy = ?,
              enabled = 1, updated_at = ?
            WHERE key = ?`,
            [
              agent.name,
              agent.provider,
              agent.model,
              agent.min_model ?? null,
              agent.max_model ?? null,
              agent.companion_mode ? 1 : 0,
              agent.agentic_mode ?? null,
              agent.system_prompt ?? null,
              agent.working_directory,
              agent.capabilities ? JSON.stringify(agent.capabilities) : null,
              agent.always_cli ? 1 : 0,
              agent.cli_fallback ?? null,
              agent.effort ?? null,
              agent.anthropic_runtime ?? null,
              agent.sandbox ?? null,
              role,
              mergedDirs.length > 0 ? JSON.stringify(mergedDirs) : null,
              agent.allowed_tools ? JSON.stringify(agent.allowed_tools) : null,
              agent.disallowed_tools ? JSON.stringify(agent.disallowed_tools) : null,
              agent.mcp_tools ? JSON.stringify(agent.mcp_tools) : null,
              agent.timeout_ms ?? null,
              agent.context_strategy ? JSON.stringify(agent.context_strategy) : null,
              now,
              key,
            ],
          );
        }
        // Runtime-created agents with same key: don't overwrite
      } else {
        this.db.run(
          `INSERT INTO agent_registry
            (key, name, provider, model, min_model, max_model, companion_mode, agentic_mode, system_prompt, working_directory,
             capabilities, always_cli, cli_fallback, effort, anthropic_runtime, sandbox, role, enabled,
             allowed_directories, allowed_tools, disallowed_tools, mcp_tools, timeout_ms,
             context_strategy, created_by, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, 'config', ?, ?)`,
          [
            key,
            agent.name,
            agent.provider,
            agent.model,
            agent.min_model ?? null,
            agent.max_model ?? null,
            agent.companion_mode ? 1 : 0,
            agent.agentic_mode ?? null,
            agent.system_prompt ?? null,
            agent.working_directory,
            agent.capabilities ? JSON.stringify(agent.capabilities) : null,
            agent.always_cli ? 1 : 0,
            agent.cli_fallback ?? null,
            agent.effort ?? null,
            agent.anthropic_runtime ?? null,
            agent.sandbox ?? null,
            role,
            mergedDirs.length > 0 ? JSON.stringify(mergedDirs) : null,
            agent.allowed_tools ? JSON.stringify(agent.allowed_tools) : null,
            agent.disallowed_tools ? JSON.stringify(agent.disallowed_tools) : null,
            agent.mcp_tools ? JSON.stringify(agent.mcp_tools) : null,
            agent.timeout_ms ?? null,
            agent.context_strategy ? JSON.stringify(agent.context_strategy) : null,
            now,
            now,
          ],
        );
      }
    }
  }

  private inferRole(key: string, agent: AgentConfig): AgentRole {
    // Explicit role from config takes priority
    if (agent.role) return agent.role as AgentRole;
    // Fallback heuristics for backward compatibility
    if (agent.name.toLowerCase().includes("orchestrat")) return "orchestrator";
    if (key === "heartbeat" || agent.name.toLowerCase().includes("heartbeat")) return "heartbeat";
    return "worker";
  }

  private loadAll(): void {
    this.agents.clear();
    const rows = this.db.query("SELECT * FROM agent_registry").all() as Array<Record<string, any>>;

    for (const row of rows) {
      this.agents.set(row.key, this.rowToEntry(row));
    }

    logger.info(`[registry] Loaded ${this.agents.size} agents (${[...this.agents.values()].filter(a => a.enabled).length} enabled)`);
  }

  private safeJsonParse<T>(val: string | null | undefined, fallback: T): T {
    if (!val) return fallback;
    try {
      return JSON.parse(val) as T;
    } catch {
      logger.warn(`[registry] Failed to parse JSON column value: ${val.slice(0, 100)}`);
      return fallback;
    }
  }

  private rowToEntry(row: Record<string, any>): AgentRegistryEntry {
    return {
      name: row.name,
      provider: row.provider,
      model: row.model,
      min_model: row.min_model ?? undefined,
      max_model: row.max_model ?? undefined,
      companion_mode: row.companion_mode === 1,
      agentic_mode: row.agentic_mode ?? undefined,
      system_prompt: row.system_prompt ?? undefined,
      working_directory: row.working_directory,
      capabilities: this.safeJsonParse(row.capabilities, undefined),
      always_cli: row.always_cli === 1,
      cli_fallback: row.cli_fallback ?? undefined,
      effort: row.effort ?? undefined,
      anthropic_runtime: row.anthropic_runtime ?? undefined,
      sandbox: row.sandbox ?? undefined,
      allowed_directories: this.safeJsonParse(row.allowed_directories, undefined),
      allowed_tools: this.safeJsonParse(row.allowed_tools, undefined),
      disallowed_tools: this.safeJsonParse(row.disallowed_tools, undefined),
      mcp_tools: this.safeJsonParse(row.mcp_tools, undefined),
      timeout_ms: row.timeout_ms ?? undefined,
      context_strategy: this.safeJsonParse(row.context_strategy, undefined),
      role: row.role as AgentRole,
      enabled: row.enabled === 1,
      created_by: row.created_by,
      created_at: row.created_at,
      updated_at: row.updated_at,
      total_invocations: row.total_invocations ?? 0,
      total_tokens_in: row.total_tokens_in ?? 0,
      total_tokens_out: row.total_tokens_out ?? 0,
      total_failures: row.total_failures ?? 0,
      last_invoked_at: row.last_invoked_at ?? null,
      estimated_cost_cents: row.estimated_cost_cents ?? 0,
      delegation_expected: row.delegation_expected ?? 0,
      delegation_actual: row.delegation_actual ?? 0,
    };
  }

  // --- Read ---

  get(key: string): AgentConfig | undefined {
    const entry = this.agents.get(key);
    if (!entry || !entry.enabled) return undefined;
    return this.entryToConfig(entry);
  }

  getEntry(key: string): AgentRegistryEntry | undefined {
    return this.agents.get(key);
  }

  getAll(includeDisabled = false): Record<string, AgentConfig> {
    const result: Record<string, AgentConfig> = {};
    for (const [key, entry] of this.agents) {
      if (!includeDisabled && !entry.enabled) continue;
      result[key] = this.entryToConfig(entry);
    }
    return result;
  }

  getAllEntries(includeDisabled = false): Map<string, AgentRegistryEntry> {
    if (includeDisabled) return new Map(this.agents);
    const result = new Map<string, AgentRegistryEntry>();
    for (const [key, entry] of this.agents) {
      if (entry.enabled) result.set(key, entry);
    }
    return result;
  }

  getGlobalDirs(): string[] {
    return this.globalDirs;
  }

  getKnownAgentKeys(): Set<string> {
    const keys = new Set<string>();
    for (const [key, entry] of this.agents) {
      if (entry.enabled) keys.add(key);
    }
    return keys;
  }

  isProtected(key: string): boolean {
    const entry = this.agents.get(key);
    return entry?.created_by === "config" || entry?.created_by === "system";
  }

  getActiveCount(): number {
    let count = 0;
    for (const entry of this.agents.values()) {
      if (entry.enabled) count++;
    }
    return count;
  }

  // --- Write ---

  create(key: string, config: Partial<AgentConfig> & { name: string }, createdBy: string): { success: boolean; error?: string } {
    // Validate key format
    if (!/^[a-z][a-z0-9_]*$/.test(key)) {
      return { success: false, error: "Key must be lowercase alphanumeric + underscore, starting with a letter" };
    }

    // Check duplicates
    if (this.agents.has(key)) {
      return { success: false, error: `Agent '${key}' already exists` };
    }

    // Check max active agents
    if (this.getActiveCount() >= MAX_ACTIVE_AGENTS) {
      return { success: false, error: `Max ${MAX_ACTIVE_AGENTS} active agents reached` };
    }

    const now = Date.now();
    const baseDir = this.getBaseDir();

    // Merge allowed_directories: global + soul + explicitly passed dirs
    let soul: ReturnType<typeof loadAndCompileSoul> | undefined;
    try {
      soul = loadAndCompileSoul(key, undefined, this.instanceSoulsDir);
    } catch (err) {
      logger.error(`[registry] Soul compilation failed for '${key}', continuing without soul: ${err}`);
    }
    const soulDirs = soul?.capabilities?.allowed_directories ?? [];
    const configDirs = config.allowed_directories ?? [];
    const mergedDirs = [...new Set([...this.globalDirs, ...configDirs, ...soulDirs])];

    const entry: AgentRegistryEntry = {
      name: config.name,
      provider: config.provider ?? DEFAULT_WORKER_PROVIDER,
      model: config.model ?? DEFAULT_WORKER_MODEL,
      min_model: config.min_model,
      max_model: config.max_model,
      companion_mode: config.companion_mode ?? false,
      agentic_mode: config.agentic_mode,
      system_prompt: config.system_prompt,
      working_directory: config.working_directory ?? `${baseDir}/workspace/${key}`,
      capabilities: config.capabilities ?? [],
      always_cli: config.always_cli ?? false,
      cli_fallback: config.cli_fallback,
      effort: config.effort,
      anthropic_runtime: config.anthropic_runtime,
      sandbox: config.sandbox,
      timeout_ms: config.timeout_ms,
      allowed_directories: mergedDirs.length > 0 ? mergedDirs : undefined,
      role: "worker",
      enabled: true,
      created_by: createdBy,
      created_at: now,
      updated_at: now,
      total_invocations: 0,
      total_tokens_in: 0,
      total_tokens_out: 0,
      total_failures: 0,
      last_invoked_at: null,
      estimated_cost_cents: 0,
      delegation_expected: 0,
      delegation_actual: 0,
    };

    this.db.run(
      `INSERT INTO agent_registry
        (key, name, provider, model, min_model, max_model, companion_mode, agentic_mode, system_prompt, working_directory,
         capabilities, always_cli, cli_fallback, effort, anthropic_runtime, sandbox, role, enabled,
         allowed_directories, timeout_ms,
         created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
      [
        key, entry.name, entry.provider, entry.model,
        entry.min_model ?? null, entry.max_model ?? null,
        entry.companion_mode ? 1 : 0,
        entry.agentic_mode ?? null,
        entry.system_prompt ?? null,
        entry.working_directory,
        entry.capabilities ? JSON.stringify(entry.capabilities) : null,
        entry.always_cli ? 1 : 0,
        entry.cli_fallback ?? null,
        entry.effort ?? null,
        entry.anthropic_runtime ?? null,
        entry.sandbox ?? null,
        entry.role,
        mergedDirs.length > 0 ? JSON.stringify(mergedDirs) : null,
        entry.timeout_ms ?? null,
        createdBy, now, now,
      ],
    );

    this.agents.set(key, entry);
    logger.info(`[registry] Created agent '${key}' (${entry.provider}/${entry.model}) by ${createdBy}`);
    return { success: true };
  }

  update(key: string, partial: Partial<AgentConfig & { role?: AgentRole }>): { success: boolean; error?: string } {
    const entry = this.agents.get(key);
    if (!entry) return { success: false, error: `Agent '${key}' not found` };

    // Tier enforcement on model change
    if (partial.model) {
      const role = partial.role ?? entry.role;
      const minTier = ROLE_MIN_TIERS[role];
      if (minTier) {
        const newTier = getModelTier(partial.model);
        if (newTier < minTier) {
          return { success: false, error: `Cannot set ${role} model below tier ${minTier}. ${partial.model} is tier ${newTier}.` };
        }
      }
    }

    // Role change enforcement
    if (partial.role && partial.role !== entry.role) {
      const minTier = ROLE_MIN_TIERS[partial.role];
      if (minTier) {
        const currentTier = getModelTier(partial.model ?? entry.model);
        if (currentTier < minTier) {
          return { success: false, error: `Cannot assign role '${partial.role}' with model tier ${currentTier}. Minimum tier: ${minTier}.` };
        }
      }
    }

    const now = Date.now();
    const sets: string[] = [];
    const values: (string | number | null)[] = [];

    if (partial.name !== undefined) { sets.push("name = ?"); values.push(partial.name); entry.name = partial.name; }
    if (partial.provider !== undefined) { sets.push("provider = ?"); values.push(partial.provider); entry.provider = partial.provider; }
    if (partial.model !== undefined) { sets.push("model = ?"); values.push(partial.model); entry.model = partial.model; }
    if (partial.min_model !== undefined) { sets.push("min_model = ?"); values.push(partial.min_model); entry.min_model = partial.min_model; }
    if (partial.max_model !== undefined) { sets.push("max_model = ?"); values.push(partial.max_model); entry.max_model = partial.max_model; }
    if (partial.companion_mode !== undefined) { sets.push("companion_mode = ?"); values.push(partial.companion_mode ? 1 : 0); entry.companion_mode = partial.companion_mode; }
    if (partial.agentic_mode !== undefined) { sets.push("agentic_mode = ?"); values.push(partial.agentic_mode); entry.agentic_mode = partial.agentic_mode; }
    if (partial.system_prompt !== undefined) { sets.push("system_prompt = ?"); values.push(partial.system_prompt); entry.system_prompt = partial.system_prompt; }
    if (partial.working_directory !== undefined) { sets.push("working_directory = ?"); values.push(partial.working_directory); entry.working_directory = partial.working_directory; }
    if (partial.capabilities !== undefined) { sets.push("capabilities = ?"); values.push(JSON.stringify(partial.capabilities)); entry.capabilities = partial.capabilities; }
    if (partial.always_cli !== undefined) { sets.push("always_cli = ?"); values.push(partial.always_cli ? 1 : 0); entry.always_cli = partial.always_cli; }
    if (partial.cli_fallback !== undefined) { sets.push("cli_fallback = ?"); values.push(partial.cli_fallback); entry.cli_fallback = partial.cli_fallback; }
    if (partial.effort !== undefined) { sets.push("effort = ?"); values.push(partial.effort); entry.effort = partial.effort; }
    if (partial.anthropic_runtime !== undefined) { sets.push("anthropic_runtime = ?"); values.push(partial.anthropic_runtime); entry.anthropic_runtime = partial.anthropic_runtime; }
    if (partial.sandbox !== undefined) { sets.push("sandbox = ?"); values.push(partial.sandbox); entry.sandbox = partial.sandbox; }
    if (partial.allowed_directories !== undefined) { sets.push("allowed_directories = ?"); values.push(JSON.stringify(partial.allowed_directories)); entry.allowed_directories = partial.allowed_directories; }
    if (partial.role !== undefined) { sets.push("role = ?"); values.push(partial.role); entry.role = partial.role; }
    if (partial.timeout_ms !== undefined) { sets.push("timeout_ms = ?"); values.push(partial.timeout_ms); entry.timeout_ms = partial.timeout_ms; }

    if (sets.length === 0) return { success: true };

    sets.push("updated_at = ?");
    values.push(now);
    entry.updated_at = now;
    values.push(key);

    this.db.run(`UPDATE agent_registry SET ${sets.join(", ")} WHERE key = ?`, values);
    logger.info(`[registry] Updated agent '${key}': ${sets.filter(s => s !== "updated_at = ?").map(s => s.split(" = ")[0]).join(", ")}`);
    return { success: true };
  }

  disable(key: string): { success: boolean; error?: string } {
    const entry = this.agents.get(key);
    if (!entry) return { success: false, error: `Agent '${key}' not found` };

    // Protected agents can't be permanently disabled
    if (entry.created_by === "config") {
      return { success: false, error: `Agent '${key}' is config-protected and cannot be disabled` };
    }

    const now = Date.now();
    this.db.run("UPDATE agent_registry SET enabled = 0, updated_at = ? WHERE key = ?", [now, key]);
    entry.enabled = false;
    entry.updated_at = now;
    logger.info(`[registry] Disabled agent '${key}'`);
    return { success: true };
  }

  enable(key: string): { success: boolean; error?: string } {
    const entry = this.agents.get(key);
    if (!entry) return { success: false, error: `Agent '${key}' not found` };

    if (this.getActiveCount() >= MAX_ACTIVE_AGENTS) {
      return { success: false, error: `Max ${MAX_ACTIVE_AGENTS} active agents reached` };
    }

    const now = Date.now();
    this.db.run("UPDATE agent_registry SET enabled = 1, updated_at = ? WHERE key = ?", [now, key]);
    entry.enabled = true;
    entry.updated_at = now;
    logger.info(`[registry] Enabled agent '${key}'`);
    return { success: true };
  }

  // --- Stats ---

  recordInvocation(key: string, stats: {
    tokensIn: number;
    tokensOut: number;
    success: boolean;
    costCents: number;
  }): void {
    const entry = this.agents.get(key);
    if (!entry) return;

    const now = Date.now();
    entry.total_invocations++;
    entry.total_tokens_in += stats.tokensIn;
    entry.total_tokens_out += stats.tokensOut;
    if (!stats.success) entry.total_failures++;
    entry.last_invoked_at = now;
    entry.estimated_cost_cents += stats.costCents;

    this.db.run(
      `UPDATE agent_registry SET
        total_invocations = total_invocations + 1,
        total_tokens_in = total_tokens_in + ?,
        total_tokens_out = total_tokens_out + ?,
        total_failures = total_failures + ?,
        last_invoked_at = ?,
        estimated_cost_cents = estimated_cost_cents + ?,
        updated_at = ?
      WHERE key = ?`,
      [
        stats.tokensIn,
        stats.tokensOut,
        stats.success ? 0 : 1,
        now,
        stats.costCents,
        now,
        key,
      ],
    );
  }

  recordDelegationExpected(agentKey: string): void {
    const entry = this.agents.get(agentKey);
    if (!entry) return;
    entry.delegation_expected++;
    this.db.run(
      "UPDATE agent_registry SET delegation_expected = delegation_expected + 1 WHERE key = ?",
      [agentKey],
    );
  }

  recordDelegationActual(agentKey: string): void {
    const entry = this.agents.get(agentKey);
    if (!entry) return;
    entry.delegation_actual++;
    this.db.run(
      "UPDATE agent_registry SET delegation_actual = delegation_actual + 1 WHERE key = ?",
      [agentKey],
    );
  }

  // --- Watchdog ---

  markRunning(key: string, opts: { pid?: number; abortController?: AbortController; taskDescription?: string }): void {
    this.runningAgents.set(key, {
      startedAt: Date.now(),
      heartbeatAt: Date.now(),
      ...opts,
    });
  }

  markIdle(key: string): void {
    this.runningAgents.delete(key);
  }

  /** Update the PID on a running entry (called after process spawn, since PID isn't known at markRunning time). */
  updateRunningPid(key: string, pid: number): void {
    const entry = this.runningAgents.get(key);
    if (entry) entry.pid = pid;
  }

  recordHeartbeat(key: string): void {
    const entry = this.runningAgents.get(key);
    if (entry) entry.heartbeatAt = Date.now();
  }

  getRunningAgents(): Map<string, RunningEntry> {
    return this.runningAgents;
  }

  resetConsecutiveStuck(key: string): void {
    this.db.run("UPDATE agent_registry SET consecutive_stuck = 0 WHERE key = ? AND consecutive_stuck > 0", [key]);
  }

  getStuckAgents(thresholdMs: number): [string, RunningEntry][] {
    const now = Date.now();
    const stuck: [string, RunningEntry][] = [];
    for (const [key, entry] of this.runningAgents) {
      if (now - entry.heartbeatAt > thresholdMs) {
        stuck.push([key, entry]);
      }
    }
    return stuck;
  }

  getStats(key: string): { invocations: number; tokensIn: number; tokensOut: number; failures: number; costCents: number; lastInvoked: number | null } | null {
    const entry = this.agents.get(key);
    if (!entry) return null;
    return {
      invocations: entry.total_invocations,
      tokensIn: entry.total_tokens_in,
      tokensOut: entry.total_tokens_out,
      failures: entry.total_failures,
      costCents: entry.estimated_cost_cents,
      lastInvoked: entry.last_invoked_at,
    };
  }

  getStatsSummary(): {
    agents: Array<{ key: string; name: string; model: string; role: AgentRole; invocations: number; costCents: number; lastInvoked: number | null; enabled: boolean }>;
    totalCostCents: number;
    idleAgents: string[];
    topConsumers: string[];
  } {
    const agents: Array<{ key: string; name: string; model: string; role: AgentRole; invocations: number; costCents: number; lastInvoked: number | null; enabled: boolean }> = [];
    let totalCostCents = 0;
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

    for (const [key, entry] of this.agents) {
      agents.push({
        key,
        name: entry.name,
        model: entry.model,
        role: entry.role,
        invocations: entry.total_invocations,
        costCents: entry.estimated_cost_cents,
        lastInvoked: entry.last_invoked_at,
        enabled: entry.enabled,
      });
      totalCostCents += entry.estimated_cost_cents;
    }

    const idleAgents = agents
      .filter(a => a.enabled && (!a.lastInvoked || a.lastInvoked < sevenDaysAgo))
      .map(a => a.key);

    const topConsumers = [...agents]
      .sort((a, b) => b.costCents - a.costCents)
      .slice(0, 3)
      .map(a => a.key);

    return { agents, totalCostCents, idleAgents, topConsumers };
  }

  // --- Helpers ---

  private entryToConfig(entry: AgentRegistryEntry): AgentConfig {
    const config: AgentConfig = {
      name: entry.name,
      provider: entry.provider,
      model: entry.model,
      working_directory: entry.working_directory,
    };
    if (entry.min_model) config.min_model = entry.min_model;
    if (entry.max_model) config.max_model = entry.max_model;
    if (entry.companion_mode) config.companion_mode = true;
    if (entry.agentic_mode) config.agentic_mode = entry.agentic_mode;
    if (entry.system_prompt) config.system_prompt = entry.system_prompt;
    if (entry.capabilities?.length) config.capabilities = entry.capabilities;
    if (entry.always_cli) config.always_cli = entry.always_cli;
    if (entry.cli_fallback) config.cli_fallback = entry.cli_fallback;
    if (entry.effort) config.effort = entry.effort;
    if (entry.anthropic_runtime) config.anthropic_runtime = entry.anthropic_runtime;
    if (entry.sandbox) config.sandbox = entry.sandbox as AgentConfig["sandbox"];
    if (entry.allowed_directories?.length) config.allowed_directories = entry.allowed_directories;
    if (entry.allowed_tools?.length) config.allowed_tools = entry.allowed_tools;
    if (entry.disallowed_tools?.length) config.disallowed_tools = entry.disallowed_tools;
    if (entry.mcp_tools?.length) config.mcp_tools = entry.mcp_tools;
    if (entry.timeout_ms) config.timeout_ms = entry.timeout_ms;
    if (entry.max_tool_turns) config.max_tool_turns = entry.max_tool_turns;
    if (entry.context_strategy) config.context_strategy = entry.context_strategy;
    return config;
  }

  private getBaseDir(): string {
    return this.baseDir;
  }
}

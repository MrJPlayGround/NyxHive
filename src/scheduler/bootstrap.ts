/**
 * Task registration and scheduler bootstrap helpers.
 * Config-defined tasks are instance-specific; built-in system tasks are opt-in.
 */

import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { parseCron, nextOccurrence } from "./cron.js";
import type { NyxHiveConfig } from "../types.js";
import type { ProviderRouter } from "../providers/router.js";
import type { AgentRegistry } from "../agents/registry.js";
import type { ProposalStore } from "../proposals/store.js";
import { logger } from "../utils/logger.js";
import { resolveNotificationTargets } from "../notifications/routing.js";
import { DEFAULT_LOCAL_CLASSIFIER_MODEL } from "../defaults.js";

/** Engine repository root — resolved from this file's location (src/scheduler/). */
const _ENGINE_REPO_DIR = resolve(import.meta.dir, "../..");

/** Migrate scheduled_tasks schema for adaptive scheduling columns. */
export function migrateAdaptiveColumns(db: Database): void {
  try { db.exec("ALTER TABLE scheduled_tasks ADD COLUMN original_cron TEXT"); } catch {}
  try { db.exec("ALTER TABLE scheduled_tasks ADD COLUMN adjusted_cron TEXT"); } catch {}
  try { db.exec("ALTER TABLE scheduled_tasks ADD COLUMN consecutive_empty INTEGER DEFAULT 0"); } catch {}
  try { db.exec("ALTER TABLE scheduled_tasks ADD COLUMN timeout_ms INTEGER"); } catch {}
  try { db.exec("ALTER TABLE scheduled_tasks ADD COLUMN authority_profile TEXT DEFAULT 'scheduled'"); } catch {}
  db.exec("UPDATE scheduled_tasks SET authority_profile = 'scheduled' WHERE authority_profile IS NULL");
  db.exec("UPDATE scheduled_tasks SET original_cron = cron_expression WHERE original_cron IS NULL");
}

export interface BootstrapDeps {
  db: Database;
  config: NyxHiveConfig;
  router?: ProviderRouter;
  registry?: AgentRegistry;
  proposalStore?: ProposalStore;
}

export const TASK_PROFILES = {
  full: [
    "heartbeat:health-check",
    "sentinel:error-triage",
    "sentinel:cost-watchdog",
    "watchdog:stuck-detection",
    "routing:cleanup-stale",
    "dev:execute-approved",
    "proposals:sync-merged",
    "proposals:reset-stale-reviewing",
    "briefing:auto-review",
    "briefing:daily",
    "memory:maintenance",
    "learning:distill-patterns",
    "evolution:codebase-review",
    "maintenance:drift-and-sync",
    "docs:sync",
  ],
  dev: [
    "heartbeat:health-check",
    "sentinel:error-triage",
    "sentinel:cost-watchdog",
    "watchdog:stuck-detection",
    "dev:execute-approved",
    "proposals:sync-merged",
    "proposals:reset-stale-reviewing",
    "memory:maintenance",
  ],
  trading: [
    "heartbeat:health-check",
    "sentinel:error-triage",
    "sentinel:cost-watchdog",
    "watchdog:stuck-detection",
  ],
  monitor: [
    "heartbeat:health-check",
    "sentinel:error-triage",
    "sentinel:cost-watchdog",
    "watchdog:stuck-detection",
    "routing:cleanup-stale",
  ],
  none: [],
} as const;

export type TaskProfile = keyof typeof TASK_PROFILES;

const CRAWL_SYSTEM_TASK_NAMES = [
  "crawl:run-sources",
  "crawl:cleanup-stale",
] as const;

const PROPOSAL_SYSTEM_TASK_NAMES = [
  "dev:execute-approved",
  "proposals:sync-merged",
  "proposals:reset-stale-reviewing",
  "briefing:auto-review",
  "briefing:daily",
] as const;

const ALL_SYSTEM_TASK_NAMES = [
  "heartbeat:health-check",
  "sentinel:error-triage",
  "sentinel:cost-watchdog",
  "dev:execute-approved",
  "proposals:sync-merged",
  "proposals:reset-stale-reviewing",
  "briefing:auto-review",
  "briefing:daily",
  "memory:maintenance",
  "learning:distill-patterns",
  "maintenance:drift-and-sync",
  "evolution:codebase-review",
  "crawl:run-sources",
  "crawl:cleanup-stale",
  "watchdog:stuck-detection",
  "routing:cleanup-stale",
  "docs:sync",
] as const;

/** Tasks removed during cleanup — delete from DB on boot if they still exist. */
const REMOVED_TASK_NAMES = [
  "heartbeat:daily-review",
  "improvement:daily-loop",
  "maintenance:vault-sync",
  "learning:scout-effectiveness",
  "sentinel:provider-ping",      // redundant with heartbeat:health-check
  "maintenance:drift-detection",  // replaced by maintenance:drift-and-sync
];

/** Resolve notify_channels JSON for a given notification type. */
function resolveNotifyChannelsForType(config: NyxHiveConfig, type: "reports" | "activity"): string | null {
  const targets = resolveNotificationTargets(config, type);
  if (targets.length > 0) {
    return JSON.stringify(targets.map(t => `${t.channel}:${t.recipient}`));
  }
  // Fall back to legacy scheduler.notify_channels
  const legacy = config.scheduler?.notify_channels;
  if (!legacy || legacy.length === 0) return null;
  return JSON.stringify(legacy);
}

/**
 * Resolve the cheapest reliable model for background/cron tasks.
 * Priority: local Ollama classifier > OpenRouter cheap > Anthropic fallback.
 */
export function resolveHeartbeatModel(router?: ProviderRouter): { provider: string; model: string } {
  if (router?.hasProvider?.("ollama")) {
    return { provider: "ollama", model: DEFAULT_LOCAL_CLASSIFIER_MODEL };
  }
  if (router?.hasProvider?.("openrouter")) {
    return { provider: "openrouter", model: "deepseek/deepseek-v3.2" };
  }
  return { provider: "anthropic", model: "claude-haiku-4-5-20251001" };
}

function resolveDriftRepoPath(config: NyxHiveConfig): string {
  const defaultProject = config.daemon.projects?.find(project => project.default) ?? config.daemon.projects?.[0];
  return resolve(defaultProject?.repo_path ?? _ENGINE_REPO_DIR);
}

export function resolveTaskProfile(schedulerConfig?: NyxHiveConfig["scheduler"]): TaskProfile {
  if (schedulerConfig?.task_profile) return schedulerConfig.task_profile;
  return schedulerConfig?.seed_defaults === true ? "full" : "none";
}

function buildWeeklyDriftPrompt(repoPath: string): string {
  return `Compare the Obsidian vault documentation and recent git history against the current codebase state. This combines drift detection and vault sync into one weekly check.

The NyxHive repository is at ${repoPath} — run all git commands there.

Steps:
1. Run \`git -C ${repoPath} log --oneline --since="7 days ago"\` to see recent changes
2. Check for drift in these areas:
   a. **Agent roster**: Compare agents documented in the vault against the actual agent registry. Flag any that exist in code but not docs, or vice versa.
   b. **File paths**: Check file paths referenced in vault notes against the actual file system. Flag broken references.
   c. **Config schema**: Compare documented config schema against actual config types in the codebase.
   d. **API endpoints**: Compare documented API endpoints against actual route definitions.
   e. **Recent commits**: For significant changes (new features, API changes, config changes, agent changes) — check if vault documentation reflects them.

For each drift item found, create a proposal using [@propose:] with:
- Category: maintenance
- Priority: low
- Clear description of the drift and what needs updating
- Whether the code or the docs should be the source of truth

Skip: bug fixes that don't change interfaces, test-only changes, dependency updates, minor refactors.

If no drift is found, say "No drift detected."`;
}

// ---------------------------------------------------------------------------
// upsertSystemTask — single helper for all system task registrations
// ---------------------------------------------------------------------------

interface SystemTaskDef {
  name: string;
  description: string;
  cron: string;
  agent: string;
  prompt: string;
  category?: string;
  channel?: string;
  timeout_ms?: number;
  authority_profile?: "scheduled" | "system" | "interactive";
  chain_to?: { task_name: string; inject_result?: boolean; only_if?: string | string[] };
  /** Update all fields on every bootstrap run (not just agent). Default: false. */
  alwaysUpdate?: boolean;
  /** When task exists with a different agent, migrate it. Default: false. */
  migrateAgent?: boolean;
}

/**
 * Upsert a system task into scheduled_tasks with a consistent schema.
 * Handles exists-check, update-or-insert, and optional agent migration.
 */
function upsertSystemTask(db: Database, task: SystemTaskDef): void {
  const existing = db.query(
    "SELECT id, agent, created_by FROM scheduled_tasks WHERE name = ? ORDER BY created_by = 'system' DESC LIMIT 1",
  ).get(task.name) as { id: string; agent: string; created_by: string } | null;

  const chainJson = task.chain_to ? JSON.stringify(task.chain_to) : null;

  if (existing) {
    if (task.alwaysUpdate) {
      const nextRun = nextOccurrence(parseCron(task.cron)).getTime();
      db.run(
        `UPDATE scheduled_tasks SET
          description = ?, cron_expression = ?, agent = ?, prompt = ?,
          category = ?, chain_to = ?, next_run_at = ?, updated_at = ?
        WHERE id = ?`,
        [task.description, task.cron, task.agent, task.prompt, task.category ?? null, chainJson, nextRun, Date.now(), existing.id],
      );
    } else if (task.migrateAgent && existing.agent !== task.agent) {
      db.run(
        "UPDATE scheduled_tasks SET agent = ?, prompt = ?, updated_at = ? WHERE id = ?",
        [task.agent, task.prompt, Date.now(), existing.id],
      );
      logger.info(`[scheduler] Migrated ${task.name} from ${existing.agent} → ${task.agent}`);
    }
    return;
  }

  const id = randomUUID();
  const now = Date.now();
  const nextRun = nextOccurrence(parseCron(task.cron)).getTime();
  db.run(
    `INSERT INTO scheduled_tasks
      (id, name, description, cron_expression, agent, prompt, channel, category, chain_to, enabled, next_run_at, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'system', ?, ?)`,
    [id, task.name, task.description, task.cron, task.agent, task.prompt, task.channel ?? "api", task.category ?? null, chainJson, nextRun, now, now],
  );
  logger.info(`[scheduler] Created ${task.name} task`);
}

// ---------------------------------------------------------------------------
// loadConfigTasks — instance-specific tasks from config.toml
// ---------------------------------------------------------------------------

export function loadConfigTasks(deps: BootstrapDeps): void {
  const { db, config } = deps;
  const tasks = config.scheduler?.tasks;
  if (!tasks || tasks.length === 0) return;
  migrateAdaptiveColumns(db);

  if (config.scheduler?.automations === false) {
    const removed = db.run("DELETE FROM scheduled_tasks WHERE created_by = 'config'");
    if (removed.changes > 0) {
      logger.info(`[scheduler] Removed ${removed.changes} config-defined task(s) because scheduler.automations=false`);
    }
    return;
  }

  for (const task of tasks) {
    const existing = db.query(
      "SELECT id FROM scheduled_tasks WHERE name = ? AND created_by = 'config'",
    ).get(task.name) as { id: string } | null;

    if (existing) {
      db.run(
        `UPDATE scheduled_tasks SET
          description = ?, cron_expression = ?, agent = ?, prompt = ?,
          channel = ?, recipient = ?, category = ?, chain_to = ?, notify_channels = ?,
          timeout_ms = ?, authority_profile = ?, enabled = 1, updated_at = ?
        WHERE id = ?`,
        [
          task.description ?? null,
          task.cron ?? null,
          task.agent,
          task.prompt,
          task.channel ?? "api",
          task.recipient ?? null,
          task.category ?? "ops",
          task.chain_to ? JSON.stringify(task.chain_to) : null,
          task.notify_channels ? JSON.stringify(task.notify_channels) : null,
          task.timeout_ms ?? null,
          task.authority_profile ?? "scheduled",
          Date.now(),
          existing.id,
        ],
      );
    } else {
      const id = randomUUID();
      const now = Date.now();
      const nextRun = task.cron
        ? nextOccurrence(parseCron(task.cron)).getTime()
        : (task.run_at ?? now);

      db.run(
        `INSERT INTO scheduled_tasks
          (id, name, description, cron_expression, run_at, agent, prompt, channel, recipient, category, chain_to, notify_channels, timeout_ms, authority_profile, enabled, next_run_at, created_by, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'config', ?, ?)`,
        [
          id,
          task.name,
          task.description ?? null,
          task.cron ?? null,
          task.run_at ?? null,
          task.agent,
          task.prompt,
          task.channel ?? "api",
          task.recipient ?? null,
          task.category ?? "ops",
          task.chain_to ? JSON.stringify(task.chain_to) : null,
          task.notify_channels ? JSON.stringify(task.notify_channels) : null,
          task.timeout_ms ?? null,
          task.authority_profile ?? "scheduled",
          nextRun,
          now,
          now,
        ],
      );
    }
  }

  // Remove config-created tasks that are no longer in the config
  const configNames = new Set(tasks.map(t => t.name));
  const dbConfigTasks = db.query(
    "SELECT id, name FROM scheduled_tasks WHERE created_by = 'config'",
  ).all() as Array<{ id: string; name: string }>;
  for (const row of dbConfigTasks) {
    if (!configNames.has(row.name)) {
      db.run("DELETE FROM scheduled_tasks WHERE id = ?", [row.id]);
      logger.info(`[scheduler] Removed stale config task: ${row.name}`);
    }
  }

  logger.info(`[scheduler] Loaded ${tasks.length} config-defined tasks`);
}

// ---------------------------------------------------------------------------
function deleteSystemTasksNotInProfile(db: Database, keepTaskNames: ReadonlySet<string>): void {
  for (const name of ALL_SYSTEM_TASK_NAMES) {
    if (!keepTaskNames.has(name)) {
      db.run("DELETE FROM scheduled_tasks WHERE name = ? AND created_by = 'system'", [name]);
    }
  }
}

// loadDefaultHeartbeat — built-in system tasks via task profiles
// ---------------------------------------------------------------------------

/**
 * Load default system tasks. Background tasks run on the cheapest available agent.
 * System tasks (no LLM) use agent = "system".
 */
export function loadDefaultHeartbeat(deps: BootstrapDeps): void {
  const { db, config, registry, proposalStore } = deps;
  if (!registry) return;

  const schedulerConfig = config.scheduler;
  const taskProfile = resolveTaskProfile(schedulerConfig);
  const crawlEnabled = config.crawl?.enabled === true;
  const driftRepoPath = resolveDriftRepoPath(config);

  // Resolve agent keys dynamically from the registry — never hardcode agent names
  let orchestratorKey = "orchestrator";
  let backgroundAgent = "analyst";
  for (const [key, entry] of registry.getAllEntries()) {
    if (entry.role === "orchestrator" || entry.role === "lead") { orchestratorKey = key; }
    // Skip sentinel — it's a lightweight local-LLM agent, not a general-purpose background worker
    if (entry.role === "worker" && key !== "sentinel") { backgroundAgent = key; }
  }
  // Fallback: if no worker found, use the orchestrator for background tasks
  if (!registry.get(backgroundAgent)) {
    backgroundAgent = orchestratorKey;
  }

  // Migrate: remove old heartbeat agent from registry if it still exists
  const existingHb = registry.getEntry("heartbeat");
  if (existingHb) {
    registry.disable("heartbeat").success ||
      db.run("DELETE FROM agent_registry WHERE key = 'heartbeat'");
    logger.info("[scheduler] Removed legacy heartbeat agent — tasks now run on analyst");
  }

  // Migrate: reassign any tasks still pointing at dead agents
  const configAgentKeys = Object.keys(config.agents ?? {});
  const deadAgents = ["heartbeat", "scout", "scribe", "forge", "researcher", "vigil"]
    .filter(a => !configAgentKeys.includes(a));
  for (const dead of deadAgents) {
    db.run(
      "UPDATE scheduled_tasks SET agent = ?, updated_at = ? WHERE agent = ? AND agent != 'system'",
      [backgroundAgent, Date.now(), dead],
    );
  }

  const desiredTaskNames = new Set<string>(TASK_PROFILES[taskProfile]);
  if (taskProfile === "full" && crawlEnabled) {
    for (const name of CRAWL_SYSTEM_TASK_NAMES) desiredTaskNames.add(name);
  }
  if (!proposalStore) {
    for (const name of PROPOSAL_SYSTEM_TASK_NAMES) desiredTaskNames.delete(name);
  }

  if (taskProfile === "none") {
    deleteSystemTasksNotInProfile(db, desiredTaskNames);
    logger.info("[scheduler] System task profile 'none' — leaving instance blank");
    return;
  }

  // --- System task definitions ---

  // Only assign sentinel tasks to the sentinel agent if it is actually registered.
  const sentinelAgent = registry.get("sentinel") ? "sentinel" : backgroundAgent;

  upsertSystemTask(db, {
    name: "heartbeat:health-check",
    cron: "*/10 * * * *",
    agent: sentinelAgent,
    category: "heartbeat",
    description: "Sentinel health pulse every 10min (local LLM, zero cost)",
    prompt: `Review the prefetched system health snapshot above.

Classify the instance as OK, WARN, or CRITICAL.
- OK: no meaningful issues, or only harmless noise
- WARN: degraded but not on fire
- CRITICAL: service down, runaway failures, serious cost/queue issues, or auth broken

Respond in one line: STATUS - short reason.
Do NOT invoke skills, tools, or action tags.`,
    alwaysUpdate: true,
  });

  // Sentinel: error triage every 30min
  upsertSystemTask(db, {
    name: "sentinel:error-triage",
    cron: "*/30 * * * *",
    agent: sentinelAgent,
    category: "heartbeat",
    description: "Triage recent failures every 30min (local LLM, zero cost)",
    prompt: `Review the prefetched recent error section above. For each error, classify as:
- NOISE — known, harmless, or transient (rate limits recovering, timeouts on idle connections)
- ACTION — needs investigation (repeated failures, new error types, data corruption)
- ESCALATE — needs immediate attention (security, data loss, all providers down)

Respond with one line per error: [NOISE|ACTION|ESCALATE] — brief reason
If no errors, respond: OK — no errors in last 30min
Do NOT invoke skills or action tags. If any are ESCALATE, end with: [@alert: <summary>]`,
    alwaysUpdate: true,
  });

  // Sentinel: cost watchdog hourly
  upsertSystemTask(db, {
    name: "sentinel:cost-watchdog",
    cron: "3 * * * *",
    agent: sentinelAgent,
    category: "heartbeat",
    description: "Hourly cost pacing check (local LLM, zero cost)",
    prompt: `Cost check. Use the prefetched cost section above to determine if we are on pace to exceed the daily budget.

Rules:
- OK if projected < $40
- WARN if projected $40-$70 — mention which agent is driving cost
- CRITICAL if projected > $70

Respond: STATUS — reason. Do NOT invoke skills or action tags.`,
    alwaysUpdate: true,
  });

  // Dev heartbeat — executes approved proposals every 4 hours (server-side, no LLM)
  if (desiredTaskNames.has("dev:execute-approved")) {
    upsertSystemTask(db, {
      name: "dev:execute-approved",
      cron: "0 */4 * * *",
      agent: "system",
      description: "Pick up approved proposals and execute them",
      prompt: "Server-side: fetches approved proposals and dispatches to the right agent.",
      migrateAgent: true,
    });

    upsertSystemTask(db, {
      name: "proposals:sync-merged",
      cron: "30 */2 * * *",
      agent: "system",
      description: "Check completed proposals for merged PRs and update status",
      prompt: "Server-side: checks GitHub PR state for completed proposals with PRs.",
    });

    upsertSystemTask(db, {
      name: "proposals:reset-stale-reviewing",
      cron: "*/15 * * * *",
      agent: "system",
      description: "Reset proposals stuck in reviewing status for >1 hour back to proposed",
      prompt: "Server-side: resets stale reviewing proposals.",
    });
  }

  // Remove legacy daily digest (replaced by briefing system)
  db.run("DELETE FROM scheduled_tasks WHERE name = 'proposals:daily-digest' AND created_by = 'system'");

  // Briefing tasks
  if (desiredTaskNames.has("briefing:auto-review")) {
    upsertSystemTask(db, {
      name: "briefing:auto-review",
      cron: "0 8 * * *",
      agent: "system",
      category: "briefing",
      description: "Auto-review pending proposals before morning briefing",
      prompt: "Auto-review all pending proposals",
      chain_to: { task_name: "briefing:daily", inject_result: true, only_if: "always" },
      alwaysUpdate: true,
    });

    upsertSystemTask(db, {
      name: "briefing:daily",
      cron: "0 9 * * *",
      agent: backgroundAgent,
      category: "briefing",
      description: "Morning briefing — proposals, scans, learnings, costs",
      prompt: `Compile User's morning briefing from the pre-fetched data above. All data has been gathered for you — do NOT try to query any endpoints or APIs. Just synthesize.

Format the briefing as:

# Morning Briefing — {date}

## Proposals
For each reviewed proposal, show:
- Title — **Verdict: APPROVE/REJECT** — 1-line why
List any with APPROVE verdict that need User's attention first.
Count: X new, Y reviewed, Z awaiting action.

## Scans & Discoveries
Which scans ran overnight, 1-line summary of findings each.
Skip scans that found nothing noteworthy.

## Cost
Report the **Variable API spend** number exactly as provided — this is real money. The Max subscription agents have NO dollar cost shown because they're flat rate ($200/mo). Show their call counts and token usage for context, but DO NOT calculate or estimate dollar amounts for them.

## Action Items
- Proposals to approve (most important first)
- Failed tasks needing attention
- Anything time-sensitive

Keep it scannable — User reads this on his phone over coffee. No fluff.`,
      migrateAgent: true,
    });
  }

  // Memory maintenance — weekly pruning of stale knowledge and graph decay
  if (desiredTaskNames.has("memory:maintenance")) {
    upsertSystemTask(db, {
      name: "memory:maintenance",
      cron: "0 3 * * 0", // Sunday 3am
      agent: "system",
      description: "Weekly memory/knowledge pruning and importance decay",
      prompt: "Server-side: prunes stale knowledge, decays graph importance, prunes low-importance nodes.",
    });
  }

  // Pattern distillation — weekly extraction of learned patterns from task outcomes
  if (desiredTaskNames.has("learning:distill-patterns")) {
    upsertSystemTask(db, {
      name: "learning:distill-patterns",
      cron: "0 2 * * 1", // Monday 2am
      agent: "system",
      description: "Weekly pattern distillation — extract reusable patterns from task outcomes",
      prompt: "Server-side: queries recent outcomes, extracts patterns via LLM, stores in PatternStore for delegation injection.",
    });
  }

  // Crawl tasks — conditional on crawl.enabled
  if (desiredTaskNames.has("crawl:run-sources")) {
    upsertSystemTask(db, {
      name: "crawl:run-sources",
      cron: "0 */4 * * *",
      agent: "system",
      description: "Run due configured crawl sources and ingest changed content",
      prompt: "Server-side: runs due crawl sources via Cloudflare Browser Rendering and ingests results into knowledge.",
    });

    upsertSystemTask(db, {
      name: "crawl:cleanup-stale",
      cron: "30 3 * * 0",
      agent: "system",
      description: "Remove crawl knowledge for disabled or removed crawl sources",
      prompt: "Server-side: removes crawl-ingested knowledge chunks for inactive crawl sources.",
    });
  }

  // Drift detection + vault sync — weekly task comparing vault docs against code and recent commits
  if (desiredTaskNames.has("maintenance:drift-and-sync")) {
    upsertSystemTask(db, {
      name: "maintenance:drift-and-sync",
      cron: "0 10 * * 1", // Monday 10am
      agent: orchestratorKey,
      description: "Weekly drift check — vault docs vs codebase state and recent commits",
      prompt: buildWeeklyDriftPrompt(driftRepoPath),
      migrateAgent: true,
    });
  }

  // Evolution loop — nightly codebase review and operating-model triage
  if (desiredTaskNames.has("evolution:codebase-review")) {
    upsertSystemTask(db, {
      name: "evolution:codebase-review",
      cron: "0 2 * * *", // 2am daily
      agent: orchestratorKey,
      category: "evolution",
      description: "Nightly codebase evolution — analyze, triage improvements into the right operating lane",
      chain_to: { task_name: "briefing:auto-review", inject_result: true, only_if: "contains:[@propose:" },
      alwaysUpdate: true,
      prompt: `Run one lightweight self-improvement cycle for NyxHive.

Goal: improve the software stack, tools, workflows, memory, and execution quality without creating low-value churn.

Decision question: What is the one highest-leverage bounded improvement NyxHive should make this run?

Artifact-first output:
- Every cycle must resolve exactly one Question / Evidence / Decision / Artifacts / Notification record before sending a narrative report.
- Evidence must cite fresh local facts, not stale memory or optimistic narrative.
- Artifacts must name durable refs: commit hashes, changed files, test/typecheck commands, trace IDs, proposals, or explicit no-op evidence.
- Notification must say sent, suppressed, or not applicable, with the reason.

Hourly loop:
1. Review fresh evidence: recent failures, test/typecheck state if relevant, recent commits, logs, TODO/FIXME hotspots, repeated operator corrections, and scheduler/queue health.
2. Prioritize exactly one candidate using leverage, pain, confidence, safety, measurability, and maintenance value.
3. Implement only if the change is small, reversible, high-confidence, and not security/auth/budget/product-risky. Otherwise investigate or create a proposal using [@propose:].
4. Verify with fresh command output. If code changed, run the relevant focused check, then \`bun test\` and \`bun run typecheck\` before claiming completion.
5. Report back in plain English every cycle: what was done, the goal of the improvement, why it mattered, files changed, verification output, and the outcome. If nothing changed, say why the no-op was the right call. Use [@learn:] for durable lessons worth keeping.
6. Stop after one improvement or a deliberate no-op. Do not branch into adjacent work.

Evidence hygiene:
- Use \`rg --no-ignore --files .nyxhive/data -g '!**/scratchpads/**'\` for runtime file scans because DB/log files are ignored and scratchpad archives are noisy; use live \`.nyxhive/data/*.log\`, \`.out\`, \`.err\`, and tracked source/config files for logs/TODOs.
- For tracked source hotspot scans, default to TODO/FIXME/HACK/XXX plus exact deprecated command strings in product source/config only. Exclude lockfiles (\`bun.lock\`, \`package-lock.json\`, \`pnpm-lock.yaml\`, \`yarn.lock\`), source maps (\`*.map\`), compiled/generated/vendor/build artifacts (\`lib/**\`, \`dist/**\`, \`build/**\`, \`generated/**\`, \`node_modules/**\`), historical plans/docs (\`docs/**/plans/**\`, \`plans/**\`), archived souls (\`souls/_archive/**\`), and memory reflections (\`memory/reflections.md\`) unless investigating that history directly. Scan generic WARN/ERROR/failed/failure in live logs, not broad source trees, unless fresh evidence points at a specific file.
- Read SQLite schema (\`.schema\` or \`PRAGMA table_info\`) before querying runtime tables; \`scheduled_tasks\` and \`task_outcomes\` live in \`memory.db\`, while \`messages\`, \`delegation_runs\`, \`proposals\`, and \`tasks\` live in \`nyxai.db\`.
- Treat command/query mistakes as operator noise unless they reveal a reproducible workflow bug.

Decision rules:
- Build new capability only when the same limitation has blocked 3+ real tasks and existing tools cannot cover it cleanly.
- Refine an existing workflow when the mechanism works but causes friction, ambiguity, latency, or repeated mistakes.
- Pay down technical debt when it actively slows changes, hides failures, or makes verification unreliable.
- Stop and stabilize when tests or typecheck are red, logs hide real faults, or two cycles in a row fail to produce a clean verified improvement.
- Do nothing when the best available work is low-leverage busywork; log the no-op and preserve the hour.

Hard limits:
- One active improvement per cycle.
- No major architecture, auth, security, billing, or product-direction changes without explicit approval.
- No stacking unverified work.
- If verification fails and the fix is not obvious in the same cycle, revert or quarantine the change and report the rollback path.`,
      migrateAgent: true,
    });
  }

  // Watchdog: stuck agent detection (every 5 minutes, system task)
  if (desiredTaskNames.has("watchdog:stuck-detection")) {
    upsertSystemTask(db, {
      name: "watchdog:stuck-detection",
      cron: "*/5 * * * *",
      agent: "system",
      description: "Detect and recover stuck agents every 5 minutes",
      prompt: "Check for stuck agents and auto-retry",
    });
  }

  // Routing: cleanup stale routing decisions (every 6 hours, system task)
  if (desiredTaskNames.has("routing:cleanup-stale")) {
    upsertSystemTask(db, {
      name: "routing:cleanup-stale",
      cron: "0 */6 * * *",
      agent: "system",
      description: "Resolve stale routing decisions as abandoned every 6 hours",
      prompt: "Cleanup stale routing decisions",
    });
  }

  // Self-documentation sync — weekly system state snapshot to Obsidian
  if (desiredTaskNames.has("docs:sync")) {
    upsertSystemTask(db, {
      name: "docs:sync",
      cron: "0 4 * * 0", // Sunday 4am
      agent: "system",
      description: "Weekly self-documentation — generates system state snapshot to Obsidian vault",
      prompt: "Server-side: generates agent roster, scheduled tasks, learned patterns, routing skill matrix, writes to vault/System/system-state.md.",
    });
  }

  // Clean up removed tasks from previous versions
  for (const name of REMOVED_TASK_NAMES) {
    db.run("DELETE FROM scheduled_tasks WHERE name = ? AND created_by IN ('system', 'api')", [name]);
  }

  deleteSystemTasksNotInProfile(db, desiredTaskNames);
  logger.info(`[scheduler] System tasks seeded for profile '${taskProfile}'`);

  // Set typed notify_channels on automation tasks
  const reportsNotify = resolveNotifyChannelsForType(config, "reports");
  if (reportsNotify) {
    const reportTasks = ["briefing:daily"];
    for (const name of reportTasks) {
      db.run(
        "UPDATE scheduled_tasks SET notify_channels = ?, updated_at = ? WHERE name = ? AND created_by = 'system'",
        [reportsNotify, Date.now(), name],
      );
    }
    logger.info(`[scheduler] Set reports notify_channels on ${reportTasks.length} tasks`);
  }

  const activityNotify = resolveNotifyChannelsForType(config, "activity");
  if (activityNotify) {
    db.run(
      "UPDATE scheduled_tasks SET notify_channels = ?, updated_at = ? WHERE name = ? AND created_by = 'system'",
      [activityNotify, Date.now(), "evolution:codebase-review"],
    );
    logger.info("[scheduler] Set activity notify_channels on evolution task");
  }

  // Validate chain_to references — catch broken chains at boot, not at 2am
  validateChains(db);
}

function validateChains(db: Database): void {
  const tasksWithChains = db.query(
    "SELECT name, chain_to FROM scheduled_tasks WHERE chain_to IS NOT NULL AND enabled = 1",
  ).all() as Array<{ name: string; chain_to: string }>;

  for (const task of tasksWithChains) {
    let chain: { task_name: string; only_if?: string | string[] };
    try {
      chain = JSON.parse(task.chain_to);
    } catch {
      logger.warn(`[scheduler] Chain validation: ${task.name} has invalid chain_to JSON`);
      continue;
    }

    // Check target exists
    const target = db.query(
      "SELECT name, enabled FROM scheduled_tasks WHERE name = ? LIMIT 1",
    ).get(chain.task_name) as { name: string; enabled: number } | null;

    if (!target) {
      logger.warn(`[scheduler] Chain validation: ${task.name} → "${chain.task_name}" — target task not found`);
    } else if (!target.enabled) {
      logger.warn(`[scheduler] Chain validation: ${task.name} → "${chain.task_name}" — target is disabled`);
    }

    // Validate only_if conditions
    const conditions = Array.isArray(chain.only_if) ? chain.only_if : chain.only_if ? [chain.only_if] : [];
    for (const cond of conditions) {
      if (cond.startsWith("matches:")) {
        try {
          new RegExp(cond.slice("matches:".length));
        } catch {
          logger.warn(`[scheduler] Chain validation: ${task.name} has invalid regex in only_if: ${cond}`);
        }
      }
    }
  }
}

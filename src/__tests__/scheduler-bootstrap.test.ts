/**
 * Tests for scheduler/bootstrap.ts — task registration and default task definitions.
 */
import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { Database } from "bun:sqlite";
import { resolve } from "path";
import { resolveHeartbeatModel, loadConfigTasks, loadDefaultHeartbeat, resolveTaskProfile } from "../scheduler/bootstrap.js";
import type { BootstrapDeps } from "../scheduler/bootstrap.js";
import type { NyxHiveConfig } from "../types.js";
import type { ProviderRouter } from "../providers/router.js";
import type { AgentRegistry, AgentRegistryEntry } from "../agents/registry.js";
import type { ProposalStore } from "../proposals/store.js";

// ─── Helpers ────────────────────────────────────────────────────────

const SCHEMA = `
CREATE TABLE IF NOT EXISTS scheduled_tasks (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT,
  cron_expression TEXT,
  run_at INTEGER,
  agent TEXT NOT NULL,
  prompt TEXT NOT NULL,
  channel TEXT NOT NULL DEFAULT 'api',
  recipient TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  last_run_at INTEGER,
  next_run_at INTEGER NOT NULL,
  last_status TEXT,
  last_error TEXT,
  last_result TEXT,
  category TEXT DEFAULT 'ops',
  run_count INTEGER NOT NULL DEFAULT 0,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  created_by TEXT,
  notify_channels TEXT,
  notify_thread_id TEXT,
  chain_to TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scheduled_next ON scheduled_tasks(enabled, next_run_at);

CREATE TABLE IF NOT EXISTS agent_registry (
  key TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  min_model TEXT,
  max_model TEXT,
  system_prompt TEXT,
  working_directory TEXT NOT NULL,
  capabilities TEXT,
  always_cli INTEGER DEFAULT 0,
  cli_fallback TEXT,
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

function makeConfig(
  overrides?: Partial<NyxHiveConfig> & { scheduler?: Record<string, unknown> },
): NyxHiveConfig {
  return {
    agents: {},
    channels: {},
    daemon: { name: "test-instance", data_dir: "/tmp/test-nyxhive" },
    ...overrides,
  } as NyxHiveConfig;
}

function makeRouter(hasOpenRouter: boolean, hasOllama = false): ProviderRouter {
  return {
    hasProvider: (name: string) =>
      (name === "openrouter" && hasOpenRouter)
      || (name === "ollama" && hasOllama),
  } as unknown as ProviderRouter;
}

function makeRegistry(overrides?: {
  entries?: Map<string, AgentRegistryEntry>;
  heartbeat?: AgentRegistryEntry | undefined;
}): AgentRegistry {
  const defaultEntries = new Map<string, AgentRegistryEntry>();
  defaultEntries.set("nyx", { name: "Nyx", role: "lead", enabled: true } as unknown as AgentRegistryEntry);
  defaultEntries.set("analyst", { name: "Analyst", role: "worker", enabled: true } as unknown as AgentRegistryEntry);
  const entries = overrides?.entries ?? defaultEntries;
  return {
    get: mock((key: string) => {
      const entry = entries.get(key);
      if (!entry || !entry.enabled) return undefined;
      return entry;
    }),
    getEntry: mock((key: string) => {
      if (key === "heartbeat") return overrides?.heartbeat ?? undefined;
      return entries.get(key);
    }),
    create: mock(() => ({ success: true })),
    update: mock(() => ({ success: true })),
    disable: mock(() => ({ success: true })),
    getAllEntries: mock(() => entries),
    getGlobalDirs: mock(() => ["/tmp/global"]),
  } as unknown as AgentRegistry;
}

function makeDeps(overrides?: Partial<BootstrapDeps>): BootstrapDeps & { db: Database } {
  const db = new Database(":memory:");
  db.exec(SCHEMA);
  return {
    config: makeConfig(),
    ...overrides,
    db: overrides?.db ?? db,
  };
}

function getAllTasks(db: Database): Array<Record<string, unknown>> {
  return db.query("SELECT * FROM scheduled_tasks ORDER BY name").all() as Array<Record<string, unknown>>;
}

function getTaskByName(db: Database, name: string): Record<string, unknown> | null {
  return db.query("SELECT * FROM scheduled_tasks WHERE name = ?").get(name) as Record<string, unknown> | null;
}

function getSystemTaskNames(db: Database): string[] {
  return db.query("SELECT name FROM scheduled_tasks WHERE created_by = 'system' ORDER BY name")
    .all()
    .map((row) => (row as { name: string }).name);
}

// ─── resolveHeartbeatModel ──────────────────────────────────────────

describe("resolveHeartbeatModel", () => {
  test("returns ollama llama3.2 when ollama is available", () => {
    const router = makeRouter(true, true);
    const result = resolveHeartbeatModel(router);
    expect(result).toEqual({ provider: "ollama", model: "llama3.2:3b" });
  });

  test("returns openrouter deepseek when openrouter available", () => {
    const router = makeRouter(true);
    const result = resolveHeartbeatModel(router);
    expect(result).toEqual({ provider: "openrouter", model: "deepseek/deepseek-v3.2" });
  });

  test("returns anthropic haiku when openrouter not available", () => {
    const router = makeRouter(false);
    const result = resolveHeartbeatModel(router);
    expect(result).toEqual({ provider: "anthropic", model: "claude-haiku-4-5-20251001" });
  });

  test("returns anthropic haiku when no router provided", () => {
    const result = resolveHeartbeatModel(undefined);
    expect(result).toEqual({ provider: "anthropic", model: "claude-haiku-4-5-20251001" });
  });
});

describe("resolveTaskProfile", () => {
  test("defaults seed_defaults=true to full", () => {
    expect(resolveTaskProfile({ seed_defaults: true })).toBe("full");
  });

  test("defaults seed_defaults=false to none", () => {
    expect(resolveTaskProfile({ seed_defaults: false })).toBe("none");
  });

  test("prefers explicit task_profile over seed_defaults", () => {
    expect(resolveTaskProfile({ seed_defaults: false, task_profile: "monitor" })).toBe("monitor");
  });
});

// ─── loadConfigTasks ────────────────────────────────────────────────

describe("loadConfigTasks", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(SCHEMA);
  });

  afterEach(() => {
    db.close();
  });

  test("does nothing when no tasks in config", () => {
    const deps = { db, config: makeConfig({ scheduler: { tasks: [] } }) };
    loadConfigTasks(deps);
    expect(getAllTasks(db)).toHaveLength(0);
  });

  test("does nothing when scheduler is undefined", () => {
    const deps = { db, config: makeConfig() };
    loadConfigTasks(deps);
    expect(getAllTasks(db)).toHaveLength(0);
  });

  test("removes config tasks when automations are disabled", () => {
    loadConfigTasks({
      db,
      config: makeConfig({
        scheduler: {
          tasks: [{ name: "old-hourly", agent: "nyx", prompt: "loop", cron: "7 * * * *" }],
        },
      }),
    });
    expect(getAllTasks(db)).toHaveLength(1);

    loadConfigTasks({
      db,
      config: makeConfig({
        scheduler: {
          automations: false,
          tasks: [{ name: "old-hourly", agent: "nyx", prompt: "loop", cron: "7 * * * *" }],
        },
      }),
    });

    expect(getAllTasks(db)).toHaveLength(0);
  });

  test("inserts a new config task with cron expression", () => {
    const deps = {
      db,
      config: makeConfig({
        scheduler: {
          tasks: [{
            name: "test-task",
            description: "A test task",
            cron: "0 * * * *",
            agent: "nyx",
            prompt: "Do something",
          }],
        },
      }),
    };
    loadConfigTasks(deps);

    const tasks = getAllTasks(db);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].name).toBe("test-task");
    expect(tasks[0].description).toBe("A test task");
    expect(tasks[0].cron_expression).toBe("0 * * * *");
    expect(tasks[0].agent).toBe("nyx");
    expect(tasks[0].prompt).toBe("Do something");
    expect(tasks[0].channel).toBe("api");
    expect(tasks[0].category).toBe("ops");
    expect(tasks[0].created_by).toBe("config");
    expect(tasks[0].enabled).toBe(1);
    expect(tasks[0].next_run_at).toBeGreaterThan(0);
  });

  test("inserts a one-shot task with run_at", () => {
    const runAt = Date.now() + 60_000;
    const deps = {
      db,
      config: makeConfig({
        scheduler: {
          tasks: [{
            name: "one-shot",
            agent: "nyx",
            prompt: "Run once",
            run_at: runAt,
          }],
        },
      }),
    };
    loadConfigTasks(deps);

    const task = getTaskByName(db, "one-shot");
    expect(task).not.toBeNull();
    expect(task!.cron_expression).toBeNull();
    expect(task!.next_run_at).toBe(runAt);
  });

  test("updates existing config task on re-run", () => {
    // First run
    const deps1 = {
      db,
      config: makeConfig({
        scheduler: {
          tasks: [{
            name: "updatable",
            agent: "nyx",
            prompt: "v1",
            cron: "0 * * * *",
          }],
        },
      }),
    };
    loadConfigTasks(deps1);

    const before = getTaskByName(db, "updatable");
    expect(before!.prompt).toBe("v1");

    // Second run with updated prompt
    const deps2 = {
      db,
      config: makeConfig({
        scheduler: {
          tasks: [{
            name: "updatable",
            agent: "nyx",
            prompt: "v2",
            cron: "0 * * * *",
            description: "Updated",
          }],
        },
      }),
    };
    loadConfigTasks(deps2);

    const after = getTaskByName(db, "updatable");
    expect(after!.prompt).toBe("v2");
    expect(after!.description).toBe("Updated");
    // Should still be just one task
    expect(getAllTasks(db)).toHaveLength(1);
  });

  test("removes stale config tasks no longer in config", () => {
    // First run with two tasks
    const deps1 = {
      db,
      config: makeConfig({
        scheduler: {
          tasks: [
            { name: "keep-me", agent: "nyx", prompt: "keep" },
            { name: "remove-me", agent: "nyx", prompt: "remove" },
          ],
        },
      }),
    };
    loadConfigTasks(deps1);
    expect(getAllTasks(db)).toHaveLength(2);

    // Second run with only one task — stale task should be removed
    const deps2 = {
      db,
      config: makeConfig({
        scheduler: {
          tasks: [
            { name: "keep-me", agent: "nyx", prompt: "keep" },
          ],
        },
      }),
    };
    loadConfigTasks(deps2);

    const tasks = getAllTasks(db);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].name).toBe("keep-me");
  });

  test("does not remove system-created tasks when cleaning stale config tasks", () => {
    // Insert a system task manually
    db.run(
      `INSERT INTO scheduled_tasks (id, name, agent, prompt, channel, enabled, next_run_at, created_by, created_at, updated_at)
       VALUES ('sys-1', 'heartbeat:health-check', 'analyst', 'check', 'api', 1, ${Date.now()}, 'system', ${Date.now()}, ${Date.now()})`,
    );

    // Run loadConfigTasks with a config task
    const deps = {
      db,
      config: makeConfig({
        scheduler: {
          tasks: [{ name: "my-task", agent: "nyx", prompt: "do it" }],
        },
      }),
    };
    loadConfigTasks(deps);

    // System task should survive the stale-cleanup
    expect(getTaskByName(db, "heartbeat:health-check")).not.toBeNull();
    expect(getTaskByName(db, "my-task")).not.toBeNull();
  });

  test("defaults channel to api and category to ops", () => {
    const deps = {
      db,
      config: makeConfig({
        scheduler: {
          tasks: [{
            name: "defaults-test",
            agent: "nyx",
            prompt: "test",
          }],
        },
      }),
    };
    loadConfigTasks(deps);

    const task = getTaskByName(db, "defaults-test");
    expect(task!.channel).toBe("api");
    expect(task!.category).toBe("ops");
  });

  test("respects custom channel and category", () => {
    const deps = {
      db,
      config: makeConfig({
        scheduler: {
          tasks: [{
            name: "custom-task",
            agent: "nyx",
            prompt: "test",
            channel: "slack",
            recipient: "jay",
            category: "briefing",
          }],
        },
      }),
    };
    loadConfigTasks(deps);

    const task = getTaskByName(db, "custom-task");
    expect(task!.channel).toBe("slack");
    expect(task!.recipient).toBe("jay");
    expect(task!.category).toBe("briefing");
  });

  test("persists notify_channels for config tasks", () => {
    const deps = {
      db,
      config: makeConfig({
        scheduler: {
          tasks: [{
            name: "briefing:daily",
            agent: "nyx",
            prompt: "brief",
            notify_channels: ["telegram:owner-123"],
          }],
        },
      }),
    };
    loadConfigTasks(deps);

    const task = getTaskByName(db, "briefing:daily");
    expect(task!.notify_channels).toBe(JSON.stringify(["telegram:owner-123"]));
  });
});

// ─── loadDefaultHeartbeat ───────────────────────────────────────────

describe("loadDefaultHeartbeat", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(SCHEMA);
  });

  afterEach(() => {
    db.close();
  });

  test("does nothing when registry is not provided", () => {
    const deps: BootstrapDeps = { db, config: makeConfig() };
    loadDefaultHeartbeat(deps);
    expect(getAllTasks(db)).toHaveLength(0);
  });

  test("does not create a heartbeat agent — tasks go to analyst", () => {
    const registry = makeRegistry();
    const deps: BootstrapDeps = { db, config: makeConfig(), registry };
    loadDefaultHeartbeat(deps);

    // No heartbeat agent should be created
    const createCalls = (registry.create as ReturnType<typeof mock>).mock.calls;
    const heartbeatCreate = createCalls.find((c: unknown[]) => c[0] === "heartbeat");
    expect(heartbeatCreate).toBeUndefined();
  });

  test("does not create default tasks without seed_defaults", () => {
    const registry = makeRegistry();
    const deps: BootstrapDeps = { db, config: makeConfig(), registry };
    loadDefaultHeartbeat(deps);

    expect(getTaskByName(db, "heartbeat:health-check")).toBeNull();
    expect(getTaskByName(db, "sentinel:error-triage")).toBeNull();
  });

  test("creates sentinel tasks assigned to analyst (fallback) when seed_defaults is enabled", () => {
    const registry = makeRegistry();
    const deps: BootstrapDeps = { db, config: makeConfig({ scheduler: { seed_defaults: true } }), registry };
    loadDefaultHeartbeat(deps);

    const healthCheck = getTaskByName(db, "heartbeat:health-check");
    const errorTriage = getTaskByName(db, "sentinel:error-triage");
    const costWatchdog = getTaskByName(db, "sentinel:cost-watchdog");
    expect(healthCheck).not.toBeNull();
    expect(errorTriage).not.toBeNull();
    expect(costWatchdog).not.toBeNull();
    expect(healthCheck!.cron_expression).toBe("*/10 * * * *");
    expect(healthCheck!.agent).toBe("analyst"); // falls back to backgroundAgent when no sentinel in config
    expect(healthCheck!.created_by).toBe("system");
  });

  test("creates proposal-related tasks when proposalStore is provided and seed_defaults is enabled", () => {
    const registry = makeRegistry();
    const proposalStore = {} as unknown as ProposalStore;
    const deps: BootstrapDeps = { db, config: makeConfig({ scheduler: { seed_defaults: true } }), registry, proposalStore };
    loadDefaultHeartbeat(deps);

    expect(getTaskByName(db, "dev:execute-approved")).not.toBeNull();
    expect(getTaskByName(db, "proposals:sync-merged")).not.toBeNull();
    expect(getTaskByName(db, "proposals:reset-stale-reviewing")).not.toBeNull();
    expect(getTaskByName(db, "briefing:auto-review")).not.toBeNull();
    expect(getTaskByName(db, "briefing:daily")).not.toBeNull();
  });

  test("creates crawl system tasks when crawl is enabled", () => {
    const deps = makeDeps({
      config: makeConfig({
        scheduler: { seed_defaults: true },
        crawl: { enabled: true, sources: [] },
      }),
      registry: makeRegistry(),
    });

    loadDefaultHeartbeat(deps);

    const crawlRun = getTaskByName(deps.db, "crawl:run-sources");
    const crawlCleanup = getTaskByName(deps.db, "crawl:cleanup-stale");
    expect(crawlRun).not.toBeNull();
    expect(crawlCleanup).not.toBeNull();
    expect(crawlRun!.agent).toBe("system");
    expect(crawlCleanup!.agent).toBe("system");
  });

  test("removes crawl system tasks when crawl is disabled", () => {
    const deps = makeDeps({
      config: makeConfig({
        scheduler: { seed_defaults: true },
        crawl: { enabled: true, sources: [] },
      }),
      registry: makeRegistry(),
    });

    loadDefaultHeartbeat(deps);
    expect(getTaskByName(deps.db, "crawl:run-sources")).not.toBeNull();

    loadDefaultHeartbeat({
      ...deps,
      config: makeConfig({
        scheduler: { seed_defaults: true },
        crawl: { enabled: false, sources: [] },
      }),
    });

    expect(getTaskByName(deps.db, "crawl:run-sources")).toBeNull();
    expect(getTaskByName(deps.db, "crawl:cleanup-stale")).toBeNull();
  });

  test("does not create proposal-related tasks without proposalStore", () => {
    const registry = makeRegistry();
    const deps: BootstrapDeps = { db, config: makeConfig(), registry };
    loadDefaultHeartbeat(deps);

    expect(getTaskByName(db, "dev:execute-approved")).toBeNull();
    expect(getTaskByName(db, "proposals:sync-merged")).toBeNull();
    expect(getTaskByName(db, "proposals:reset-stale-reviewing")).toBeNull();
    expect(getTaskByName(db, "briefing:auto-review")).toBeNull();
    expect(getTaskByName(db, "briefing:daily")).toBeNull();
  });

  test("creates memory and learning tasks with seed_defaults enabled", () => {
    const registry = makeRegistry();
    const deps: BootstrapDeps = { db, config: makeConfig({ scheduler: { seed_defaults: true } }), registry };
    loadDefaultHeartbeat(deps);

    expect(getTaskByName(db, "memory:maintenance")).not.toBeNull();
    expect(getTaskByName(db, "learning:distill-patterns")).not.toBeNull();
    expect(getTaskByName(db, "maintenance:drift-and-sync")).not.toBeNull();
  });

  test("keeps the instance blank without seed_defaults", () => {
    const registry = makeRegistry();
    const proposalStore = {} as unknown as ProposalStore;
    const deps: BootstrapDeps = { db, config: makeConfig(), registry, proposalStore };
    loadDefaultHeartbeat(deps);

    expect(getTaskByName(db, "heartbeat:health-check")).toBeNull();
    expect(getTaskByName(db, "sentinel:error-triage")).toBeNull();
    expect(getTaskByName(db, "dev:execute-approved")).toBeNull();
    expect(getTaskByName(db, "memory:maintenance")).toBeNull();
    expect(getTaskByName(db, "evolution:codebase-review")).toBeNull();
    expect(getTaskByName(db, "crawl:run-sources")).toBeNull();
  });

  test("seed_defaults=false cleans up previously created system tasks", () => {
    const registry = makeRegistry();
    const proposalStore = {} as unknown as ProposalStore;

    // First run with seed_defaults enabled
    const depsOn: BootstrapDeps = { db, config: makeConfig({ scheduler: { seed_defaults: true } }), registry, proposalStore };
    loadDefaultHeartbeat(depsOn);
    expect(getTaskByName(db, "heartbeat:health-check")).not.toBeNull();
    expect(getTaskByName(db, "sentinel:error-triage")).not.toBeNull();
    expect(getTaskByName(db, "dev:execute-approved")).not.toBeNull();

    // Second run with default seeding disabled
    const depsOff: BootstrapDeps = { db, config: makeConfig(), registry, proposalStore };
    loadDefaultHeartbeat(depsOff);
    expect(getTaskByName(db, "heartbeat:health-check")).toBeNull();
    expect(getTaskByName(db, "sentinel:error-triage")).toBeNull();
    expect(getTaskByName(db, "dev:execute-approved")).toBeNull();
  });

  const taskProfileScenarios = [
    {
      profile: "full",
      config: makeConfig({
        scheduler: { task_profile: "full" },
        crawl: { enabled: true, sources: [] },
      }),
      expected: [
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
        "crawl:run-sources",
        "crawl:cleanup-stale",
      ],
    },
    {
      profile: "dev",
      config: makeConfig({ scheduler: { task_profile: "dev" } }),
      expected: [
        "heartbeat:health-check",
        "sentinel:error-triage",
        "sentinel:cost-watchdog",
        "watchdog:stuck-detection",
        "dev:execute-approved",
        "proposals:sync-merged",
        "proposals:reset-stale-reviewing",
        "memory:maintenance",
      ],
    },
    {
      profile: "trading",
      config: makeConfig({ scheduler: { task_profile: "trading" } }),
      expected: [
        "heartbeat:health-check",
        "sentinel:error-triage",
        "sentinel:cost-watchdog",
        "watchdog:stuck-detection",
      ],
    },
    {
      profile: "monitor",
      config: makeConfig({ scheduler: { task_profile: "monitor" } }),
      expected: [
        "heartbeat:health-check",
        "sentinel:error-triage",
        "sentinel:cost-watchdog",
        "watchdog:stuck-detection",
        "routing:cleanup-stale",
      ],
    },
    {
      profile: "none",
      config: makeConfig({ scheduler: { task_profile: "none" } }),
      expected: [],
    },
  ] as const;

  for (const scenario of taskProfileScenarios) {
    test(`task_profile=${scenario.profile} seeds only its tasks and prunes the rest`, () => {
      const registry = makeRegistry();
      const proposalStore = {} as unknown as ProposalStore;

      loadDefaultHeartbeat({
        db,
        config: makeConfig({
          scheduler: { task_profile: "full" },
          crawl: { enabled: true, sources: [] },
        }),
        registry,
        proposalStore,
      });

      loadDefaultHeartbeat({
        db,
        config: scenario.config,
        registry,
        proposalStore,
      });

      expect(getSystemTaskNames(db)).toEqual([...scenario.expected].sort());
    });
  }

  test("dev:execute-approved and proposal system tasks use agent=system", () => {
    const registry = makeRegistry();
    const proposalStore = {} as unknown as ProposalStore;
    const deps: BootstrapDeps = { db, config: makeConfig({ scheduler: { seed_defaults: true } }), registry, proposalStore };
    loadDefaultHeartbeat(deps);

    expect(getTaskByName(db, "dev:execute-approved")!.agent).toBe("system");
    expect(getTaskByName(db, "proposals:sync-merged")!.agent).toBe("system");
    expect(getTaskByName(db, "proposals:reset-stale-reviewing")!.agent).toBe("system");
    expect(getTaskByName(db, "briefing:auto-review")!.agent).toBe("system");
  });

  test("briefing:daily uses analyst agent", () => {
    const registry = makeRegistry();
    const proposalStore = {} as unknown as ProposalStore;
    const deps: BootstrapDeps = { db, config: makeConfig({ scheduler: { seed_defaults: true } }), registry, proposalStore };
    loadDefaultHeartbeat(deps);

    expect(getTaskByName(db, "briefing:daily")!.agent).toBe("analyst");
  });

  test("drift-and-sync uses nyx agent (needs file access)", () => {
    const registry = makeRegistry();
    const deps: BootstrapDeps = { db, config: makeConfig({ scheduler: { seed_defaults: true } }), registry };
    loadDefaultHeartbeat(deps);

    expect(getTaskByName(db, "maintenance:drift-and-sync")!.agent).toBe("nyx");
  });

  test("drift-and-sync prompt uses the configured default project repo path", () => {
    const registry = makeRegistry();
    const repoPath = "/tmp/configured-nyxhive";
    const deps: BootstrapDeps = {
      db,
      config: makeConfig({
        scheduler: { seed_defaults: true },
        daemon: {
          name: "test-instance",
          log_level: "info",
          data_dir: "/tmp/test-nyxhive",
          projects: [
            { name: "docs", repo_path: "/tmp/docs" },
            { name: "NyxHive", repo_path: repoPath, default: true },
          ],
        },
      }),
      registry,
    };
    loadDefaultHeartbeat(deps);

    const prompt = String(getTaskByName(db, "maintenance:drift-and-sync")!.prompt);
    expect(prompt).toContain(`The NyxHive repository is at ${repoPath}`);
    expect(prompt).toContain(`git -C ${repoPath} log --oneline --since="7 days ago"`);
    expect(prompt).not.toContain("/home/user/dev/nyxhive");
  });

  test("drift-and-sync prompt falls back to the current workspace root when no project is configured", () => {
    const registry = makeRegistry();
    const deps: BootstrapDeps = { db, config: makeConfig({ scheduler: { seed_defaults: true } }), registry };
    loadDefaultHeartbeat(deps);

    const prompt = String(getTaskByName(db, "maintenance:drift-and-sync")!.prompt);
    const workspaceRoot = resolve(import.meta.dir, "../..");
    expect(prompt).toContain(`The NyxHive repository is at ${workspaceRoot}`);
    expect(prompt).toContain(`git -C ${workspaceRoot} log --oneline --since="7 days ago"`);
  });

  test("evolution:codebase-review prompt uses lightweight verified self-improvement rules", () => {
    const registry = makeRegistry();
    const deps: BootstrapDeps = { db, config: makeConfig({ scheduler: { seed_defaults: true } }), registry };
    loadDefaultHeartbeat(deps);

    const prompt = String(getTaskByName(db, "evolution:codebase-review")!.prompt);
    expect(prompt).toContain("Run one lightweight self-improvement cycle for NyxHive.");
    expect(prompt).toContain("Decision question: What is the one highest-leverage bounded improvement NyxHive should make this run?");
    expect(prompt).toContain("Artifact-first output:");
    expect(prompt).toContain("Question / Evidence / Decision / Artifacts / Notification");
    expect(prompt).toContain("If code changed, run the relevant focused check, then `bun test` and `bun run typecheck` before claiming completion.");
    expect(prompt).not.toContain("1. **Audit** — Run the test suite (`bun test`).");
  });

  test("upserts heartbeat tasks on re-run without duplicating", () => {
    const registry = makeRegistry();
    const deps: BootstrapDeps = { db, config: makeConfig({ scheduler: { seed_defaults: true } }), registry };
    loadDefaultHeartbeat(deps);
    const countBefore = getAllTasks(db).length;

    // Run again
    loadDefaultHeartbeat(deps);
    const countAfter = getAllTasks(db).length;
    expect(countAfter).toBe(countBefore);
  });

  test("migrates dev:execute-approved from non-system agent to system", () => {
    const registry = makeRegistry();
    const proposalStore = {} as unknown as ProposalStore;

    // Pre-insert with wrong agent (simulates legacy data)
    const now = Date.now();
    db.run(
      `INSERT INTO scheduled_tasks
        (id, name, description, cron_expression, agent, prompt, channel, enabled, next_run_at, created_by, created_at, updated_at)
      VALUES ('dev-1', 'dev:execute-approved', 'old', '0 */4 * * *', 'nyx', 'old prompt', 'api', 1, ${now}, 'system', ${now}, ${now})`,
    );

    const deps: BootstrapDeps = { db, config: makeConfig({ scheduler: { seed_defaults: true } }), registry, proposalStore };
    loadDefaultHeartbeat(deps);

    const task = getTaskByName(db, "dev:execute-approved");
    expect(task!.agent).toBe("system");
  });

  test("migrates briefing:daily from orchestrator to analyst", () => {
    const registry = makeRegistry();
    const proposalStore = {} as unknown as ProposalStore;

    // Pre-insert with old agent
    const now = Date.now();
    db.run(
      `INSERT INTO scheduled_tasks
        (id, name, description, cron_expression, agent, prompt, channel, category, enabled, next_run_at, created_by, created_at, updated_at)
      VALUES ('br-1', 'briefing:daily', 'old', '0 9 * * *', 'orchestrator', 'old prompt', 'api', 'briefing', 1, ${now}, 'system', ${now}, ${now})`,
    );

    const deps: BootstrapDeps = { db, config: makeConfig({ scheduler: { seed_defaults: true } }), registry, proposalStore };
    loadDefaultHeartbeat(deps);

    const task = getTaskByName(db, "briefing:daily");
    expect(task!.agent).toBe("analyst");
  });

  test("removes legacy daily-digest task", () => {
    const registry = makeRegistry();

    // Pre-insert legacy task
    const now = Date.now();
    db.run(
      `INSERT INTO scheduled_tasks
        (id, name, agent, prompt, channel, enabled, next_run_at, created_by, created_at, updated_at)
      VALUES ('legacy-1', 'proposals:daily-digest', 'nyx', 'old', 'api', 1, ${now}, 'system', ${now}, ${now})`,
    );

    const deps: BootstrapDeps = { db, config: makeConfig({ scheduler: { seed_defaults: true } }), registry };
    loadDefaultHeartbeat(deps);

    expect(getTaskByName(db, "proposals:daily-digest")).toBeNull();
  });

  test("migrates tasks from dead agents to analyst", () => {
    const registry = makeRegistry();

    // Pre-insert tasks assigned to dead agents (use created_by = 'config' so cleanup doesn't delete them)
    const now = Date.now();
    for (const dead of ["heartbeat", "scout", "scribe"]) {
      db.run(
        `INSERT INTO scheduled_tasks
          (id, name, agent, prompt, channel, enabled, next_run_at, created_by, created_at, updated_at)
        VALUES ('${dead}-1', '${dead}:task', '${dead}', 'do stuff', 'api', 1, ${now}, 'config', ${now}, ${now})`,
      );
    }

    const deps: BootstrapDeps = { db, config: makeConfig(), registry };
    loadDefaultHeartbeat(deps);

    for (const dead of ["heartbeat", "scout", "scribe"]) {
      const task = getTaskByName(db, `${dead}:task`);
      expect(task!.agent).toBe("analyst");
    }
  });

  test("removes legacy heartbeat agent from registry if it exists", () => {
    const existingHb = {
      provider: "openrouter",
      model: "deepseek/deepseek-v3.2",
    } as unknown as AgentRegistryEntry;
    const registry = makeRegistry({ heartbeat: existingHb });
    const deps: BootstrapDeps = { db, config: makeConfig(), registry };
    loadDefaultHeartbeat(deps);

    expect(registry.disable).toHaveBeenCalledWith("heartbeat");
  });

  test("all system tasks have valid next_run_at set", () => {
    const registry = makeRegistry();
    const proposalStore = {} as unknown as ProposalStore;
    const deps: BootstrapDeps = { db, config: makeConfig({ scheduler: { seed_defaults: true } }), registry, proposalStore };
    loadDefaultHeartbeat(deps);

    const tasks = getAllTasks(db);
    for (const task of tasks) {
      expect(task.next_run_at).toBeGreaterThan(0);
    }
  });

  test("briefing:auto-review has category=briefing", () => {
    const registry = makeRegistry();
    const proposalStore = {} as unknown as ProposalStore;
    const deps: BootstrapDeps = { db, config: makeConfig({ scheduler: { seed_defaults: true } }), registry, proposalStore };
    loadDefaultHeartbeat(deps);

    expect(getTaskByName(db, "briefing:auto-review")!.category).toBe("briefing");
    expect(getTaskByName(db, "briefing:daily")!.category).toBe("briefing");
  });

  test("uses sentinel agent when configured in config.agents", () => {
    const entries = new Map<string, AgentRegistryEntry>();
    entries.set("nyx", {
      name: "Nyx",
      role: "lead",
      enabled: true,
    } as unknown as AgentRegistryEntry);
    entries.set("sentinel", {
      name: "Sentinel",
      role: "worker",
      enabled: true,
    } as unknown as AgentRegistryEntry);
    const registry = makeRegistry({ entries });
    const config = makeConfig({
      scheduler: { seed_defaults: true },
      agents: { sentinel: { name: "Sentinel", role: "worker", provider: "ollama", model: "llama3.2:3b" } } as any,
    });
    const deps: BootstrapDeps = { db, config, registry };
    loadDefaultHeartbeat(deps);

    const healthCheck = getTaskByName(db, "heartbeat:health-check");
    expect(healthCheck!.agent).toBe("sentinel");
  });

  test("falls back to background agent when sentinel is configured but not registered", () => {
    const registry = makeRegistry();
    const config = makeConfig({
      scheduler: { seed_defaults: true },
      agents: { sentinel: { name: "Sentinel", role: "worker", provider: "ollama", model: "llama3.2:3b" } } as any,
    });
    const deps: BootstrapDeps = { db, config, registry };
    loadDefaultHeartbeat(deps);

    const healthCheck = getTaskByName(db, "heartbeat:health-check");
    expect(healthCheck!.agent).toBe("analyst");
  });
});

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { loadConfig } from "../config.js";
import { resolveInstance, loadInstanceEnv } from "./resolve.js";
import { logger } from "../utils/logger.js";
import { Database } from "bun:sqlite";
import { describeServerContract } from "../server/urls.js";
import { isPidRunning, type SignalProcess } from "./pid-status.js";
import { describeError } from "./status-format.js";

function parseArgs() {
  const args = process.argv.slice(3);
  let configPath: string | undefined;
  let instanceName: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--config" && i + 1 < args.length) configPath = args[++i];
    else if (!args[i].startsWith("--")) instanceName = args[i];
  }
  return { configPath, instanceName };
}

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

const RUNTIME_DATABASES = ["nyxai.db", "memory.db"] as const;

type HealthFetchResult = {
  ok: boolean;
  status: number;
  healthStatus?: string;
};

type HealthFetch = (port: number) => Promise<HealthFetchResult>;

async function defaultFetchHealth(port: number) {
  const res = await fetch(`http://localhost:${port}/health`, {
    signal: AbortSignal.timeout(1000),
  });
  let healthStatus: string | undefined;
  let healthOk: boolean | undefined;
  try {
    const data = await res.json() as { ok?: unknown; status?: unknown };
    if (typeof data.status === "string" && data.status.trim().length > 0) {
      healthStatus = data.status.trim();
    }
    if (typeof data.ok === "boolean") {
      healthOk = data.ok;
    }
  } catch {
    // Older or failing endpoints may not return JSON; fall back to HTTP status.
  }

  return {
    ok: res.ok && healthOk !== false && !["degraded", "fail", "failed", "error"].includes(healthStatus ?? ""),
    status: res.status,
    healthStatus,
  };
}

export function buildDatabaseChecks(dataDir: string): Check[] {
  const checks: Check[] = [];
  for (const dbName of RUNTIME_DATABASES) {
    const dbPath = resolve(dataDir, dbName);
    if (existsSync(dbPath)) {
      try {
        const db = new Database(dbPath, { readonly: true });
        db.close();
        checks.push({ name: dbName, ok: true, detail: "accessible" });
      } catch {
        checks.push({ name: dbName, ok: false, detail: "cannot open" });
      }
    } else {
      checks.push({ name: dbName, ok: true, detail: "not yet created (will be on first start)" });
    }
  }
  return checks;
}

export async function buildPortCheck(
  port: number,
  options: {
    pidFile?: string;
    fetchHealth?: HealthFetch;
    signalProcess?: SignalProcess;
  } = {},
): Promise<Check> {
  const fetchHealth = options.fetchHealth ?? defaultFetchHealth;
  try {
    const res = await fetchHealth(port);
    const health = res.healthStatus ?? res.status;
    const detail = res.ok ? `${port} (instance running)` : `${port} (instance running, health ${health})`;
    return { name: "Port", ok: res.ok, detail };
  } catch (error) {
    const pidFile = options.pidFile;
    if (pidFile && existsSync(pidFile)) {
      const pid = Number.parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
      if (Number.isFinite(pid) && isPidRunning(pid, options.signalProcess)) {
        return {
          name: "Port",
          ok: false,
          detail: `${port} unreachable with live PID ${pid}: ${describeError(error) ?? String(error)}`,
        };
      }
    }
    return { name: "Port", ok: true, detail: `${port} (available)` };
  }
}

export async function runHealth() {
  const { configPath, instanceName } = parseArgs();
  const { configPath: resolved, instanceDir } = resolveInstance(instanceName, undefined, configPath);
  loadInstanceEnv(instanceDir);

  const checks: Check[] = [];

  // 1. Config loads
  try {
    const config = loadConfig(resolved);
    const serverContract = describeServerContract(config);
    checks.push({ name: "Config", ok: true, detail: `${Object.keys(config.agents).length} agents configured` });
    checks.push({
      name: "Server contract",
      ok: serverContract.remote_contract_ready,
      detail: serverContract.warnings[0] ?? (serverContract.base_url ? `advertising ${serverContract.base_url}` : "no server URL available"),
    });

    // 2. Data directory
    const dataDir = resolve(config.daemon.data_dir);
    const dataExists = existsSync(dataDir);
    checks.push({ name: "Data dir", ok: dataExists, detail: dataExists ? dataDir : `Missing: ${dataDir}` });

    // 3. SQLite databases
    if (dataExists) {
      checks.push(...buildDatabaseChecks(dataDir));
    }

    // 4. API keys
    for (const [key, agent] of Object.entries(config.agents)) {
      const provider = agent.provider;
      const envVar = provider === "anthropic" ? "ANTHROPIC_API_KEY"
        : provider === "openrouter" ? "OPENROUTER_API_KEY"
        : provider === "minimax" ? "MINIMAX_API_KEY"
        : null;
      if (envVar) {
        const hasKey = !!process.env[envVar];
        checks.push({
          name: `API key (${key})`,
          ok: hasKey,
          detail: hasKey ? "set" : `Missing: export ${envVar}=...`,
        });
      }
    }

    // 5. Port check
    checks.push(await buildPortCheck(config.server.port, { pidFile: resolve(dataDir, "nyxhive.pid") }));
  } catch (err) {
    checks.push({ name: "Config", ok: false, detail: `${err}` });
  }

  // Print results
  const allOk = checks.every(c => c.ok);
  logger.info("");
  for (const check of checks) {
    const icon = check.ok ? " OK " : "FAIL";
    logger.info(`  [${icon}] ${check.name}: ${check.detail}`);
  }
  logger.info("");
  logger.info(allOk ? "  Instance is healthy." : "  Instance has issues — fix the FAIL items above.");
  logger.info("");
  process.exit(allOk ? 0 : 1);
}

if (import.meta.main) {
  runHealth().catch((err) => {
    logger.error(`Error: ${err}`);
    process.exit(1);
  });
}

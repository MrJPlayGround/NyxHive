import { defineCommand } from "citty";
import pc from "picocolors";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { $ } from "bun";
import { loadConfig } from "../../config.js";
import { DEFAULT_COST_RATES, getContextWindow, getModelTier } from "../../defaults.js";
import { TraceStore, type ModelQualityLedgerRow } from "../../memory/traces.js";
import { runRuntimeSelfAudit, type RuntimeSelfAuditReport } from "../../runtime/self-audit.js";
import { cost, duration, table } from "../lib/format.js";

type QueueSnapshot = { pending: number; processing: number; deadLetters: number; staleRunning: number };
type GitSnapshot = { clean: boolean; branch: string; ahead: number };

export function parseSinceMs(value: string | undefined, now = Date.now()): number {
  const raw = value?.trim() || "7d";
  const match = raw.match(/^(\d+)([hdw])$/);
  if (!match) return now - 7 * 86_400_000;
  const amount = Number(match[1]);
  const unit = match[2];
  const multiplier = unit === "h" ? 3_600_000 : unit === "w" ? 7 * 86_400_000 : 86_400_000;
  return now - amount * multiplier;
}

export function formatRuntimeAudit(report: RuntimeSelfAuditReport): string {
  const severity = report.status ?? (report.ok ? "pass" : "fail");
  const status = severity === "pass" ? pc.green("pass") : severity === "warn" ? pc.yellow("warn") : pc.red("fail");
  const rows = report.checks.map((check) => [
    check.severity === "pass" ? pc.green("pass") : check.severity === "warn" ? pc.yellow("warn") : pc.red("fail"),
    check.label,
    check.detail,
  ]);
  return [`runtime audit: ${status}`, table([
    { label: "State", width: 8 },
    { label: "Check", width: 18 },
    { label: "Detail", width: 64 },
  ], rows)].join("\n");
}

export function formatModelLedger(rows: ModelQualityLedgerRow[]): string {
  if (rows.length === 0) return "no model runs found";
  return table([
    { label: "Model", width: 22 },
    { label: "Task", width: 14 },
    { label: "Runs", width: 6 },
    { label: "Pass", width: 6 },
    { label: "Fail", width: 6 },
    { label: "Empty", width: 7 },
    { label: "Cost", width: 8 },
    { label: "Avg", width: 8 },
  ], rows.map((row) => [
    row.model,
    row.taskType ?? "unknown",
    String(row.runs),
    String(row.completed),
    String(row.failed),
    String(row.emptyRuns),
    cost(row.cost),
    duration(Math.round(row.avgDurationMs)),
  ]));
}

function readQueueSnapshot(dbPath: string): QueueSnapshot {
  if (!existsSync(dbPath)) return { pending: 0, processing: 0, deadLetters: 0, staleRunning: 0 };
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db.query("SELECT status, COUNT(*) AS count FROM messages GROUP BY status").all() as Array<{ status: string; count: number }>;
    const count = (status: string) => rows.find((row) => row.status === status)?.count ?? 0;
    const staleCutoff = Date.now() - 30 * 60_000;
    const stale = db.query("SELECT COUNT(*) AS count FROM messages WHERE status = 'processing' AND updated_at < ?").get(staleCutoff) as { count: number } | null;
    return {
      pending: count("pending"),
      processing: count("processing"),
      deadLetters: count("dead_letter"),
      staleRunning: stale?.count ?? 0,
    };
  } finally {
    db.close();
  }
}

async function readGitSnapshot(cwd = process.cwd()): Promise<GitSnapshot> {
  try {
    const output = await $`git status --short --branch`.cwd(cwd).quiet().text();
    const lines = output.trim().split("\n").filter(Boolean);
    const header = lines[0] ?? "";
    const branch = header.match(/^## ([^.\s]+)/)?.[1] ?? "unknown";
    const ahead = Number(header.match(/\[ahead (\d+)/)?.[1] ?? 0);
    return { branch, ahead, clean: lines.length <= 1 };
  } catch {
    return { branch: "unknown", ahead: 0, clean: false };
  }
}

function dataDirectory(configPath: string | undefined, dataDir: string): string {
  return resolve(configPath ? join(configPath, "..") : process.cwd(), dataDir);
}

function queueDbPath(configPath: string | undefined, dataDir: string, name: string): string {
  return join(dataDirectory(configPath, dataDir), `${name.toLowerCase()}.db`);
}

function memoryDbPath(configPath: string | undefined, dataDir: string): string {
  return join(dataDirectory(configPath, dataDir), "memory.db");
}

const runtime = defineCommand({
  meta: { name: "runtime", description: "Audit live runtime trust posture" },
  args: {
    config: { type: "string", description: "NyxHive config path" },
    json: { type: "boolean", description: "Print JSON" },
  },
  async run({ args }) {
    const config = loadConfig(args.config as string | undefined);
    const name = config.daemon.name ?? "nyxhive";
    const dbPath = queueDbPath(args.config as string | undefined, config.daemon.data_dir, name);
    const primaryAgent = config.daemon.primary_agent;
    const nyx = (primaryAgent ? config.agents[primaryAgent] : undefined) ?? config.agents.nyx ?? config.agents.Nyx ?? Object.values(config.agents)[0];
    const model = nyx?.model ?? "";
    const report = runRuntimeSelfAudit({
      agents: config.agents,
      queue: readQueueSnapshot(dbPath),
      git: await readGitSnapshot(),
      modelMetadata: {
        hasCostRate: Boolean(DEFAULT_COST_RATES[model]),
        hasContextWindow: getContextWindow(model) > 0,
        tier: getModelTier(model),
      },
    });
    console.log(args.json ? JSON.stringify(report, null, 2) : formatRuntimeAudit(report));
    if (!report.ok) process.exitCode = 1;
  },
});

const models = defineCommand({
  meta: { name: "models", description: "Show model quality/cost ledger" },
  args: {
    config: { type: "string", description: "NyxHive config path" },
    since: { type: "string", description: "Window such as 24h, 7d, 4w", default: "7d" },
    json: { type: "boolean", description: "Print JSON" },
  },
  run({ args }) {
    const config = loadConfig(args.config as string | undefined);
    const dbPath = memoryDbPath(args.config as string | undefined, config.daemon.data_dir);
    const rows = existsSync(dbPath)
      ? (() => {
          const db = new Database(dbPath, { readonly: true });
          try {
            return new TraceStore(db).getModelQualityLedger({ sinceMs: parseSinceMs(args.since as string | undefined) });
          } finally {
            db.close();
          }
        })()
      : [];
    console.log(args.json ? JSON.stringify(rows, null, 2) : formatModelLedger(rows));
  },
});

export default defineCommand({
  meta: { name: "audit", description: "Audit runtime posture and model evidence" },
  subCommands: { runtime, models },
});

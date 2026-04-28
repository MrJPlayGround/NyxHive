import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AuditLog } from "../utils/audit.js";

export type RestartProvenanceAction = "schedule" | "execute";

export interface RestartProvenanceRecord {
  id: string;
  timestamp: number;
  action: RestartProvenanceAction;
  instance: string;
  source: string;
  reason: string | null;
  run_id: string | null;
  trace_id: string | null;
  caller_pid: number | null;
  parent_pid: number | null;
  cwd: string | null;
  argv: string[];
  log_file?: string | null;
  session_name?: string | null;
}

export interface RestartProvenanceInput {
  id?: string;
  action: RestartProvenanceAction;
  instance: string;
  source: string;
  reason?: string | null;
  runId?: string | null;
  traceId?: string | null;
  callerPid?: number | null;
  parentPid?: number | null;
  cwd?: string | null;
  argv?: string[];
  logFile?: string | null;
  sessionName?: string | null;
}

const PROVENANCE_FILE = "restart-provenance.jsonl";
const INGESTED_FILE = "restart-provenance.ingested.json";

function defaultRunDir(): string {
  return join(process.env.NYXHIVE_RUN_DIR || join(homedir(), ".nyxhive", "run"));
}

function provenancePath(runDir: string): string {
  return join(runDir, PROVENANCE_FILE);
}

function ingestedPath(runDir: string): string {
  return join(runDir, INGESTED_FILE);
}

function normalizeString(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function normalizePid(value: number | null | undefined): number | null {
  return Number.isFinite(value) && value && value > 0 ? Math.trunc(value) : null;
}

export function writeRestartProvenance(
  runDir: string = defaultRunDir(),
  input: RestartProvenanceInput,
): RestartProvenanceRecord {
  mkdirSync(runDir, { recursive: true });
  const record: RestartProvenanceRecord = {
    id: normalizeString(input.id) ?? `restart-${Date.now()}-${process.pid}`,
    timestamp: Date.now(),
    action: input.action,
    instance: input.instance,
    source: input.source,
    reason: normalizeString(input.reason),
    run_id: normalizeString(input.runId),
    trace_id: normalizeString(input.traceId),
    caller_pid: normalizePid(input.callerPid),
    parent_pid: normalizePid(input.parentPid),
    cwd: normalizeString(input.cwd),
    argv: input.argv ?? [],
    ...(input.logFile !== undefined ? { log_file: normalizeString(input.logFile) } : {}),
    ...(input.sessionName !== undefined ? { session_name: normalizeString(input.sessionName) } : {}),
  };

  appendFileSync(provenancePath(runDir), `${JSON.stringify(record)}\n`, "utf8");
  return record;
}

function readJsonSet(path: string): Set<string> {
  if (!existsSync(path)) return new Set();
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (Array.isArray(parsed)) {
      return new Set(parsed.filter((item): item is string => typeof item === "string"));
    }
  } catch {
    // Corrupt markers should not block audit ingestion.
  }
  return new Set();
}

function readRestartRecords(runDir: string): RestartProvenanceRecord[] {
  const path = provenancePath(runDir);
  if (!existsSync(path)) return [];

  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as Partial<RestartProvenanceRecord>;
        if (
          typeof parsed.id === "string"
          && typeof parsed.timestamp === "number"
          && (parsed.action === "schedule" || parsed.action === "execute")
          && typeof parsed.instance === "string"
          && typeof parsed.source === "string"
        ) {
          return [{
            id: parsed.id,
            timestamp: parsed.timestamp,
            action: parsed.action,
            instance: parsed.instance,
            source: parsed.source,
            reason: typeof parsed.reason === "string" ? parsed.reason : null,
            run_id: typeof parsed.run_id === "string" ? parsed.run_id : null,
            trace_id: typeof parsed.trace_id === "string" ? parsed.trace_id : null,
            caller_pid: typeof parsed.caller_pid === "number" ? parsed.caller_pid : null,
            parent_pid: typeof parsed.parent_pid === "number" ? parsed.parent_pid : null,
            cwd: typeof parsed.cwd === "string" ? parsed.cwd : null,
            argv: Array.isArray(parsed.argv) ? parsed.argv.filter((item): item is string => typeof item === "string") : [],
            log_file: typeof parsed.log_file === "string" ? parsed.log_file : null,
            session_name: typeof parsed.session_name === "string" ? parsed.session_name : null,
          }];
        }
      } catch {
        // Ignore malformed lines; the helper must never make startup fragile.
      }
      return [];
    });
}

export function ingestRestartProvenance(
  runDir: string = defaultRunDir(),
  audit: AuditLog,
): { ingested: number; skipped: number } {
  mkdirSync(runDir, { recursive: true });
  const markerPath = ingestedPath(runDir);
  const ingestedIds = readJsonSet(markerPath);
  let ingested = 0;
  let skipped = 0;

  for (const record of readRestartRecords(runDir)) {
    if (ingestedIds.has(record.id)) {
      skipped += 1;
      continue;
    }
    audit.log({
      event: "runtime.restart_requested",
      channel: "restart",
      sender_id: record.source,
      agent: record.instance,
      detail: JSON.stringify(record),
    });
    ingestedIds.add(record.id);
    ingested += 1;
  }

  writeFileSync(markerPath, `${JSON.stringify([...ingestedIds], null, 2)}\n`, "utf8");
  return { ingested, skipped };
}

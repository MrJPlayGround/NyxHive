/**
 * Disk-backed local run store.
 * Each run lives at ~/.nyxhive/local-runs/<runId>/
 *   meta.json  — RunRecord metadata
 *   output     — raw streamed text (appended as output arrives)
 */
import { readFile, writeFile, mkdir, appendFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

// ─── Types ────────────────────────────────────────────────────────────────────

export type RunType =
  | "remote-agent"   // streamed task to a NyxHive instance
  | "local-bash"     // local shell command
  | "local-agent"    // local agent via Claude Code SDK
  | "background"     // async-enqueued, output polled/fetched later
  | "dream";         // detached autonomous agent run

export type RunStatus = "pending" | "running" | "completed" | "failed";

export interface LocalRun {
  run_id: string;
  type: RunType;
  status: RunStatus;
  title: string;
  instance?: string;
  agent?: string;
  message_id?: string;   // server-side message ID (remote-agent / background)
  started_at: number;
  finished_at?: number;
  exit_code?: number;
  error?: string;
}

// ─── Paths ────────────────────────────────────────────────────────────────────

function runsRoot(): string {
  return join(homedir(), ".nyxhive", "local-runs");
}

function runDir(runId: string): string {
  return join(runsRoot(), runId);
}

function metaPath(runId: string): string {
  return join(runDir(runId), "meta.json");
}

function outputPath(runId: string): string {
  return join(runDir(runId), "output");
}

// ─── API ──────────────────────────────────────────────────────────────────────

/**
 * Create a new run record and return its ID.
 */
export async function createRun(
  type: RunType,
  fields: Omit<LocalRun, "run_id" | "started_at">,
): Promise<LocalRun> {
  const run: LocalRun = {
    run_id: randomUUID(),
    started_at: Date.now(),
    ...fields,
  };
  await mkdir(runDir(run.run_id), { recursive: true });
  await writeFile(metaPath(run.run_id), JSON.stringify(run, null, 2));
  return run;
}

/**
 * Load a run record by ID.
 */
export async function loadRun(runId: string): Promise<LocalRun | null> {
  try {
    const raw = await readFile(metaPath(runId), "utf-8");
    return JSON.parse(raw) as LocalRun;
  } catch {
    return null;
  }
}

/**
 * Persist updates to a run record.
 */
export async function updateRun(
  runId: string,
  update: Partial<LocalRun>,
): Promise<void> {
  const existing = await loadRun(runId);
  if (!existing) return;
  const merged = { ...existing, ...update };
  await writeFile(metaPath(runId), JSON.stringify(merged, null, 2));
}

/**
 * Append text to a run's output file.
 */
export async function appendOutput(runId: string, chunk: string): Promise<void> {
  await appendFile(outputPath(runId), chunk);
}

/**
 * Read the full output for a run.
 */
export async function readOutput(runId: string): Promise<string> {
  try {
    return await readFile(outputPath(runId), "utf-8");
  } catch {
    return "";
  }
}

/**
 * List all local runs sorted by started_at descending.
 */
export async function listLocalRuns(limit = 20): Promise<LocalRun[]> {
  const root = runsRoot();
  try {
    const entries = await readdir(root);
    const runs: LocalRun[] = [];
    for (const entry of entries) {
      const run = await loadRun(entry);
      if (run) runs.push(run);
    }
    return runs
      .sort((a, b) => b.started_at - a.started_at)
      .slice(0, limit);
  } catch {
    return [];
  }
}

/**
 * Get the size of a run's output file in bytes.
 */
export async function outputSize(runId: string): Promise<number> {
  try {
    const s = await stat(outputPath(runId));
    return s.size;
  } catch {
    return 0;
  }
}

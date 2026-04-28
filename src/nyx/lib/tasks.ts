/**
 * Read/write the Nyx local task store, with fallback for legacy Onyx paths.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

export function resolveTaskStorePaths(home = homedir()): { primary: string; legacy: string } {
  return {
    primary: join(home, ".nyxhive", "tasks", "active.json"),
    legacy: join(home, "dev", "onyx", "tasks", "active.json"),
  };
}

export function pickTaskStorePath(primaryExists: boolean, legacyExists: boolean): "primary" | "legacy" {
  return primaryExists ? "primary" : (legacyExists ? "legacy" : "primary");
}

function currentTaskStorePath(): string {
  const paths = resolveTaskStorePaths();
  const choice = pickTaskStorePath(existsSync(paths.primary), existsSync(paths.legacy));
  return paths[choice];
}

export interface TaskDelegation {
  instance: string;
  message_id: string;
  run_id: string | null;
  agent: string;
  status: string;
  dispatched_at: number;
  completed_at: number | null;
  result_summary: string;
}

export interface Task {
  task_id: string;
  title: string;
  description: string;
  status: string;
  priority: string;
  delegations: TaskDelegation[];
  research_summary?: string;
  blockers: string[];
  created_at?: number;
  updated_at?: number;
  created_by?: string;
  tags: string[];
}

export interface TasksFile {
  tasks: Task[];
  last_updated: number;
  archive: Task[];
}

export async function loadTasks(): Promise<TasksFile> {
  const raw = await readFile(currentTaskStorePath(), "utf-8");
  return JSON.parse(raw) as TasksFile;
}

export async function saveTasks(data: TasksFile): Promise<void> {
  data.last_updated = Date.now();
  const { primary } = resolveTaskStorePaths();
  await mkdir(dirname(primary), { recursive: true });
  await writeFile(primary, JSON.stringify(data, null, 2) + "\n");
}

export function updateDelegation(
  data: TasksFile,
  taskId: string,
  messageId: string,
  update: Partial<TaskDelegation>,
): boolean {
  const task = data.tasks.find((t) => t.task_id === taskId);
  if (!task) return false;
  const deleg = task.delegations.find((d) => d.message_id === messageId);
  if (!deleg) return false;
  Object.assign(deleg, update);
  return true;
}

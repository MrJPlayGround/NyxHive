import { Database } from "bun:sqlite";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { logger } from "../utils/logger.js";
import { ensureTableSchema } from "../utils/schema.js";

export type TaskStatus = "backlog" | "in_progress" | "review" | "done";

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  assignee: string;
  assignee_type: string;
  position: number;
  created_at: number;
  updated_at: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'backlog',
    assignee TEXT NOT NULL DEFAULT '',
    assignee_type TEXT NOT NULL DEFAULT '',
    position INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status, position);
`;

export class TaskStore {
  private db: Database;

  constructor(dataDir: string, instanceName?: string) {
    const dbPath = join(dataDir, `${instanceName ?? "nyxhive"}.db`);
    this.db = new Database(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    const walCheck = this.db.query("PRAGMA journal_mode").get() as { journal_mode: string } | null;
    if (walCheck?.journal_mode !== "wal") {
      logger.warn(`[tasks] WAL mode not active (journal_mode=${walCheck?.journal_mode}), performance may be degraded`);
    }
    this.db.exec("PRAGMA busy_timeout = 5000");

    ensureTableSchema(this.db, {
      table: "tasks",
      required: ["id", "title", "description", "status", "assignee", "assignee_type", "position", "created_at", "updated_at"],
      ephemeral: true,
    }, "tasks");

    this.db.exec(SCHEMA);
    logger.info("[tasks] Task store ready");
  }

  list(): Task[] {
    return this.db
      .query("SELECT * FROM tasks ORDER BY status, position ASC, created_at DESC")
      .all() as Task[];
  }

  get(id: string): Task | null {
    return this.db
      .query("SELECT * FROM tasks WHERE id = ?")
      .get(id) as Task | null;
  }

  create(opts: {
    title: string;
    description?: string;
    status?: TaskStatus;
    assignee?: string;
    assigneeType?: string;
  }): Task {
    const id = randomUUID();
    const now = Date.now();

    // Get max position for the target status
    const maxPos = this.db
      .query("SELECT COALESCE(MAX(position), -1) as max_pos FROM tasks WHERE status = ?")
      .get(opts.status ?? "backlog") as { max_pos: number };

    const task: Task = {
      id,
      title: opts.title,
      description: opts.description ?? "",
      status: opts.status ?? "backlog",
      assignee: opts.assignee ?? "",
      assignee_type: opts.assigneeType ?? "",
      position: maxPos.max_pos + 1,
      created_at: now,
      updated_at: now,
    };

    this.db.run(
      `INSERT INTO tasks (id, title, description, status, assignee, assignee_type, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [task.id, task.title, task.description, task.status, task.assignee, task.assignee_type, task.position, task.created_at, task.updated_at],
    );

    return task;
  }

  update(id: string, updates: Partial<Pick<Task, "title" | "description" | "status" | "assignee" | "assignee_type" | "position">>): Task | null {
    const existing = this.get(id);
    if (!existing) return null;

    const now = Date.now();
    const fields: string[] = [];
    const values: (string | number | null)[] = [];

    if (updates.title !== undefined) { fields.push("title = ?"); values.push(updates.title); }
    if (updates.description !== undefined) { fields.push("description = ?"); values.push(updates.description); }
    if (updates.status !== undefined) { fields.push("status = ?"); values.push(updates.status); }
    if (updates.assignee !== undefined) { fields.push("assignee = ?"); values.push(updates.assignee); }
    if (updates.assignee_type !== undefined) { fields.push("assignee_type = ?"); values.push(updates.assignee_type); }
    if (updates.position !== undefined) { fields.push("position = ?"); values.push(updates.position); }

    if (fields.length === 0) return existing;

    fields.push("updated_at = ?");
    values.push(now);
    values.push(id);

    this.db.run(`UPDATE tasks SET ${fields.join(", ")} WHERE id = ?`, values);
    return this.get(id);
  }

  delete(id: string): boolean {
    const result = this.db.run("DELETE FROM tasks WHERE id = ?", [id]);
    return result.changes > 0;
  }

  reorder(columns: Record<string, string[]>): void {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const [status, taskIds] of Object.entries(columns)) {
        for (let i = 0; i < taskIds.length; i++) {
          this.db.run(
            "UPDATE tasks SET status = ?, position = ?, updated_at = ? WHERE id = ?",
            [status, i, Date.now(), taskIds[i]],
          );
        }
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  close(): void {
    this.db.close();
  }
}

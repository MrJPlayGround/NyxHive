import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";

function safeJsonParse<T>(val: string | null | undefined, fallback: T): T {
  if (!val) return fallback;
  try {
    return JSON.parse(val) as T;
  } catch {
    return fallback;
  }
}

export type PlanStatus = "planning" | "running" | "paused" | "completed" | "failed";
export type StoryStatus = "pending" | "running" | "passed" | "failed" | "skipped";

export interface DevPlan {
  id: string;
  feature: string;
  branch: string;
  agent: string;
  status: PlanStatus;
  checks: string[];        // quality gate commands, e.g. ["bun run typecheck", "bun test"]
  created_by: string;
  created_at: number;
  updated_at: number;
}

export interface DevStory {
  id: string;
  plan_id: string;
  sequence: number;
  title: string;
  acceptance_criteria: string[];
  status: StoryStatus;
  attempts: number;
  max_retries: number;
  last_error: string | null;
  learnings: string | null;
  commit_hash: string | null;
  tokens_used: number;
  duration_ms: number;
  created_at: number;
  updated_at: number;
}

const MAX_STORIES_PER_PLAN = 20;
const DEFAULT_MAX_RETRIES = 3;

export class DevPlanStore {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
    this.init();
  }

  private init(): void {
    this.db.run(`
      CREATE TABLE IF NOT EXISTS dev_plans (
        id TEXT PRIMARY KEY,
        feature TEXT NOT NULL,
        branch TEXT NOT NULL,
        agent TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'planning',
        checks TEXT NOT NULL DEFAULT '[]',
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS dev_stories (
        id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL REFERENCES dev_plans(id),
        sequence INTEGER NOT NULL,
        title TEXT NOT NULL,
        acceptance_criteria TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER DEFAULT 0,
        max_retries INTEGER DEFAULT ${DEFAULT_MAX_RETRIES},
        last_error TEXT,
        learnings TEXT,
        commit_hash TEXT,
        tokens_used INTEGER DEFAULT 0,
        duration_ms INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
  }

  createPlan(opts: {
    feature: string;
    branch: string;
    agent: string;
    createdBy: string;
    checks?: string[];
  }): DevPlan {
    const id = `plan-${randomUUID().slice(0, 8)}`;
    const now = Date.now();
    const checks = opts.checks ?? ["bun run typecheck", "bun test"];

    this.db.run(
      `INSERT INTO dev_plans (id, feature, branch, agent, status, checks, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'planning', ?, ?, ?, ?)`,
      [id, opts.feature, opts.branch, opts.agent, JSON.stringify(checks), opts.createdBy, now, now],
    );

    return {
      id, feature: opts.feature, branch: opts.branch, agent: opts.agent,
      status: "planning", checks, created_by: opts.createdBy, created_at: now, updated_at: now,
    };
  }

  getPlan(id: string): DevPlan | undefined {
    const row = this.db.query("SELECT * FROM dev_plans WHERE id = ?").get(id) as any;
    if (!row) return undefined;
    return { ...row, checks: safeJsonParse<string[]>(row.checks, []) };
  }

  listPlans(status?: PlanStatus): DevPlan[] {
    const query = status
      ? "SELECT * FROM dev_plans WHERE status = ? ORDER BY created_at DESC"
      : "SELECT * FROM dev_plans ORDER BY created_at DESC";
    const rows = (status ? this.db.query(query).all(status) : this.db.query(query).all()) as any[];
    return rows.map(r => ({ ...r, checks: safeJsonParse<string[]>(r.checks, []) }));
  }

  updatePlanStatus(id: string, status: PlanStatus): void {
    this.db.run(
      "UPDATE dev_plans SET status = ?, updated_at = ? WHERE id = ?",
      [status, Date.now(), id],
    );
  }

  deletePlan(id: string): void {
    this.db.run("DELETE FROM dev_stories WHERE plan_id = ?", [id]);
    this.db.run("DELETE FROM dev_plans WHERE id = ?", [id]);
  }

  addStory(planId: string, title: string, acceptanceCriteria: string[] = []): DevStory {
    // Check story count
    const count = this.db.query("SELECT COUNT(*) as c FROM dev_stories WHERE plan_id = ?").get(planId) as any;
    if (count?.c >= MAX_STORIES_PER_PLAN) {
      throw new Error(`Max ${MAX_STORIES_PER_PLAN} stories per plan`);
    }

    // Get next sequence
    const maxSeq = this.db.query(
      "SELECT COALESCE(MAX(sequence), 0) as m FROM dev_stories WHERE plan_id = ?",
    ).get(planId) as any;
    const sequence = (maxSeq?.m ?? 0) + 1;

    const id = `story-${randomUUID().slice(0, 8)}`;
    const now = Date.now();

    this.db.run(
      `INSERT INTO dev_stories (id, plan_id, sequence, title, acceptance_criteria, status, attempts, max_retries, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
      [id, planId, sequence, title, JSON.stringify(acceptanceCriteria), DEFAULT_MAX_RETRIES, now, now],
    );

    return {
      id, plan_id: planId, sequence, title, acceptance_criteria: acceptanceCriteria,
      status: "pending", attempts: 0, max_retries: DEFAULT_MAX_RETRIES,
      last_error: null, learnings: null, commit_hash: null,
      tokens_used: 0, duration_ms: 0, created_at: now, updated_at: now,
    };
  }

  addStories(planId: string, stories: Array<{ title: string; acceptance_criteria?: string[] }>): DevStory[] {
    return stories.map(s => this.addStory(planId, s.title, s.acceptance_criteria));
  }

  getStories(planId: string): DevStory[] {
    const rows = this.db.query(
      "SELECT * FROM dev_stories WHERE plan_id = ? ORDER BY sequence ASC",
    ).all(planId) as any[];
    return rows.map(r => ({
      ...r,
      acceptance_criteria: safeJsonParse<string[]>(r.acceptance_criteria, []),
    }));
  }

  getNextPendingStory(planId: string): DevStory | undefined {
    const row = this.db.query(
      "SELECT * FROM dev_stories WHERE plan_id = ? AND status = 'pending' ORDER BY sequence ASC LIMIT 1",
    ).get(planId) as any;
    if (!row) return undefined;
    return { ...row, acceptance_criteria: safeJsonParse<string[]>(row.acceptance_criteria, []) };
  }

  updateStory(id: string, updates: Partial<Pick<DevStory, "status" | "attempts" | "last_error" | "learnings" | "commit_hash" | "tokens_used" | "duration_ms">>): void {
    const sets: string[] = ["updated_at = ?"];
    const vals: (string | number | null)[] = [Date.now()];

    for (const [key, val] of Object.entries(updates)) {
      if (val !== undefined) {
        sets.push(`${key} = ?`);
        vals.push(val);
      }
    }
    vals.push(id);
    this.db.run(`UPDATE dev_stories SET ${sets.join(", ")} WHERE id = ?`, vals);
  }

  skipStory(id: string): void {
    this.updateStory(id, { status: "skipped" });
  }

  getPlanProgress(planId: string): { total: number; passed: number; failed: number; skipped: number; pending: number; running: number } {
    const stories = this.getStories(planId);
    return {
      total: stories.length,
      passed: stories.filter(s => s.status === "passed").length,
      failed: stories.filter(s => s.status === "failed").length,
      skipped: stories.filter(s => s.status === "skipped").length,
      pending: stories.filter(s => s.status === "pending").length,
      running: stories.filter(s => s.status === "running").length,
    };
  }
}

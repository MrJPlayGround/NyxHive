import type { Database } from "bun:sqlite";

export type ProceduralSkillDraftStatus = "draft" | "published" | "rejected";

export interface ProceduralSkillDraft {
  id: number;
  source_hash: string;
  agent_key: string;
  conversation_id: string | null;
  trace_id: string | null;
  title: string;
  summary: string;
  draft_markdown: string;
  status: ProceduralSkillDraftStatus;
  published_skill_name: string | null;
  published_skill_path?: string | null;
  rejected_reason: string | null;
  usage_count: number;
  success_count: number;
  created_at: string;
  updated_at: string;
  published_at: string | null;
  last_used_at: string | null;
  last_success_at: string | null;
}

export interface ProceduralSkillDraftInput {
  sourceHash: string;
  agentKey: string;
  conversationId?: string | null;
  traceId?: string | null;
  title: string;
  summary: string;
  draftMarkdown: string;
}

export class ProceduralSkillDraftStore {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
    this.ensureTable();
  }

  private ensureTable(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS procedural_skill_drafts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_hash TEXT NOT NULL UNIQUE,
        agent_key TEXT NOT NULL,
        conversation_id TEXT,
        trace_id TEXT,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        draft_markdown TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft',
        published_skill_name TEXT,
        published_skill_path TEXT,
        rejected_reason TEXT,
        usage_count INTEGER NOT NULL DEFAULT 0,
        success_count INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at TEXT NOT NULL DEFAULT (datetime('now')),
        published_at TEXT,
        last_used_at TEXT,
        last_success_at TEXT
      )
    `);
    this.ensureColumn("published_skill_path", "TEXT");
    this.ensureColumn("success_count", "INTEGER NOT NULL DEFAULT 0");
    this.ensureColumn("last_success_at", "TEXT");
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_procedural_skill_drafts_status ON procedural_skill_drafts(status, created_at DESC)",
    );
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_procedural_skill_drafts_agent ON procedural_skill_drafts(agent_key, created_at DESC)",
    );
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_procedural_skill_drafts_trace ON procedural_skill_drafts(trace_id)",
    );
  }

  private ensureColumn(name: string, definition: string): void {
    const columns = this.db.prepare("PRAGMA table_info(procedural_skill_drafts)").all() as Array<{ name: string }>;
    if (columns.some((column) => column.name === name)) return;
    this.db.exec(`ALTER TABLE procedural_skill_drafts ADD COLUMN ${name} ${definition}`);
  }

  create(input: ProceduralSkillDraftInput): ProceduralSkillDraft {
    const existing = this.getBySourceHash(input.sourceHash);
    if (existing) return existing;

    this.db
      .prepare(`
        INSERT INTO procedural_skill_drafts (
          source_hash, agent_key, conversation_id, trace_id, title, summary, draft_markdown
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        input.sourceHash,
        input.agentKey,
        input.conversationId ?? null,
        input.traceId ?? null,
        input.title,
        input.summary,
        input.draftMarkdown,
      );

    const id = Number((this.db.query("SELECT last_insert_rowid() as id").get() as { id: number }).id);
    return this.getById(id)!;
  }

  getById(id: number): ProceduralSkillDraft | null {
    return this.db
      .prepare("SELECT * FROM procedural_skill_drafts WHERE id = ?")
      .get(id) as ProceduralSkillDraft | null;
  }

  getBySourceHash(sourceHash: string): ProceduralSkillDraft | null {
    return this.db
      .prepare("SELECT * FROM procedural_skill_drafts WHERE source_hash = ?")
      .get(sourceHash) as ProceduralSkillDraft | null;
  }

  list(opts?: {
    status?: ProceduralSkillDraftStatus;
    agentKey?: string;
    limit?: number;
  }): ProceduralSkillDraft[] {
    const conditions: string[] = [];
    const params: Array<string | number> = [];

    if (opts?.status) {
      conditions.push("status = ?");
      params.push(opts.status);
    }
    if (opts?.agentKey) {
      conditions.push("agent_key = ?");
      params.push(opts.agentKey);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const limit = opts?.limit ?? 50;

    return this.db
      .prepare(`
        SELECT * FROM procedural_skill_drafts
        ${where}
        ORDER BY created_at DESC
        LIMIT ?
      `)
      .all(...params, limit) as ProceduralSkillDraft[];
  }

  publish(id: number, skillName: string, skillPath?: string | null): ProceduralSkillDraft | null {
    this.db
      .prepare(`
        UPDATE procedural_skill_drafts
        SET
          status = 'published',
          published_skill_name = ?,
          published_skill_path = ?,
          rejected_reason = NULL,
          updated_at = datetime('now'),
          published_at = datetime('now')
        WHERE id = ?
      `)
      .run(skillName, skillPath ?? null, id);
    return this.getById(id);
  }

  reject(id: number, reason: string): ProceduralSkillDraft | null {
    this.db
      .prepare(`
        UPDATE procedural_skill_drafts
        SET
          status = 'rejected',
          rejected_reason = ?,
          published_skill_name = NULL,
          published_skill_path = NULL,
          updated_at = datetime('now')
        WHERE id = ?
      `)
      .run(reason, id);
    return this.getById(id);
  }

  refine(id: number, input: { title?: string; summary?: string; draftMarkdown: string }): ProceduralSkillDraft | null {
    const current = this.getById(id);
    if (!current) return null;
    this.db
      .prepare(`
        UPDATE procedural_skill_drafts
        SET
          title = ?,
          summary = ?,
          draft_markdown = ?,
          updated_at = datetime('now')
        WHERE id = ?
      `)
      .run(
        input.title ?? current.title,
        input.summary ?? current.summary,
        input.draftMarkdown,
        id,
      );
    return this.getById(id);
  }

  recordUsage(id: number): ProceduralSkillDraft | null {
    this.db
      .prepare(`
        UPDATE procedural_skill_drafts
        SET
          usage_count = usage_count + 1,
          updated_at = datetime('now'),
          last_used_at = datetime('now')
        WHERE id = ?
      `)
      .run(id);
    return this.getById(id);
  }

  recordSuccess(id: number): ProceduralSkillDraft | null {
    this.db
      .prepare(`
        UPDATE procedural_skill_drafts
        SET
          success_count = success_count + 1,
          updated_at = datetime('now'),
          last_success_at = datetime('now')
        WHERE id = ?
      `)
      .run(id);
    return this.getById(id);
  }
}

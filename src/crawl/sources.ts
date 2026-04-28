import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { parseCron, nextOccurrence } from "../scheduler/cron.js";
import { ensureTableSchema } from "../utils/schema.js";
import type {
  CrawlConfig,
  CrawlConfigSource,
  CrawlSource,
  CrawlSourceInput,
} from "./types.js";

interface CrawlSourceRow {
  id: string;
  name: string;
  url: string;
  schedule: string;
  depth: number;
  page_limit: number;
  path_glob: string | null;
  scope: string;
  enabled: number;
  last_crawl_at: number | null;
  last_status: string | null;
  last_error: string | null;
  pages_found: number;
  chunks_created: number;
  origin: string;
  created_at: number;
  updated_at: number;
}

export class CrawlSourceStore {
  private readonly db: Database;
  private readonly defaultDepth: number;
  private readonly defaultPageLimit: number;
  private readonly sourceIdentityQuery;

  constructor(db: Database, config?: CrawlConfig) {
    this.db = db;
    this.defaultDepth = config?.default_depth ?? 2;
    this.defaultPageLimit = config?.default_page_limit ?? 50;
    this.init();
    this.sourceIdentityQuery = this.db.query(
      "SELECT id, created_at FROM crawl_sources WHERE name = ?",
    );
  }

  private init(): void {
    ensureTableSchema(this.db, {
      table: "crawl_sources",
      required: [
        "name", "url", "schedule", "depth", "page_limit", "path_glob",
        "scope", "enabled", "last_crawl_at", "last_status", "last_error",
        "pages_found", "chunks_created", "origin", "created_at", "updated_at",
      ],
      ephemeral: false,
      columnDefs: {
        name: "TEXT NOT NULL DEFAULT ''",
        url: "TEXT NOT NULL DEFAULT ''",
        schedule: "TEXT NOT NULL DEFAULT '0 3 * * 0'",
        depth: "INTEGER NOT NULL DEFAULT 2",
        page_limit: "INTEGER NOT NULL DEFAULT 50",
        path_glob: "TEXT",
        scope: "TEXT NOT NULL DEFAULT 'general'",
        enabled: "INTEGER NOT NULL DEFAULT 1",
        last_crawl_at: "INTEGER",
        last_status: "TEXT",
        last_error: "TEXT",
        pages_found: "INTEGER NOT NULL DEFAULT 0",
        chunks_created: "INTEGER NOT NULL DEFAULT 0",
        origin: "TEXT NOT NULL DEFAULT 'config'",
        created_at: "INTEGER NOT NULL DEFAULT 0",
        updated_at: "INTEGER NOT NULL DEFAULT 0",
      },
    }, "crawl");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS crawl_sources (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        url TEXT NOT NULL,
        schedule TEXT NOT NULL,
        depth INTEGER NOT NULL DEFAULT 2,
        page_limit INTEGER NOT NULL DEFAULT 50,
        path_glob TEXT,
        scope TEXT NOT NULL DEFAULT 'general',
        enabled INTEGER NOT NULL DEFAULT 1,
        last_crawl_at INTEGER,
        last_status TEXT,
        last_error TEXT,
        pages_found INTEGER NOT NULL DEFAULT 0,
        chunks_created INTEGER NOT NULL DEFAULT 0,
        origin TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  upsertFromConfig(sources: CrawlConfigSource[]): void {
    const now = Date.now();
    const names = new Set(sources.map((source) => source.name));

    for (const source of sources) {
      const existing = this.getSourceIdentity(source.name);

      const id = existing?.id ?? randomUUID();
      const createdAt = existing?.created_at ?? now;

      this.db.prepare(`
        INSERT INTO crawl_sources (
          id, name, url, schedule, depth, page_limit, path_glob, scope,
          enabled, origin, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'config', ?, ?)
        ON CONFLICT(name) DO UPDATE SET
          url = excluded.url,
          schedule = excluded.schedule,
          depth = excluded.depth,
          page_limit = excluded.page_limit,
          path_glob = excluded.path_glob,
          scope = excluded.scope,
          enabled = excluded.enabled,
          origin = 'config',
          updated_at = excluded.updated_at
      `).run(
        id,
        source.name,
        source.url,
        source.schedule,
        source.depth ?? this.defaultDepth,
        source.page_limit ?? this.defaultPageLimit,
        source.path_glob ?? null,
        source.scope ?? "general",
        source.enabled === false ? 0 : 1,
        createdAt,
        now,
      );
    }

    const stale = this.db.query(
      "SELECT id FROM crawl_sources WHERE origin = 'config'",
    ).all() as Array<{ id: string }>;

    for (const row of stale) {
      const nameRow = this.db.query("SELECT name FROM crawl_sources WHERE id = ?").get(row.id) as { name: string } | null;
      if (!nameRow || names.has(nameRow.name)) continue;
      this.db.run(
        "UPDATE crawl_sources SET enabled = 0, last_status = 'removed', updated_at = ? WHERE id = ?",
        [now, row.id],
      );
    }
  }

  addDynamic(source: CrawlSourceInput): string {
    const now = Date.now();
    const existing = this.getSourceIdentity(source.name);
    const id = existing?.id ?? randomUUID();
    const createdAt = existing?.created_at ?? now;
    this.db.prepare(`
      INSERT INTO crawl_sources (
        id, name, url, schedule, depth, page_limit, path_glob, scope,
        enabled, origin, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET
        url = excluded.url,
        schedule = excluded.schedule,
        depth = excluded.depth,
        page_limit = excluded.page_limit,
        path_glob = excluded.path_glob,
        scope = excluded.scope,
        enabled = excluded.enabled,
        origin = excluded.origin,
        updated_at = excluded.updated_at
    `).run(
      id,
      source.name,
      source.url,
      source.schedule,
      source.depth ?? this.defaultDepth,
      source.pageLimit ?? this.defaultPageLimit,
      source.pathGlob ?? null,
      source.scope ?? "general",
      source.enabled === false ? 0 : 1,
      source.origin,
      createdAt,
      now,
    );
    return id;
  }

  remove(id: string): void {
    const existing = this.db.query(
      "SELECT origin FROM crawl_sources WHERE id = ?",
    ).get(id) as { origin: string } | null;

    if (!existing) return;
    if (existing.origin === "config") {
      throw new Error("Config crawl sources cannot be removed at runtime");
    }

    this.db.run(
      "UPDATE crawl_sources SET enabled = 0, last_status = 'removed', updated_at = ? WHERE id = ?",
      [Date.now(), id],
    );
  }

  getEnabled(): CrawlSource[] {
    return this.queryRows(
      "SELECT * FROM crawl_sources WHERE enabled = 1 ORDER BY name ASC",
    );
  }

  getInactive(): CrawlSource[] {
    return this.queryRows(
      "SELECT * FROM crawl_sources WHERE enabled = 0 ORDER BY updated_at DESC",
    );
  }

  getDue(now = Date.now()): CrawlSource[] {
    return this.getEnabled().filter((source) => {
      const anchor = source.lastCrawlAt ?? source.createdAt;
      const nextRunAt = nextOccurrence(parseCron(source.schedule), new Date(anchor)).getTime();
      return nextRunAt <= now;
    });
  }

  getById(id: string): CrawlSource | null {
    const row = this.db.query(
      "SELECT * FROM crawl_sources WHERE id = ?",
    ).get(id) as CrawlSourceRow | null;
    return row ? mapRow(row) : null;
  }

  updateAfterCrawl(
    id: string,
    status: "completed" | "failed",
    stats: {
      pagesFound?: number;
      chunksCreated?: number;
      lastError?: string | null;
      completedAt?: number;
    } = {},
  ): void {
    const now = stats.completedAt ?? Date.now();
    this.db.run(
      `UPDATE crawl_sources SET
        last_crawl_at = CASE WHEN ? = 'completed' THEN ? ELSE last_crawl_at END,
        last_status = ?,
        last_error = ?,
        pages_found = ?,
        chunks_created = ?,
        updated_at = ?
      WHERE id = ?`,
      [
        status,
        now,
        status,
        stats.lastError ?? null,
        stats.pagesFound ?? 0,
        stats.chunksCreated ?? 0,
        now,
        id,
      ],
    );
  }

  private queryRows(sql: string): CrawlSource[] {
    const rows = this.db.query(sql).all() as CrawlSourceRow[];
    return rows.map(mapRow);
  }

  private getSourceIdentity(name: string): { id: string; created_at: number } | null {
    return this.sourceIdentityQuery.get(name) as { id: string; created_at: number } | null;
  }
}

function mapRow(row: CrawlSourceRow): CrawlSource {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    schedule: row.schedule,
    depth: row.depth,
    pageLimit: row.page_limit,
    pathGlob: row.path_glob,
    scope: row.scope,
    enabled: row.enabled === 1,
    lastCrawlAt: row.last_crawl_at,
    lastStatus: row.last_status,
    lastError: row.last_error,
    pagesFound: row.pages_found,
    chunksCreated: row.chunks_created,
    origin: row.origin,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

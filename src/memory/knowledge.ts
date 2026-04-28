import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../utils/logger.js";
import { formatError } from "../utils/error.js";
import { ensureTableSchema } from "../utils/schema.js";
import { buildKnowledgeArtifactSourceUri, hashContextSource } from "./retrieval-trace.js";
import type { MemoryStore } from "./store.js";

/** A stored knowledge chunk with embedding metadata and optional similarity score. */
export interface KnowledgeChunk {
  id: number;
  title: string;
  section: string | null;
  content: string;
  category: string | null;
  source_path: string;
  content_hash: string;
  source_agent?: string | null;
  source_thread_id?: string | null;
  decision_status?: string | null;
  chunk_index?: number;
  similarity?: number;
}

/** Aggregate statistics for the knowledge store including tier distribution. */
export interface KnowledgeStats {
  totalChunks: number;
  totalFiles: number;
  categories: Record<string, number>;
  tiers?: Record<string, number>;
}

export interface KnowledgeSearchStats {
  strategy: "full_scan" | "fts_prefilter" | "fts_prefilter_with_full_scan_fallback";
  scannedCount: number;
  rerankedCount: number;
}

export interface KnowledgeSearchResult {
  results: KnowledgeChunk[];
  stats: KnowledgeSearchStats;
}

/** Task context for relevance-aware knowledge ranking. */
export interface KnowledgeTaskContext {
  /** File paths the agent is currently working with. */
  filePaths?: string[];
  /** Task type hint: "debug", "code", "review", "chat". */
  taskType?: string;
  /** Keywords extracted from the current task/conversation. */
  keywords?: string[];
  /** Boost chunks matching specific categories. */
  categoryBoost?: string[];
}

export type KnowledgeChunkListItem = Pick<KnowledgeChunk, "title" | "section" | "content" | "category" | "source_path">;

interface SearchableKnowledgeRow extends KnowledgeChunk {
  scope: string;
  priority: number;
  source_agent: string | null;
  source_thread_id: string | null;
  chunk_index: number;
  embedding: Buffer;
  accessed_at: number | null;
  access_count: number;
  confidence: number;
}

interface SeedChunkRow {
  id: number;
  title: string;
  source_path: string;
  chunk_index: number;
}

const SEARCH_PREFILTER_MIN = 40;
const SEARCH_PREFILTER_MULTIPLIER = 12;
const SEARCH_PREFILTER_FALLBACK_MIN = 8;
const SEARCH_PREFILTER_FULL_SCAN_FALLBACK_MAX = 4000;

/** SQLite-backed vector knowledge store with cosine similarity search and tiered retention. */
export class KnowledgeStore {
  private db: Database;
  private dimensions: number;
  private contextMetadata?: Pick<MemoryStore, "touchContextArtifactSource" | "enqueueContextArtifactJob">;

  constructor(dataDir: string, projectName?: string, dimensions = 1536) {
    const fileName = `${(projectName ?? "knowledge").toLowerCase()}_knowledge.db`;
    const dbPath = join(dataDir, fileName);
    this.db = new Database(dbPath, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    const walCheck = this.db.query("PRAGMA journal_mode").get() as { journal_mode: string } | null;
    if (walCheck?.journal_mode !== "wal") {
      logger.warn(`[knowledge] WAL mode not active (journal_mode=${walCheck?.journal_mode}), performance may be degraded`);
    }
    this.dimensions = dimensions;
    this.init();
  }

  private init(): void {
    // Detect stale schemas before CREATE TABLE IF NOT EXISTS.
    // Persistent data — ALTER TABLE ADD COLUMN for missing columns.
    // All columns are declared here; ensureTableSchema adds any missing ones.
    ensureTableSchema(this.db, {
      table: "knowledge_chunks",
      required: ["title", "section", "content", "category", "source_path",
        "content_hash", "embedding", "created_at", "updated_at",
        "scope", "priority", "source_agent", "source_thread_id", "accessed_at", "access_count",
        "confidence", "shareable", "chunk_index", "decision_status"],
      ephemeral: false,
      columnDefs: {
        title: "TEXT NOT NULL DEFAULT ''", section: "TEXT",
        content: "TEXT NOT NULL DEFAULT ''", category: "TEXT",
        source_path: "TEXT NOT NULL DEFAULT ''", content_hash: "TEXT NOT NULL DEFAULT ''",
        embedding: "BLOB", created_at: "INTEGER NOT NULL DEFAULT 0",
        updated_at: "INTEGER NOT NULL DEFAULT 0",
        scope: "TEXT NOT NULL DEFAULT 'global'",
        priority: "INTEGER NOT NULL DEFAULT 1",
        source_agent: "TEXT",
        source_thread_id: "TEXT",
        accessed_at: "INTEGER",
        access_count: "INTEGER NOT NULL DEFAULT 0",
        confidence: "REAL NOT NULL DEFAULT 1.0",
        shareable: "INTEGER NOT NULL DEFAULT 0",
        chunk_index: "INTEGER NOT NULL DEFAULT 0",
        decision_status: "TEXT",
      },
    }, "knowledge");

    // Migrate: replace old (source_path, section) unique index with (source_path, section, chunk_index)
    // to support repeated headings in the same document.
    try {
      this.db.exec("DROP INDEX IF EXISTS idx_knowledge_source_section");
    } catch {
      // Ignore — index may not exist on fresh databases
    }

    const schemaPath = join(import.meta.dir, "knowledge_schema.sql");
    const schema = readFileSync(schemaPath, "utf-8");

    try {
      this.db.exec(schema);
    } catch (err) {
      const msg = formatError(err);
      if (!msg.includes("already exists")) {
        logger.warn(`[knowledge] Schema warning: ${msg}`);
      }
    }

    // Backfill: set accessed_at = updated_at for rows that don't have it yet
    this.db.exec("UPDATE knowledge_chunks SET accessed_at = updated_at WHERE accessed_at IS NULL");
    this.ensureSearchIndex();

    logger.info("[knowledge] Database initialized");
  }

  private ensureSearchIndex(): void {
    try {
      const chunkCount = (this.db
        .query("SELECT COUNT(*) AS count FROM knowledge_chunks")
        .get() as { count: number }).count;
      const ftsCount = (this.db
        .query("SELECT COUNT(*) AS count FROM knowledge_chunks_fts")
        .get() as { count: number }).count;
      if (chunkCount !== ftsCount) {
        this.db.exec("DELETE FROM knowledge_chunks_fts");
        this.db.exec(`INSERT INTO knowledge_chunks_fts(rowid, title, section, content, category, source_path)
                      SELECT id, title, section, content, category, source_path FROM knowledge_chunks`);
        logger.info(`[knowledge] Rebuilt knowledge FTS index (${ftsCount} -> ${chunkCount})`);
      }
    } catch (err) {
      logger.warn(`[knowledge] Failed to validate search index: ${formatError(err)}`);
    }
  }

  setContextMetadataStore(store?: Pick<MemoryStore, "touchContextArtifactSource" | "enqueueContextArtifactJob">): void {
    this.contextMetadata = store;
  }

  /** Insert or update a knowledge chunk by (source_path, section) key. */
  upsertChunk(
    title: string,
    section: string | null,
    content: string,
    category: string | null,
    sourcePath: string,
    contentHash: string,
    embedding: Float32Array,
    scope?: string,
    priority?: number,
    sourceAgent?: string,
    chunkIndex?: number,
    sourceThreadId?: string,
    decisionStatus?: string,
  ): void {
    const now = Date.now();
    const blob = Buffer.from(embedding.buffer);
    const resolvedScope = scope ?? "global";
    const resolvedPriority = priority ?? 1;
    const resolvedChunkIndex = chunkIndex ?? 0;

    this.db
      .prepare(
        `INSERT INTO knowledge_chunks (title, section, content, category, source_path, content_hash, embedding, scope, priority, source_agent, source_thread_id, chunk_index, decision_status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(source_path, section, chunk_index) DO UPDATE SET
           title = excluded.title,
           content = excluded.content,
           category = excluded.category,
           content_hash = excluded.content_hash,
           embedding = excluded.embedding,
           scope = excluded.scope,
           priority = excluded.priority,
           source_agent = excluded.source_agent,
           source_thread_id = excluded.source_thread_id,
           decision_status = excluded.decision_status,
           updated_at = excluded.updated_at`,
      )
      .run(title, section, content, category, sourcePath, contentHash, blob, resolvedScope, resolvedPriority, sourceAgent ?? null, sourceThreadId ?? null, resolvedChunkIndex, decisionStatus ?? null, now, now);

    if (this.contextMetadata) {
      const row = this.db
        .prepare("SELECT id FROM knowledge_chunks WHERE source_path = ? AND section IS ? AND chunk_index = ?")
        .get(sourcePath, section, resolvedChunkIndex) as { id: number } | null;
      if (row) {
        const sourceUri = buildKnowledgeArtifactSourceUri(row.id);
        const sourceHash = hashContextSource(content);
        if (this.contextMetadata.touchContextArtifactSource({
          sourceUri,
          sourceType: "knowledge_chunk",
          sourceKind: "imported_docs",
          sourceLabel: section ? `${title}#${section}` : title,
          sourceHash,
        })) {
          this.contextMetadata.enqueueContextArtifactJob({
            sourceUri,
            sourceType: "knowledge_chunk",
            sourceKind: "imported_docs",
            sourceLabel: section ? `${title}#${section}` : title,
            content,
            priority: 2,
          });
        }
      }
    }
  }

  /**
   * Semantic search using cosine similarity.
   * Two-phase: raw cosine for relevance filtering, then boost signals for ranking.
   * Pre-filters by scope/category when provided to avoid full table scan.
   */
  search(
    queryEmbedding: Float32Array,
    limit = 5,
    threshold = 0.70,
    scope?: string,
    category?: string,
    queryText?: string,
    taskContext?: KnowledgeTaskContext,
  ): KnowledgeChunk[] {
    return this.searchDetailed(queryEmbedding, limit, threshold, scope, category, queryText, taskContext).results;
  }

  searchDetailed(
    queryEmbedding: Float32Array,
    limit = 5,
    threshold = 0.70,
    scope?: string,
    category?: string,
    queryText?: string,
    taskContext?: KnowledgeTaskContext,
  ): KnowledgeSearchResult {
    const { filterSql, params } = this.buildFilters(scope, category);
    const searchRows = this.selectSearchRows(queryText, filterSql, params, limit);
    return this.scoreRows(searchRows, queryEmbedding, threshold, limit, true, taskContext);
  }

  /** Mark a decision chunk as superseded (reduces ranking via confidence × 0.5). */
  supersedeDecision(chunkId: number): void {
    this.db.prepare(
      "UPDATE knowledge_chunks SET decision_status = 'superseded', confidence = confidence * 0.5 WHERE id = ?",
    ).run(chunkId);
  }

  /** Mark chunks from a source path as shareable (available to remote instances). */
  markShareable(sourcePath: string, shareable: boolean): number {
    const result = this.db.prepare(
      "UPDATE knowledge_chunks SET shareable = ? WHERE source_path = ?",
    ).run(shareable ? 1 : 0, sourcePath);
    return result.changes;
  }

  /** Search only shareable chunks — used by federation endpoint for remote queries. */
  searchShareable(
    queryEmbedding: Float32Array,
    limit = 5,
    threshold = 0.70,
    category?: string,
    queryText?: string,
  ): KnowledgeChunk[] {
    const { filterSql, params } = this.buildFilters(undefined, category);
    const shareableFilter = filterSql
      ? `${filterSql} AND kc.shareable = 1`
      : " AND kc.shareable = 1";
    const searchRows = this.selectSearchRows(queryText, shareableFilter, params, limit);
    return this.scoreRows(searchRows, queryEmbedding, threshold, limit, false).results;
  }

  /** Score and rank search rows by cosine similarity with boost factors. */
  private scoreRows(
    searchRows: { rows: SearchableKnowledgeRow[]; strategy: KnowledgeSearchStats["strategy"]; scannedCount: number },
    queryEmbedding: Float32Array,
    threshold: number,
    limit: number,
    trackAccess: boolean,
    taskContext?: KnowledgeTaskContext,
  ): KnowledgeSearchResult {
    const now = Date.now();
    const scored: Array<KnowledgeChunk & { similarity: number }> = [];

    for (const row of searchRows.rows) {
      const stored = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, this.dimensions);
      const rawSim = cosineSimilarity(queryEmbedding, stored);

      if (rawSim < threshold) continue;

      const priority = row.priority ?? 1;
      const priorityBoost = 1 + 0.05 * (priority - 1);

      let recencyFactor = 1.0;
      if (row.accessed_at) {
        const daysSinceAccess = (now - row.accessed_at) / (1000 * 60 * 60 * 24);
        recencyFactor = 0.5 ** (daysSinceAccess / 30);
      }

      const accessBoost = 1 + Math.log((row.access_count ?? 0) + 1);
      const confidence = row.confidence ?? 1.0;
      const taskRelevance = taskContext ? computeTaskRelevance(row, taskContext) : 1.0;
      const rankedScore = rawSim * priorityBoost * recencyFactor * accessBoost * confidence * taskRelevance;

      scored.push({
        id: row.id,
        title: row.title,
        section: row.section,
        content: row.content,
        category: row.category,
        source_path: row.source_path,
        content_hash: row.content_hash,
        source_agent: row.source_agent,
        source_thread_id: row.source_thread_id,
        decision_status: row.decision_status,
        chunk_index: row.chunk_index,
        similarity: rankedScore,
      });
    }

    scored.sort((a, b) => b.similarity - a.similarity);
    const results = scored.slice(0, limit);

    if (trackAccess && results.length > 0) {
      const ids = results.map((result) => result.id);
      const placeholders = ids.map(() => "?").join(",");
      this.db.prepare(
        `UPDATE knowledge_chunks SET accessed_at = ?, access_count = access_count + 1 WHERE id IN (${placeholders})`,
      ).run(now, ...ids);
    }

    return {
      results,
      stats: {
        strategy: searchRows.strategy,
        scannedCount: searchRows.scannedCount,
        rerankedCount: searchRows.rows.length,
      },
    };
  }

  /** Get a map of "source_path::section::chunk_index" to content_hash for change detection. */
  getExistingHashes(): Map<string, string> {
    const rows = this.db
      .prepare("SELECT source_path, section, chunk_index, content_hash FROM knowledge_chunks")
      .all() as Array<{ source_path: string; section: string | null; chunk_index: number; content_hash: string }>;

    const map = new Map<string, string>();
    for (const row of rows) {
      const key = `${row.source_path}::${row.section ?? "_ROOT_"}::${row.chunk_index}`;
      map.set(key, row.content_hash);
    }
    return map;
  }

  /** Delete all chunks from a given source path. Returns count of deleted rows. */
  deleteBySourcePath(sourcePath: string): number {
    const count = (this.db
      .prepare("SELECT COUNT(*) AS count FROM knowledge_chunks WHERE source_path = ?")
      .get(sourcePath) as { count: number }).count;
    if (count === 0) return 0;
    this.db
      .prepare("DELETE FROM knowledge_chunks WHERE source_path = ?")
      .run(sourcePath);
    return count;
  }

  /** Delete all chunks created by a specific source agent tag. */
  deleteBySourceAgent(sourceAgent: string): number {
    const count = (this.db
      .prepare("SELECT COUNT(*) AS count FROM knowledge_chunks WHERE source_agent = ?")
      .get(sourceAgent) as { count: number }).count;
    if (count === 0) return 0;
    this.db
      .prepare("DELETE FROM knowledge_chunks WHERE source_agent = ?")
      .run(sourceAgent);
    return count;
  }

  /**
   * Delete knowledge chunks not accessed in the given threshold.
   * Critical chunks (priority >= 3) are never pruned.
   * Low-confidence chunks with no accesses are pruned more aggressively (60 days).
   */
  pruneStale(daysThreshold = 90): number {
    const cutoff = Date.now() - daysThreshold * 24 * 60 * 60 * 1000;

    // Standard prune: old + low priority
    const count1 = (this.db.prepare(
      `SELECT COUNT(*) AS count FROM knowledge_chunks
       WHERE accessed_at IS NOT NULL AND accessed_at < ?
       AND priority < 3`,
    ).get(cutoff) as { count: number }).count;
    this.db.prepare(
      `DELETE FROM knowledge_chunks
       WHERE accessed_at IS NOT NULL AND accessed_at < ?
       AND priority < 3`,
    ).run(cutoff);

    // Aggressive prune: low confidence + never accessed + older than 60 days
    const aggressiveCutoff = Date.now() - 60 * 24 * 60 * 60 * 1000;
    const count2 = (this.db.prepare(
      `SELECT COUNT(*) AS count FROM knowledge_chunks
       WHERE confidence < 0.3
       AND access_count = 0
       AND accessed_at IS NOT NULL AND accessed_at < ?
       AND priority < 3`,
    ).get(aggressiveCutoff) as { count: number }).count;
    this.db.prepare(
      `DELETE FROM knowledge_chunks
       WHERE confidence < 0.3
       AND access_count = 0
       AND accessed_at IS NOT NULL AND accessed_at < ?
       AND priority < 3`,
    ).run(aggressiveCutoff);

    const count = count1 + count2;
    if (count > 0) {
      logger.info(`[knowledge] Pruned ${count} stale chunks (${count1} by age, ${count2} by low confidence)`);
    }
    return count;
  }

  /**
   * Mark an existing chunk as superseded by setting confidence *= 0.5.
   * Used when a new fact contradicts an existing one.
   */
  markSuperseded(chunkId: number): void {
    this.db.prepare(
      "UPDATE knowledge_chunks SET confidence = confidence * 0.5 WHERE id = ?",
    ).run(chunkId);
  }

  /**
   * Nudge confidence for a chunk. Clamp to [0.1, 1.0].
   * Positive delta = agent used this knowledge. Negative = injected but ignored.
   */
  nudgeConfidence(chunkId: number, delta: number): void {
    this.db.prepare(
      "UPDATE knowledge_chunks SET confidence = MIN(1.0, MAX(0.1, confidence + ?)) WHERE id = ?",
    ).run(delta, chunkId);
  }

  /**
   * Get a chunk by ID (for contradiction detection).
   */
  getChunkById(id: number): (KnowledgeChunk & { confidence: number; access_count: number }) | null {
    return this.db.prepare(
      "SELECT id, title, section, content, category, source_path, content_hash, source_agent, chunk_index, confidence, access_count FROM knowledge_chunks WHERE id = ?",
    ).get(id) as (KnowledgeChunk & { confidence: number; access_count: number }) | null;
  }

  getSiblings(chunkId: number, limit = 3): KnowledgeChunk[] {
    const target = this.db
      .prepare("SELECT id, title, source_path, chunk_index FROM knowledge_chunks WHERE id = ?")
      .get(chunkId) as { id: number; title: string; source_path: string; chunk_index: number } | null;
    if (!target) return [];

    return this.db
      .prepare(
        `SELECT id, title, section, content, category, source_path, content_hash, source_agent, chunk_index
         FROM knowledge_chunks
         WHERE id != ? AND source_path = ? AND title = ?
         ORDER BY ABS(chunk_index - ?) ASC, chunk_index ASC, id ASC
         LIMIT ?`,
      )
      .all(chunkId, target.source_path, target.title, target.chunk_index, limit) as KnowledgeChunk[];
  }

  getSiblingMatches(
    queryEmbedding: Float32Array,
    seedChunkIds: number[],
    limitPerSeed = 3,
  ): Map<number, Array<KnowledgeChunk & { similarity: number }>> {
    const uniqueSeedIds = Array.from(new Set(seedChunkIds.filter((id) => Number.isInteger(id) && id > 0)));
    if (uniqueSeedIds.length === 0) return new Map();

    const seedPlaceholders = uniqueSeedIds.map(() => "?").join(",");
    const seeds = this.db
      .prepare(`SELECT id, title, source_path, chunk_index FROM knowledge_chunks WHERE id IN (${seedPlaceholders})`)
      .all(...uniqueSeedIds) as SeedChunkRow[];
    if (seeds.length === 0) return new Map();

    const groupClauses: string[] = [];
    const groupParams: string[] = [];
    for (const seed of seeds) {
      groupClauses.push("(source_path = ? AND title = ?)");
      groupParams.push(seed.source_path, seed.title);
    }

    const siblingRows = this.db
      .prepare(
        `SELECT id, title, section, content, category, source_path, content_hash, source_agent, chunk_index, embedding
         FROM knowledge_chunks
         WHERE id NOT IN (${seedPlaceholders}) AND (${groupClauses.join(" OR ")})
         ORDER BY source_path ASC, title ASC, chunk_index ASC, id ASC`,
      )
      .all(...uniqueSeedIds, ...groupParams) as Array<KnowledgeChunk & { embedding: Buffer; source_agent: string | null; chunk_index: number }>;

    const siblingsByGroup = new Map<string, Array<KnowledgeChunk & { embedding: Buffer; source_agent: string | null; chunk_index: number }>>();
    for (const row of siblingRows) {
      const key = `${row.source_path}::${row.title}`;
      const siblings = siblingsByGroup.get(key) ?? [];
      siblings.push(row);
      siblingsByGroup.set(key, siblings);
    }

    const matches = new Map<number, Array<KnowledgeChunk & { similarity: number }>>();
    for (const seed of seeds) {
      const key = `${seed.source_path}::${seed.title}`;
      const siblings = siblingsByGroup.get(key) ?? [];
      const ranked = siblings
        .map((row) => {
          const stored = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, this.dimensions);
          return {
            id: row.id,
            title: row.title,
            section: row.section,
            content: row.content,
            category: row.category,
            source_path: row.source_path,
            content_hash: row.content_hash,
            source_agent: row.source_agent,
            chunk_index: row.chunk_index,
            similarity: cosineSimilarity(queryEmbedding, stored),
            _distance: Math.abs((row.chunk_index ?? 0) - seed.chunk_index),
          };
        })
        .sort((left, right) => {
          if (left._distance !== right._distance) return left._distance - right._distance;
          if (right.similarity !== left.similarity) return right.similarity - left.similarity;
          if ((left.chunk_index ?? 0) !== (right.chunk_index ?? 0)) return (left.chunk_index ?? 0) - (right.chunk_index ?? 0);
          return left.id - right.id;
        })
        .slice(0, limitPerSeed)
        .map(({ _distance, ...chunk }) => chunk);

      matches.set(seed.id, ranked);
    }

    return matches;
  }

  scoreChunkSimilarity(queryEmbedding: Float32Array, chunkId: number): number | null {
    const row = this.db
      .prepare("SELECT embedding FROM knowledge_chunks WHERE id = ?")
      .get(chunkId) as { embedding: Buffer } | null;
    if (!row?.embedding) return null;
    const stored = new Float32Array(row.embedding.buffer, row.embedding.byteOffset, this.dimensions);
    return cosineSimilarity(queryEmbedding, stored);
  }

  /** Get aggregate stats: total chunks, files, category counts, and tier distribution. */
  getStats(): KnowledgeStats {
    const total = this.db
      .prepare("SELECT COUNT(*) as count FROM knowledge_chunks")
      .get() as { count: number };

    const files = this.db
      .prepare("SELECT COUNT(DISTINCT source_path) as count FROM knowledge_chunks")
      .get() as { count: number };

    const cats = this.db
      .prepare("SELECT COALESCE(category, 'uncategorized') as cat, COUNT(*) as count FROM knowledge_chunks GROUP BY category")
      .all() as Array<{ cat: string; count: number }>;

    const categories: Record<string, number> = {};
    for (const c of cats) {
      categories[c.cat] = c.count;
    }

    // Tier distribution
    const now = Date.now();
    const day30 = now - 30 * 24 * 60 * 60 * 1000;
    const day90 = now - 90 * 24 * 60 * 60 * 1000;

    const critical = (this.db.prepare(
      "SELECT COUNT(*) as c FROM knowledge_chunks WHERE priority >= 3",
    ).get() as { c: number }).c;
    const active = (this.db.prepare(
      "SELECT COUNT(*) as c FROM knowledge_chunks WHERE priority < 3 AND (accessed_at IS NULL OR accessed_at >= ?)",
    ).get(day30) as { c: number }).c;
    const archive = (this.db.prepare(
      "SELECT COUNT(*) as c FROM knowledge_chunks WHERE priority < 3 AND accessed_at IS NOT NULL AND accessed_at < ? AND accessed_at >= ?",
    ).get(day30, day90) as { c: number }).c;
    const stale = (this.db.prepare(
      "SELECT COUNT(*) as c FROM knowledge_chunks WHERE priority < 3 AND accessed_at IS NOT NULL AND accessed_at < ?",
    ).get(day90) as { c: number }).c;

    return {
      totalChunks: total.count,
      totalFiles: files.count,
      categories,
      tiers: { critical, active, archive, stale },
    };
  }

  countChunks(): number {
    return (this.db
      .prepare("SELECT COUNT(*) as count FROM knowledge_chunks")
      .get() as { count: number }).count;
  }

  getChunkPage(limit: number, offset = 0): KnowledgeChunkListItem[] {
    return this.db
      .prepare(
        `SELECT title, section, content, category, source_path
         FROM knowledge_chunks
         ORDER BY rowid ASC
         LIMIT ? OFFSET ?`,
      )
      .all(limit, offset) as KnowledgeChunkListItem[];
  }

  getChunksBySourcePath(sourcePath: string, limit = 200): KnowledgeChunk[] {
    return this.db
      .prepare(
        `SELECT id, title, section, content, category, source_path, content_hash, source_agent, source_thread_id, decision_status, chunk_index
         FROM knowledge_chunks
         WHERE source_path = ?
         ORDER BY chunk_index ASC, id ASC
         LIMIT ?`,
      )
      .all(sourcePath, Math.min(Math.max(limit, 1), 500)) as KnowledgeChunk[];
  }

  getRecentChunks(limit: number, offset = 0): KnowledgeChunkListItem[] {
    return this.db
      .prepare(
        `SELECT title, section, content, category, source_path
         FROM knowledge_chunks
         ORDER BY rowid DESC
         LIMIT ? OFFSET ?`,
      )
      .all(limit, offset) as KnowledgeChunkListItem[];
  }

  /** Return all chunks (without embeddings) for export or canvas generation. */
  getAllChunks(): KnowledgeChunkListItem[] {
    return this.db
      .prepare("SELECT title, section, content, category, source_path FROM knowledge_chunks")
      .all() as KnowledgeChunkListItem[];
  }

  /** Return the set of all distinct source paths in the store. */
  getAllSourcePaths(): Set<string> {
    const rows = this.db
      .prepare("SELECT DISTINCT source_path FROM knowledge_chunks")
      .all() as Array<{ source_path: string }>;
    return new Set(rows.map((r) => r.source_path));
  }

  /** Close the underlying SQLite database connection. */
  close(): void {
    this.db.close();
  }

  private buildFilters(scope?: string, category?: string): { filterSql: string; params: (string | number)[] } {
    const conditions: string[] = [];
    const params: (string | number)[] = [];
    if (scope) {
      conditions.push("kc.scope = ?");
      params.push(scope);
    }
    if (category) {
      conditions.push("kc.category = ?");
      params.push(category);
    }
    return {
      filterSql: conditions.length > 0 ? ` AND ${conditions.join(" AND ")}` : "",
      params,
    };
  }

  private fetchSearchRows(filterSql: string, params: (string | number)[]): SearchableKnowledgeRow[] {
    return this.db
      .prepare(
        `SELECT kc.id, kc.title, kc.section, kc.content, kc.category, kc.source_path, kc.content_hash,
                kc.scope, kc.priority, kc.source_agent, kc.source_thread_id, kc.decision_status, kc.chunk_index, kc.embedding, kc.accessed_at,
                kc.access_count, kc.confidence
         FROM knowledge_chunks kc
         WHERE 1 = 1${filterSql}`,
      )
      .all(...params) as SearchableKnowledgeRow[];
  }

  private countFilteredRows(filterSql: string, params: (string | number)[]): number {
    return (this.db
      .prepare(`SELECT COUNT(*) AS count FROM knowledge_chunks kc WHERE 1 = 1${filterSql}`)
      .get(...params) as { count: number }).count;
  }

  private selectSearchRows(
    queryText: string | undefined,
    filterSql: string,
    params: (string | number)[],
    limit: number,
  ): {
    rows: SearchableKnowledgeRow[];
    strategy: KnowledgeSearchStats["strategy"];
    scannedCount: number;
  } {
    const ftsQuery = buildKnowledgeFtsQuery(queryText);
    if (!ftsQuery) {
      const rows = this.fetchSearchRows(filterSql, params);
      return { rows, strategy: "full_scan", scannedCount: rows.length };
    }

    const scannedCount = this.countFilteredRows(filterSql, params);
    const candidateLimit = Math.max(SEARCH_PREFILTER_MIN, limit * SEARCH_PREFILTER_MULTIPLIER);
    const candidateRows = this.db
      .prepare(
        `SELECT kc.id, kc.title, kc.section, kc.content, kc.category, kc.source_path, kc.content_hash,
                kc.scope, kc.priority, kc.source_agent, kc.source_thread_id, kc.decision_status, kc.chunk_index, kc.embedding, kc.accessed_at,
                kc.access_count, kc.confidence
         FROM knowledge_chunks kc
         JOIN knowledge_chunks_fts ON kc.id = knowledge_chunks_fts.rowid
         WHERE knowledge_chunks_fts MATCH ?${filterSql}
         ORDER BY bm25(knowledge_chunks_fts, 4.0, 2.0, 1.0, 0.5, 0.25), kc.priority DESC, kc.updated_at DESC
         LIMIT ?`,
      )
      .all(ftsQuery, ...params, candidateLimit) as SearchableKnowledgeRow[];

    const minimumCandidateCount = Math.min(candidateLimit, Math.max(limit * 2, SEARCH_PREFILTER_FALLBACK_MIN));
    if (candidateRows.length < minimumCandidateCount && scannedCount <= SEARCH_PREFILTER_FULL_SCAN_FALLBACK_MAX) {
      const rows = this.fetchSearchRows(filterSql, params);
      return {
        rows,
        strategy: "fts_prefilter_with_full_scan_fallback",
        scannedCount,
      };
    }

    return {
      rows: candidateRows,
      strategy: "fts_prefilter",
      scannedCount,
    };
  }
}

/**
 * Compute task-relevance multiplier for a knowledge chunk.
 * Mirrors the scoring approach from GraphMemory.getRelevantBriefing():
 * file path matching, keyword overlap, category/task-type boosting.
 * Returns a multiplier >= 0.5 (base) so task context boosts but never zeroes out results.
 */
function computeTaskRelevance(
  row: { content: string; category: string | null; source_path: string },
  ctx: KnowledgeTaskContext,
): number {
  let relevance = 0.5; // base — no task context match still passes
  const contentLower = row.content.toLowerCase();

  // File path matching — strongest signal (+0.5 full path, +0.3 filename)
  if (ctx.filePaths) {
    for (const fp of ctx.filePaths) {
      const fileName = fp.split("/").pop();
      if (contentLower.includes(fp.toLowerCase())) {
        relevance += 0.5;
        break;
      }if (fileName && fileName.length > 2 && contentLower.includes(fileName.toLowerCase())) {
        relevance += 0.3;
        break;
      }
    }
  }

  // Keyword matching — +0.15 per keyword, capped at +0.4
  if (ctx.keywords) {
    let keywordMatches = 0;
    for (const kw of ctx.keywords) {
      if (kw.length > 2 && contentLower.includes(kw.toLowerCase())) {
        keywordMatches++;
      }
    }
    if (keywordMatches > 0) {
      relevance += Math.min(0.4, keywordMatches * 0.15);
    }
  }

  // Category boost — +0.3 if chunk category matches boosted categories
  if (ctx.categoryBoost && row.category) {
    if (ctx.categoryBoost.includes(row.category)) {
      relevance += 0.3;
    }
  }

  // Task type matching — boost specific categories based on task type
  if (ctx.taskType && row.category) {
    if (ctx.taskType === "debug" && (row.category === "post-mortems" || row.category === "error")) relevance += 0.3;
    if (ctx.taskType === "code" && (row.category === "decisions" || row.category === "decision")) relevance += 0.2;
    if (ctx.taskType === "review" && row.category === "implementation-patterns") relevance += 0.2;
  }

  return relevance;
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

function buildKnowledgeFtsQuery(query: string | undefined): string | null {
  if (!query) return null;

  const seen = new Set<string>();
  const terms = query
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, " ")
    .split(/\s+/)
    .map((term) => term.trim())
    .filter((term) => term.length > 1)
    .filter((term) => {
      if (seen.has(term)) return false;
      seen.add(term);
      return true;
    })
    .slice(0, 8);

  if (terms.length === 0) return null;
  return terms.map((term) => `${term}*`).join(" OR ");
}

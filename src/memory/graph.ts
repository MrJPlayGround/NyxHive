import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../utils/logger.js";
import { formatError } from "../utils/error.js";
import { ensureTableSchema } from "../utils/schema.js";
import type { MemoryType, EdgeType, MemoryNode, MemoryEdge } from "../types.js";

export class GraphMemory {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
    this.init();
  }

  private init(): void {
    // Detect stale schemas before CREATE TABLE IF NOT EXISTS.
    // Persistent data — ALTER TABLE ADD COLUMN for missing columns.
    ensureTableSchema(this.db, {
      table: "memory_nodes",
      required: ["type", "content", "source_conversation", "source_channel",
        "importance", "access_count", "mention_count", "created_at", "accessed_at", "expires_at"],
      ephemeral: false,
      columnDefs: {
        type: "TEXT NOT NULL DEFAULT ''", content: "TEXT NOT NULL DEFAULT ''",
        source_conversation: "TEXT", source_channel: "TEXT",
        importance: "REAL DEFAULT 0.5", access_count: "INTEGER DEFAULT 0", mention_count: "INTEGER DEFAULT 1",
        created_at: "INTEGER NOT NULL DEFAULT 0", accessed_at: "INTEGER NOT NULL DEFAULT 0",
        expires_at: "INTEGER",
      },
    }, "graph");
    ensureTableSchema(this.db, {
      table: "memory_edges",
      required: ["source_id", "target_id", "type", "created_at"],
      ephemeral: false,
      columnDefs: {
        source_id: "INTEGER NOT NULL DEFAULT 0", target_id: "INTEGER NOT NULL DEFAULT 0",
        type: "TEXT NOT NULL DEFAULT ''", created_at: "INTEGER NOT NULL DEFAULT 0",
      },
    }, "graph");

    const schemaPath = join(import.meta.dir, "graph-schema.sql");
    const schema = readFileSync(schemaPath, "utf-8");

    const statements: string[] = [];
    let current = "";
    let inBlock = false;

    for (const line of schema.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("--") || trimmed === "") continue;

      current += `${line}\n`;

      if (/\bBEGIN\b/i.test(trimmed)) inBlock = true;
      if (/\bEND;/i.test(trimmed)) inBlock = false;

      if (!inBlock && trimmed.endsWith(";")) {
        statements.push(current.trim());
        current = "";
      }
    }

    if (current.trim()) statements.push(current.trim());

    for (const stmt of statements) {
      try {
        this.db.exec(stmt);
      } catch (err) {
        const msg = formatError(err);
        if (!msg.includes("already exists")) {
          logger.warn(`[graph] Schema warning: ${msg}`);
        }
      }
    }

    // Add mention_count column for semantic dedup (tracks how often a memory is re-encountered)
    try {
      this.db.exec("ALTER TABLE memory_nodes ADD COLUMN mention_count INTEGER DEFAULT 1");
    } catch { /* column already exists */ }

    logger.info("[graph] Knowledge graph initialized");
  }

  // --- CRUD ---

  addNode(
    type: MemoryType,
    content: string,
    source?: { conversationId: string; channel: string },
    importance = 0.5,
    expiresAt?: number,
  ): number {
    const now = Date.now();
    const result = this.db
      .prepare(
        `INSERT INTO memory_nodes (type, content, source_conversation, source_channel, importance, access_count, created_at, accessed_at, expires_at)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`,
      )
      .run(
        type,
        content,
        source?.conversationId ?? null,
        source?.channel ?? null,
        importance,
        now,
        now,
        expiresAt ?? null,
      );

    return Number(result.lastInsertRowid);
  }

  addEdge(sourceId: number, targetId: number, type: EdgeType): void {
    const now = Date.now();
    try {
      this.db
        .prepare(
          `INSERT OR IGNORE INTO memory_edges (source_id, target_id, type, created_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(sourceId, targetId, type, now);
    } catch (err) {
      const msg = formatError(err);
      logger.warn(`[graph] Failed to add edge ${sourceId}->${targetId} (${type}): ${msg}`);
    }
  }

  getNode(id: number): MemoryNode | null {
    return (this.db.prepare("SELECT * FROM memory_nodes WHERE id = ?").get(id) as MemoryNode) ?? null;
  }

  deleteNode(id: number): void {
    this.db.prepare("DELETE FROM memory_nodes WHERE id = ?").run(id);
  }

  // --- Retrieval ---

  getByType(type: MemoryType, limit = 20): MemoryNode[] {
    return this.db
      .prepare("SELECT * FROM memory_nodes WHERE type = ? ORDER BY importance DESC, created_at DESC LIMIT ?")
      .all(type, limit) as MemoryNode[];
  }

  listNodes(limit = 20): MemoryNode[] {
    return this.db
      .prepare("SELECT * FROM memory_nodes ORDER BY importance DESC, created_at DESC LIMIT ?")
      .all(limit) as MemoryNode[];
  }

  findByContent(contents: string[]): MemoryNode[] {
    if (contents.length === 0) return [];
    const placeholders = contents.map(() => "?").join(", ");
    return this.db
      .prepare(`SELECT * FROM memory_nodes WHERE content IN (${placeholders}) ORDER BY importance DESC`)
      .all(...contents) as MemoryNode[];
  }

  getRelated(nodeId: number): Array<{ node: MemoryNode; edge: EdgeType }> {
    const rows = this.db
      .prepare(
        `SELECT n.*, e.type as edge_type FROM memory_nodes n
         JOIN memory_edges e ON (e.target_id = n.id AND e.source_id = ?) OR (e.source_id = n.id AND e.target_id = ?)
         ORDER BY n.importance DESC`,
      )
      .all(nodeId, nodeId) as Array<MemoryNode & { edge_type: EdgeType }>;

    return rows.map((r) => {
      const { edge_type, ...node } = r;
      return { node: node as MemoryNode, edge: edge_type };
    });
  }

  search(query: string, types?: MemoryType[], limit = 10): MemoryNode[] {
    try {
      const ftsQuery = query
        .split(/\s+/)
        .filter((w) => w.length > 2)
        .map((w) => `"${w}"`)
        .join(" OR ");

      if (!ftsQuery) return [];

      if (types && types.length > 0) {
        const placeholders = types.map(() => "?").join(",");
        return this.db
          .prepare(
            `SELECT n.* FROM memory_nodes n
             JOIN memory_nodes_fts fts ON n.id = fts.rowid
             WHERE memory_nodes_fts MATCH ? AND n.type IN (${placeholders})
             ORDER BY rank
             LIMIT ?`,
          )
          .all(ftsQuery, ...types, limit) as MemoryNode[];
      }

      return this.db
        .prepare(
          `SELECT n.* FROM memory_nodes n
           JOIN memory_nodes_fts fts ON n.id = fts.rowid
           WHERE memory_nodes_fts MATCH ?
           ORDER BY rank
           LIMIT ?`,
        )
        .all(ftsQuery, limit) as MemoryNode[];
    } catch {
      return [];
    }
  }

  /** Get memory nodes from a specific conversation, ordered by importance. */
  getByConversation(conversationId: string, limit = 10): MemoryNode[] {
    return this.db
      .prepare(
        "SELECT * FROM memory_nodes WHERE source_conversation = ? ORDER BY importance DESC, created_at DESC LIMIT ?",
      )
      .all(conversationId, limit) as MemoryNode[];
  }

  // --- Importance ---

  touchNode(id: number): void {
    const now = Date.now();
    this.db
      .prepare(
        "UPDATE memory_nodes SET accessed_at = ?, access_count = access_count + 1 WHERE id = ?",
      )
      .run(now, id);

    // Recalculate and store importance
    const node = this.getNode(id);
    if (node) {
      const newImportance = this.calculateImportance(node);
      this.db.prepare("UPDATE memory_nodes SET importance = ? WHERE id = ?").run(newImportance, id);
    }
  }

  bumpMentionCount(nodeId: number): void {
    this.db.run(
      `UPDATE memory_nodes
       SET mention_count = mention_count + 1,
           importance = CASE
             WHEN mention_count + 1 >= 3 AND importance < 0.6 THEN 0.6
             ELSE importance
           END
       WHERE id = ?`,
      [nodeId],
    );
  }

  getRecurringPatterns(limit: number): MemoryNode[] {
    return this.db
      .prepare(
        `SELECT * FROM memory_nodes
         WHERE mention_count >= 3
         ORDER BY mention_count DESC, importance DESC
         LIMIT ?`,
      )
      .all(limit) as MemoryNode[];
  }

  private getRuntimeRecurringPatterns(
    limit: number,
    taskContext?: {
      filePaths?: string[];
      taskType?: string;
      agentName?: string;
      keywords?: string[];
    },
  ): MemoryNode[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM memory_nodes
         WHERE mention_count >= 3
         AND (expires_at IS NULL OR expires_at > ?)
         ORDER BY mention_count DESC, importance DESC
         LIMIT ?`,
      )
      .all(Date.now(), limit * 6) as MemoryNode[];
    const taskSignalCount = taskContext ? this.countTaskContextSignals(taskContext) : 0;
    const minTaskRelevance = taskSignalCount > 1 ? 2 : 1;

    return rows
      .filter((node) => !this.isRuntimeBriefingNoise(node))
      .map((node) => ({
        node,
        relevance: taskSignalCount > 0 ? this.getTaskContextRelevanceScore(node, taskContext!) : 0,
      }))
      .filter(({ relevance }) => taskSignalCount === 0 || relevance >= minTaskRelevance)
      .sort((a, b) => b.relevance - a.relevance || b.node.mention_count - a.node.mention_count || b.node.importance - a.node.importance)
      .map(({ node }) => node)
      .slice(0, limit);
  }

  private isRuntimeBriefingNoise(node: MemoryNode): boolean {
    if (node.type === "file_change") return true;

    const content = node.content.trim().toLowerCase();
    if (content.startsWith("touched file:")) return true;
    if (content === "test failure resolved during coding task") return true;
    if (content.startsWith("test failure resolved during coding task:")) return true;
    if (content.includes("current repository health is")) return true;
    if (content.includes("current health check reports")) return true;
    if (content.includes("runtime scan hygiene is intact")) return true;
    if (content.includes("worktree is clean")) return true;
    if (content.includes("worktree unchanged")) return true;
    if (content.includes("worktree were clean")) return true;
    if (content.includes("repository is now clean")) return true;
    if (content.includes("repo is clean")) return true;
    if (content.includes("repository is at commit")) return true;
    if (content.includes("restoring nyx required no repository changes")) return true;
    if (content.includes("process is live with pid")) return true;
    if (content.includes("last captured state")) return true;
    if (content.includes("should target commit")) return true;
    if (content.includes("master...origin/master")) return true;
    if (content.includes("not pushed")) return true;

    return false;
  }

  private getTaskContextRelevanceScore(
    node: MemoryNode,
    taskContext: {
      filePaths?: string[];
      taskType?: string;
      agentName?: string;
      keywords?: string[];
    },
  ): number {
    const content = node.content.toLowerCase();
    let score = 0;

    for (const keyword of taskContext.keywords ?? []) {
      const normalized = keyword.trim().toLowerCase();
      if (normalized.length > 2 && content.includes(normalized)) score += 1;
    }

    for (const filePath of taskContext.filePaths ?? []) {
      const normalizedPath = filePath.trim().toLowerCase();
      const fileName = normalizedPath.split("/").pop();
      if (normalizedPath && content.includes(normalizedPath)) score += 3;
      else if (fileName && fileName.length > 2 && content.includes(fileName)) score += 2;
    }

    const agentName = taskContext.agentName?.trim().toLowerCase();
    if (agentName && agentName.length > 2 && content.includes(agentName)) score += 2;

    const taskType = taskContext.taskType?.trim().toLowerCase();
    if (taskType && taskType.length > 2 && content.includes(taskType)) score += 1;
    if (taskType === "debug" && node.type === "error") score += 2;
    if (taskType === "code" && node.type === "decision") score += 1;
    if (taskType === "review" && node.type === "pattern") score += 1;

    return score;
  }

  private countTaskContextSignals(taskContext: {
    filePaths?: string[];
    taskType?: string;
    agentName?: string;
    keywords?: string[];
  }): number {
    return (taskContext.keywords?.filter((keyword) => keyword.trim().length > 2).length ?? 0)
      + (taskContext.filePaths?.filter((filePath) => filePath.trim().length > 0).length ?? 0)
      + ((taskContext.taskType?.trim().length ?? 0) > 2 ? 1 : 0)
      + ((taskContext.agentName?.trim().length ?? 0) > 2 ? 1 : 0);
  }

  decayImportance(): void {
    const nodes = this.db
      .prepare("SELECT * FROM memory_nodes WHERE expires_at IS NULL OR expires_at > ?")
      .all(Date.now()) as MemoryNode[];

    const stmt = this.db.prepare("UPDATE memory_nodes SET importance = ? WHERE id = ?");
    let decayed = 0;

    for (const node of nodes) {
      const newImportance = this.calculateImportance(node);
      if (Math.abs(newImportance - node.importance) > 0.01) {
        stmt.run(newImportance, node.id);
        decayed++;
      }
    }

    if (decayed > 0) {
      logger.info(`[graph] Decayed importance for ${decayed} nodes`);
    }
  }

  private calculateImportance(node: MemoryNode): number {
    const ageMs = Date.now() - node.created_at;
    const ageDays = ageMs / (1000 * 60 * 60 * 24);
    const recency = 0.5 ** (ageDays / 30); // half-life: 30 days
    const access = Math.min(2.0, 1.0 + 0.1 * node.access_count);
    return Math.min(1.0, node.importance * recency * access);
  }

  // --- Task-aware briefing ---

  /**
   * Get relevant context for a new agent invocation based on task context.
   * Returns ranked memory nodes matching file paths, task type, agent name, keywords.
   * Score: recency * access_frequency * relevance_score. Capped by token budget.
   */
  getRelevantBriefing(taskContext: {
    filePaths?: string[];
    taskType?: string;
    agentName?: string;
    keywords?: string[];
    maxTokens?: number;
    recordAccess?: boolean;
  }): string {
    const maxTokens = taskContext.maxTokens ?? 1000;
    const now = Date.now();

    // Fetch candidate nodes — decisions, patterns, errors are highest-value for briefing
    const briefingTypes: MemoryType[] = ["decision", "pattern", "error", "fact", "preference", "observation"];

    // Hybrid retrieval: FTS5 keyword candidates + importance-ranked fallback
    const candidateMap = new Map<number, MemoryNode>();

    // Phase 1: FTS5 search for keyword-matched candidates (most relevant)
    const ftsTerms = [
      ...(taskContext.keywords ?? []),
      ...(taskContext.filePaths?.map(p => p.split("/").pop()!).filter(Boolean) ?? []),
    ].filter(t => t && t.length > 2);

    if (ftsTerms.length > 0) {
      const ftsQuery = ftsTerms.map(w => `"${w.replace(/"/g, "")}"`).join(" OR ");
      try {
        const ftsResults = this.db.prepare(
          `SELECT n.* FROM memory_nodes n
           JOIN memory_nodes_fts fts ON n.id = fts.rowid
           WHERE memory_nodes_fts MATCH ?
           AND n.type IN (${briefingTypes.map(() => "?").join(",")})
           AND (n.expires_at IS NULL OR n.expires_at > ?)
           ORDER BY rank
           LIMIT 50`,
        ).all(ftsQuery, ...briefingTypes, now) as MemoryNode[];
        for (const node of ftsResults) candidateMap.set(node.id, node);
      } catch { /* FTS query errors are non-fatal */ }
    }

    // Phase 2: Importance-ranked fallback to fill remaining slots
    const importanceResults = this.db.prepare(
      `SELECT * FROM memory_nodes
       WHERE type IN (${briefingTypes.map(() => "?").join(",")})
       AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY importance DESC, created_at DESC
       LIMIT 200`,
    ).all(...briefingTypes, now) as MemoryNode[];
    for (const node of importanceResults) {
      if (!candidateMap.has(node.id)) candidateMap.set(node.id, node);
    }

    const taskSignalCount = this.countTaskContextSignals(taskContext);
    const minTaskRelevance = taskSignalCount > 1 ? 2 : 1;
    const candidates = Array.from(candidateMap.values())
      .filter((node) => !this.isRuntimeBriefingNoise(node))
      .filter((node) => taskSignalCount === 0 || this.getTaskContextRelevanceScore(node, taskContext) >= minTaskRelevance);
    if (candidates.length === 0) return "";

    // Score each candidate
    const scored = candidates.map((node) => {
      // Exponential decay: half-life 30 days (consistent with calculateImportance)
      const ageDays = (now - node.created_at) / (1000 * 60 * 60 * 24);
      const recency = 0.5 ** (ageDays / 30);

      // Access is a weak tie-breaker. Relevance must dominate, or stale
      // high-access memories crowd out exact task matches.
      const accessFreq = 1 + Math.log(node.access_count + 1) * 0.1;

      // Relevance score: keyword/path matching
      let relevance = 0.05; // base relevance
      const contentLower = node.content.toLowerCase();

      // File path matching — strongest signal
      if (taskContext.filePaths) {
        for (const fp of taskContext.filePaths) {
          const parts = fp.split("/");
          const fileName = parts[parts.length - 1];
          if (contentLower.includes(fp.toLowerCase())) {
            relevance += 0.5;
            break;
          }if (fileName && contentLower.includes(fileName.toLowerCase())) {
            relevance += 0.3;
            break;
          }
        }
      }

      // Keyword matching
      if (taskContext.keywords) {
        let keywordMatches = 0;
        for (const kw of taskContext.keywords) {
          if (kw.length > 2 && contentLower.includes(kw.toLowerCase())) {
            keywordMatches++;
          }
        }
        if (keywordMatches > 0) {
          relevance += keywordMatches * 0.55;
        }
      }

      // Task type matching — boost errors if task looks like debugging
      if (taskContext.taskType) {
        if (taskContext.taskType === "debug" && node.type === "error") relevance += 0.3;
        if (taskContext.taskType === "code" && node.type === "decision") relevance += 0.2;
        if (taskContext.taskType === "review" && node.type === "pattern") relevance += 0.2;
      }

      const score = recency * accessFreq * relevance;
      return { node, score };
    });

    // Sort by score descending
    scored.sort((a, b) => b.score - a.score);

    // Build briefing within token budget
    const recurring = this.getRuntimeRecurringPatterns(5, taskContext);
    const recurringLines: string[] = [];
    const lines: string[] = [];
    let estimatedTokens = 0;
    const touchedIds: number[] = [];
    const recurringHeaderTokens = Math.ceil("**Recurring patterns:**".length / 4);
    const contextHeaderTokens = Math.ceil("## Context from Previous Sessions".length / 4);

    for (const node of recurring) {
      const line = `- ${node.content} (seen ${node.mention_count}x)`;
      const lineTokens = Math.ceil(line.length / 4);
      const headerTokens = recurringLines.length === 0 ? recurringHeaderTokens : 0;
      if (estimatedTokens + headerTokens + lineTokens > maxTokens) break;
      if (headerTokens > 0) estimatedTokens += headerTokens;
      recurringLines.push(line);
      estimatedTokens += lineTokens;
    }

    for (const { node } of scored) {
      const date = new Date(node.created_at).toISOString().split("T")[0];
      const line = `- ${node.content} (${date})`;
      const lineTokens = Math.ceil(line.length / 4);
      const headerTokens = lines.length === 0 ? contextHeaderTokens : 0;
      if (estimatedTokens + headerTokens + lineTokens > maxTokens) break;
      if (headerTokens > 0) estimatedTokens += headerTokens;
      lines.push(line);
      estimatedTokens += lineTokens;
      touchedIds.push(node.id);
    }

    // Touch retrieved nodes (update access tracking)
    if (taskContext.recordAccess !== false && touchedIds.length > 0) {
      const placeholders = touchedIds.map(() => "?").join(",");
      this.db.prepare(
        `UPDATE memory_nodes SET accessed_at = ?, access_count = access_count + 1 WHERE id IN (${placeholders})`,
      ).run(now, ...touchedIds);
    }

    if (lines.length === 0 && recurringLines.length === 0) return "";

    const parts: string[] = [];

    // Prepend recurring patterns (nodes mentioned 3+ times across conversations)
    if (recurringLines.length > 0) {
      parts.push(`**Recurring patterns:**\n${recurringLines.join("\n")}`);
    }

    if (lines.length > 0) {
      parts.push(`## Context from Previous Sessions\n${lines.join("\n")}`);
    }

    return parts.join("\n\n");
  }

  // --- Briefing ---

  getBriefing(maxNodes = 20, channel?: string, maxTokens = 500): string {
    const now = Date.now();
    const params: (string | number)[] = [now];
    let query = "SELECT * FROM memory_nodes WHERE (expires_at IS NULL OR expires_at > ?)";
    if (channel) {
      query += " AND source_channel = ?";
      params.push(channel);
    }

    const nodes = (this.db
      .prepare(query)
      .all(...params) as MemoryNode[])
      .filter((node) => !this.isRuntimeBriefingNoise(node));

    const scored = nodes.map((n) => ({ ...n, score: this.calculateImportance(n) }));
    scored.sort((a, b) => b.score - a.score);

    const byType = new Map<string, Array<typeof scored[number]>>();
    for (const node of scored.slice(0, maxNodes)) {
      const list = byType.get(node.type) ?? [];
      list.push(node);
      byType.set(node.type, list);
    }

    const sections: string[] = [];
    let estimatedTokens = 0;

    // Prepend recurring patterns (nodes mentioned 3+ times across conversations)
    const recurring = this.getRuntimeRecurringPatterns(5);
    const recurringLines: string[] = [];
    const recurringHeaderTokens = Math.ceil("**Recurring patterns:**".length / 4);
    for (const node of recurring) {
      const line = `- ${node.content} (seen ${node.mention_count}x)`;
      const lineTokens = Math.ceil(line.length / 4);
      const headerTokens = recurringLines.length === 0 ? recurringHeaderTokens : 0;
      if (estimatedTokens + headerTokens + lineTokens > maxTokens) break;
      if (headerTokens > 0) estimatedTokens += headerTokens;
      recurringLines.push(line);
      estimatedTokens += lineTokens;
    }
    if (recurringLines.length > 0) {
      sections.push(`**Recurring patterns:**\n${recurringLines.join("\n")}`);
    }

    for (const [type, typeNodes] of byType) {
      const header = `[${type}]`;
      const lines: string[] = [];
      const headerTokens = Math.ceil(header.length / 4);
      if (estimatedTokens + headerTokens > maxTokens) break;
      estimatedTokens += headerTokens;

      for (const n of typeNodes) {
        const line = `- ${n.content}`;
        const lineTokens = Math.ceil(line.length / 4); // rough estimate: ~4 chars per token
        if (estimatedTokens + lineTokens > maxTokens) break;
        lines.push(line);
        estimatedTokens += lineTokens;
      }
      if (lines.length > 0) {
        sections.push(`${header}\n${lines.join("\n")}`);
      }
      if (estimatedTokens >= maxTokens) break;
    }

    return sections.join("\n\n");
  }

  // --- Contradiction detection ---

  getContradictions(): Array<{ a: MemoryNode; b: MemoryNode }> {
    const edges = this.db
      .prepare(
        `SELECT e.source_id, e.target_id FROM memory_edges e WHERE e.type = 'contradicts'`,
      )
      .all() as Array<{ source_id: number; target_id: number }>;

    const results: Array<{ a: MemoryNode; b: MemoryNode }> = [];
    for (const edge of edges) {
      const a = this.getNode(edge.source_id);
      const b = this.getNode(edge.target_id);
      if (a && b) results.push({ a, b });
    }
    return results;
  }

  // --- Cleanup ---

  pruneExpired(): number {
    const result = this.db
      .prepare("DELETE FROM memory_nodes WHERE expires_at IS NOT NULL AND expires_at <= ?")
      .run(Date.now());
    const count = result.changes;
    if (count > 0) {
      logger.info(`[graph] Pruned ${count} expired nodes`);
    }
    return count;
  }

  expireRuntimeBriefingNoise(now = Date.now()): { expired: number } {
    const nodes = this.db
      .prepare("SELECT * FROM memory_nodes WHERE expires_at IS NULL OR expires_at > ?")
      .all(now) as MemoryNode[];

    const noisyIds = nodes.filter((node) => this.isRuntimeBriefingNoise(node)).map((node) => node.id);
    if (noisyIds.length === 0) return { expired: 0 };

    const placeholders = noisyIds.map(() => "?").join(",");
    this.db
      .prepare(`UPDATE memory_nodes SET expires_at = ?, importance = MIN(importance, 0.01), mention_count = 1 WHERE id IN (${placeholders})`)
      .run(now, ...noisyIds);

    return { expired: noisyIds.length };
  }

  pruneByImportance(minImportance = 0.05): number {
    // Recalculate importance first, then prune
    const nodes = this.db
      .prepare("SELECT * FROM memory_nodes")
      .all() as MemoryNode[];

    const toDelete: number[] = [];
    for (const node of nodes) {
      const score = this.calculateImportance(node);
      if (score < minImportance) {
        toDelete.push(node.id);
      }
    }

    if (toDelete.length > 0) {
      const placeholders = toDelete.map(() => "?").join(",");
      this.db.prepare(`DELETE FROM memory_nodes WHERE id IN (${placeholders})`).run(...toDelete);
      logger.info(`[graph] Pruned ${toDelete.length} low-importance nodes (threshold: ${minImportance})`);
    }

    return toDelete.length;
  }

  /** Check if a node with identical type and content already exists. */
  hasExactContent(type: MemoryType, content: string): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM memory_nodes WHERE type = ? AND content = ? LIMIT 1")
      .get(type, content);
    return row != null;
  }

  /**
   * Insert a node only if no duplicate (type, content) exists.
   * Returns the node ID (existing or new), or null if skipped as duplicate.
   */
  addNodeDedup(
    type: MemoryType,
    content: string,
    source?: { conversationId: string; channel: string },
    importance = 0.5,
    expiresAt?: number,
  ): number | null {
    if (this.hasExactContent(type, content)) return null;
    return this.addNode(type, content, source, importance, expiresAt);
  }

  // --- Cross-conversation search ---

  /**
   * Search for memory nodes from OTHER conversations matching a query.
   * Used for cross-conversation memory linking ("you hit this same issue 2 weeks ago").
   */
  searchAcrossConversations(excludeConvId: string, query: string, limit: number): MemoryNode[] {
    try {
      return this.db
        .prepare(
          `SELECT n.* FROM memory_nodes n
           JOIN memory_nodes_fts fts ON n.id = fts.rowid
           WHERE memory_nodes_fts MATCH ?
             AND n.source_conversation != ?
           ORDER BY rank
           LIMIT ?`,
        )
        .all(query, excludeConvId, limit) as MemoryNode[];
    } catch {
      return [];
    }
  }

  // --- Helpers for extraction ---

  /**
   * Find existing nodes that might be similar to a new memory.
   * Used for dedup and contradiction detection during extraction.
   */
  findSimilar(type: MemoryType, content: string, limit = 5): MemoryNode[] {
    // Use FTS to find candidates
    const words = content
      .split(/\s+/)
      .filter((w) => w.length > 3)
      .slice(0, 5);

    if (words.length === 0) return [];

    const ftsQuery = words.map((w) => `"${w}"`).join(" OR ");
    try {
      return this.db
        .prepare(
          `SELECT n.* FROM memory_nodes n
           JOIN memory_nodes_fts fts ON n.id = fts.rowid
           WHERE memory_nodes_fts MATCH ? AND n.type = ?
           ORDER BY rank
           LIMIT ?`,
        )
        .all(ftsQuery, type, limit) as MemoryNode[];
    } catch {
      return [];
    }
  }

  /**
   * Get a summary of existing memories for dedup context during extraction.
   */
  getExistingSummary(limit = 30): string {
    const nodes = this.db
      .prepare("SELECT type, content FROM memory_nodes ORDER BY importance DESC, created_at DESC LIMIT ?")
      .all(limit) as Array<{ type: string; content: string }>;

    if (nodes.length === 0) return "None yet.";
    return nodes.map((n) => `[${n.type}] ${n.content}`).join("\n");
  }

  getNodeCount(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as count FROM memory_nodes")
      .get() as { count: number };
    return row.count;
  }

  getEdgeCount(): number {
    const row = this.db
      .prepare("SELECT COUNT(*) as count FROM memory_edges")
      .get() as { count: number };
    return row.count;
  }

  getNodeWithEdges(id: number): { node: MemoryNode; edges: Array<MemoryEdge & { related_node: MemoryNode }> } | null {
    const node = this.getNode(id);
    if (!node) return null;

    const edges = this.db
      .prepare(
        `SELECT e.*,
           CASE WHEN e.source_id = ? THEN e.target_id ELSE e.source_id END as related_id
         FROM memory_edges e
         WHERE e.source_id = ? OR e.target_id = ?`,
      )
      .all(id, id, id) as Array<MemoryEdge & { related_id: number }>;

    const edgesWithNodes = edges.map((e) => {
      const relatedNode = this.getNode(e.related_id)!;
      return { ...e, related_node: relatedNode };
    }).filter((e) => e.related_node != null);

    return { node, edges: edgesWithNodes };
  }
}

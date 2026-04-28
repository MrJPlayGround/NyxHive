import { Hono } from "hono";
import type { KnowledgeStore } from "../../memory/knowledge.js";
import type { EmbeddingProvider } from "../../memory/embeddings.js";
import type { NyxHiveConfig } from "../../types.js";
import { ingestVault } from "../../memory/ingest.js";
import { chunkMarkdown } from "../../memory/ingest.js";
import { compileKnowledgeDigest, type CompiledKnowledgeStore } from "../../memory/compiled-knowledge.js";
import { logger } from "../../utils/logger.js";
import { generateKnowledgeCanvas } from "../../memory/obsidian.js";
import { clampInt } from "../../utils/parse.js";
import { canRead, canWrite } from "../middleware/rbac.js";

export function knowledgeRoutes(
  store: KnowledgeStore,
  embedder?: EmbeddingProvider,
  config?: NyxHiveConfig,
  compiledKnowledge?: CompiledKnowledgeStore,
): Hono {
  const app = new Hono();

  // GET /api/knowledge/stats
  app.get("/stats", canRead, (c) => {
    return c.json({
      ...store.getStats(),
      compiledPages: compiledKnowledge?.count() ?? 0,
    });
  });

  // GET /api/knowledge/search — semantic search
  app.get("/search", canRead, async (c) => {
    if (!embedder) {
      return c.json({ error: "embeddings provider not configured" }, 503);
    }

    const query = c.req.query("q");
    if (!query) {
      return c.json({ error: "q parameter is required" }, 400);
    }

    const limit = clampInt(c.req.query("limit"), 5, 1, 100);
    const threshold = Number(c.req.query("threshold") ?? 0.5);

    const embedding = await embedder.embed(query);
    const results = store.search(embedding, limit, threshold, undefined, undefined, query);
    return c.json(results);
  });

  // POST /api/knowledge/federated-search — for remote instances to query shareable knowledge
  app.post("/federated-search", canRead, async (c) => {
    if (!embedder) {
      return c.json({ error: "embeddings provider not configured" }, 503);
    }

    const body = await c.req.json().catch(() => null);
    if (!body?.query || typeof body.query !== "string") {
      return c.json({ error: "query is required" }, 400);
    }

    const limit = clampInt(body.limit, 5, 1, 20);
    const embedding = await embedder.embed(body.query);
    const results = store.searchShareable(embedding, limit, 0.5, body.category, body.query);
    return c.json({
      results,
      instance: config?.daemon?.name ?? "unknown",
    });
  });

  // POST /api/knowledge/ingest — trigger vault re-ingestion
  app.post("/ingest", canWrite, async (c) => {
    if (!embedder) {
      return c.json({ error: "embeddings provider not configured" }, 503);
    }

    const body = await c.req.json<{
      vault_path?: string;
      content?: string;
      title?: string;
      category?: string;
    }>().catch(() => ({} as { vault_path?: string; content?: string; title?: string; category?: string }));

    // Inline document ingestion
    if (body.content) {
      const title = body.title || "Untitled";
      const category = body.category || "inline";
      const sourcePath = `inline/${Date.now()}-${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.md`;
      const chunks = chunkMarkdown(title, body.content, category, sourcePath);

      if (chunks.length === 0) {
        return c.json({ error: "No chunks produced from content" }, 400);
      }

      let ingested = 0;
      for (const chunk of chunks) {
        const embedding = await embedder.embed(chunk.prefixed);
        store.upsertChunk(
          chunk.title, chunk.section, chunk.content, chunk.category,
          chunk.sourcePath, chunk.contentHash, embedding,
        );
        ingested++;
      }

      return c.json({ ingested, title, category, source_path: sourcePath });
    }

    // Full vault ingestion
    const vaultPath = body.vault_path || config?.vault?.path;
    if (!vaultPath) {
      return c.json({ error: "No vault path provided or configured" }, 400);
    }

    logger.info(`[knowledge] API-triggered vault ingestion: ${vaultPath}`);
    const result = await ingestVault({ path: vaultPath, skipDirs: config?.vault?.skip_dirs }, store, embedder);
    logger.info(`[knowledge] Ingestion complete: ${result.newChunks} new, ${result.updatedChunks} updated, ${result.skippedChunks} skipped`);

    return c.json(result);
  });

  // GET /api/knowledge/canvas — generate knowledge canvas
  app.get("/canvas", canRead, (c) => {
    const maxNodes = clampInt(c.req.query("max_nodes"), 100, 1, 1000);
    const groupBy = c.req.query("group_by") ?? "category";

    const allChunks = store.getAllChunks();
    if (allChunks.length === 0) {
      return c.json({ error: "No knowledge chunks available" }, 404);
    }

    const canvas = generateKnowledgeCanvas(allChunks, {
      title: "Knowledge Map",
      groupByCategory: groupBy === "category",
      maxNodes,
    });

    try {
      return c.json(JSON.parse(canvas));
    } catch {
      return c.json({ error: "Failed to generate knowledge canvas" }, 500);
    }
  });

  app.get("/digests", canRead, (c) => {
    if (!compiledKnowledge) {
      return c.json({ pages: [] });
    }
    const q = c.req.query("q");
    const limit = clampInt(c.req.query("limit"), 50, 1, 200);
    const stale = c.req.query("stale");
    return c.json({
      pages: compiledKnowledge.list({
        query: q ?? undefined,
        limit,
        stale: stale === undefined ? undefined : stale === "true",
      }),
    });
  });

  app.get("/digests/:id", canRead, (c) => {
    if (!compiledKnowledge) {
      return c.json({ error: "compiled knowledge not configured" }, 503);
    }
    const page = compiledKnowledge.getById(Number(c.req.param("id")));
    if (!page) {
      return c.json({ error: "digest not found" }, 404);
    }
    return c.json(page);
  });

  app.post("/digests/compile", canWrite, async (c) => {
    if (!compiledKnowledge) {
      return c.json({ error: "compiled knowledge not configured" }, 503);
    }
    const body = await c.req.json<{ source_path?: string }>().catch(() => null);
    if (!body?.source_path) {
      return c.json({ error: "source_path is required" }, 400);
    }
    const chunks = store.getChunksBySourcePath(body.source_path);
    if (chunks.length === 0) {
      return c.json({ error: "no knowledge chunks found for source_path" }, 404);
    }
    const digest = compileKnowledgeDigest(body.source_path, chunks);
    const page = compiledKnowledge.upsert(digest);
    return c.json({ page });
  });

  return app;
}

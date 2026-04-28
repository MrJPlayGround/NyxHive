import { Hono } from "hono";
import { z } from "zod";
import { describeMemoryLaneAuthorities } from "../../memory/lanes.js";
import type { MemoryStore } from "../../memory/store.js";
import type { GraphMemory } from "../../memory/graph.js";
import type { ContextArtifactSourceType, ContextSourceKind } from "../../memory/retrieval-trace.js";
import { buildConversationQualityReport } from "../../runtime/conversation-quality.js";
import { buildTranscriptCalibrationReport } from "../../runtime/transcript-review.js";
import type { MemoryType } from "../../types.js";
import { parseBody } from "./validate.js";
import { canRead, canWrite } from "../middleware/rbac.js";

const saveMemorySchema = z.object({
  content: z.string().min(1),
  category: z.string().optional(),
  source: z.string().optional(),
  memoryType: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
  sourceReliability: z.string().optional(),
  userConfirmed: z.boolean().optional(),
  currentness: z.string().optional(),
  status: z.string().optional(),
  supersedesId: z.number().int().positive().optional(),
  expiresAt: z.number().int().positive().optional(),
});

const VALID_CONTEXT_ARTIFACT_TYPES = new Set<ContextArtifactSourceType>(["knowledge_chunk", "thread_archive", "repo_doc"]);
const VALID_CONTEXT_SOURCE_KINDS = new Set<ContextSourceKind>([
  "live_transcript",
  "imported_chat",
  "imported_docs",
  "manual_notes",
  "extracted_graph_fact",
  "summary_artifact",
  "retrieval_artifact",
]);

function clampLimit(raw: string | undefined, fallback: number, max: number): number {
  const parsed = Number(raw ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(max, Math.trunc(parsed)));
}

export function memoryRoutes(memory: MemoryStore): Hono {
  const app = new Hono();

  // GET /api/memory — list recent memories
  app.get("/", canRead, (c) => {
    const limit = Number(c.req.query("limit") ?? 20);
    return c.json(memory.listMemories(limit));
  });

  // POST /api/memory — save a memory
  app.post("/", canWrite, async (c) => {
    const result = await parseBody(c, saveMemorySchema);
    if (result instanceof Response) return result;
    const id = memory.saveMemory(result.content, result);
    return c.json({ id, status: "saved" });
  });

  // GET /api/memory/trust — inspect typed memory trust/currentness metadata
  app.get("/trust", canRead, (c) => {
    const limit = clampLimit(c.req.query("limit"), 50, 200);
    return c.json({ memories: memory.listMemoryTrust(limit) });
  });

  // GET /api/memory/search — FTS5 search on memories
  app.get("/search", canRead, (c) => {
    const query = c.req.query("q");
    if (!query) {
      return c.json({ error: "q parameter is required" }, 400);
    }
    const limit = Number(c.req.query("limit") ?? 5);
    return c.json(memory.searchMemories(query, limit));
  });

  // GET /api/memory/messages/search — FTS5 search on messages (global)
  app.get("/messages/search", canRead, (c) => {
    const query = c.req.query("q");
    if (!query) {
      return c.json({ error: "q parameter is required" }, 400);
    }
    const limit = Number(c.req.query("limit") ?? 20);
    return c.json(memory.searchMessages(query, limit));
  });

  // GET /api/memory/context/traces — inspect recent prompt assembly traces
  app.get("/context/traces", canRead, (c) => {
    const conversationId = c.req.query("conversation_id");
    const limit = clampLimit(c.req.query("limit"), 20, 200);
    const traces = memory.getContextTraces(conversationId, limit).map((trace) => {
      try {
        const parsed = JSON.parse(trace.trace_json);
        return {
          ...trace,
          trace: {
            ...parsed,
            memoryLaneAuthorities: describeMemoryLaneAuthorities(parsed.memoryLanesInjected ?? []),
          },
        };
      } catch {
        return { ...trace, trace: null };
      }
    });
    return c.json({ traces });
  });

  // GET /api/memory/context/traces/:id — inspect a single prompt assembly trace
  app.get("/context/traces/:id", canRead, (c) => {
    const id = Number(c.req.param("id"));
    if (Number.isNaN(id)) return c.json({ error: "Invalid id" }, 400);

    const trace = memory.getContextTraceById(id);
    if (!trace) return c.json({ error: "Not found" }, 404);

    try {
      return c.json({ ...trace, trace: JSON.parse(trace.trace_json) });
    } catch {
      return c.json({ ...trace, trace: null });
    }
  });

  // GET /api/memory/context/quality — inspect live conversation/runtime quality signals
  app.get("/context/quality", canRead, (c) => {
    const limit = clampLimit(c.req.query("limit"), 100, 500);
    return c.json(buildConversationQualityReport(memory.getConversationQualityTraceRows(limit)));
  });

  // GET /api/memory/context/transcript-review — triage transcript-led conversational quality findings
  app.get("/context/transcript-review", canRead, (c) => {
    const limit = clampLimit(c.req.query("limit"), 100, 500);
    const maxPerCategory = clampLimit(c.req.query("max_per_category"), 1, 10);
    return c.json(buildTranscriptCalibrationReport(memory.getConversationQualityTraceRows(limit), { maxPerCategory }));
  });

  // GET /api/memory/context/artifacts — inspect generated context artifacts
  app.get("/context/artifacts", canRead, (c) => {
    const limit = clampLimit(c.req.query("limit"), 50, 200);
    const type = c.req.query("type");
    const sourceKind = c.req.query("source_kind");
    const importBatchId = c.req.query("import_batch_id");
    const staleOnly = c.req.query("stale") === "true";
    if (type && !VALID_CONTEXT_ARTIFACT_TYPES.has(type as ContextArtifactSourceType)) {
      return c.json({ error: "Invalid artifact type" }, 400);
    }
    if (sourceKind && !VALID_CONTEXT_SOURCE_KINDS.has(sourceKind as ContextSourceKind)) {
      return c.json({ error: "Invalid source kind" }, 400);
    }

    const artifacts = memory.listContextArtifacts({
      limit,
      sourceType: type as ContextArtifactSourceType | undefined,
      sourceKind: sourceKind as ContextSourceKind | undefined,
      importBatchId,
      staleOnly,
    }).map((artifact) => {
      const missing = artifact.generated_at == null || !artifact.l0_abstract || !artifact.l1_overview;
      return {
        ...artifact,
        status: artifact.is_stale === 1 ? "stale" : (missing ? "pending" : "ready"),
      };
    });

    return c.json({
      artifacts,
      stats: memory.getContextArtifactStats(),
    });
  });

  // GET /api/memory/context/artifacts/by-uri?uri=...
  app.get("/context/artifacts/by-uri", canRead, (c) => {
    const uri = c.req.query("uri");
    if (!uri) return c.json({ error: "uri parameter is required" }, 400);

    const artifact = memory.getContextArtifact(uri);
    if (!artifact) return c.json({ error: "Not found" }, 404);

    const missing = artifact.generated_at == null || !artifact.l0_abstract || !artifact.l1_overview;
    return c.json({
      ...artifact,
      status: artifact.is_stale === 1 ? "stale" : (missing ? "pending" : "ready"),
    });
  });

  // GET /api/memory/context/artifacts/stats — compact artifact health summary
  app.get("/context/artifacts/stats", canRead, (c) => {
    return c.json(memory.getContextArtifactStats());
  });

  // DELETE /api/memory/:id — delete a memory
  app.delete("/:id", canWrite, (c) => {
    const id = Number(c.req.param("id"));
    memory.deleteMemory(id);
    return c.json({ deleted: id });
  });

  // GET /api/memory/usage — usage summary
  app.get("/usage", canRead, (c) => {
    const hours = Number(c.req.query("hours") ?? 24);
    const summary = memory.getUsageSummary(hours);
    const total = memory.getTotalCost(hours);
    const actual = memory.getActualCost(hours);
    return c.json({ summary, total_cost: total, actual_cost: actual, period_hours: hours });
  });

  return app;
}

const VALID_MEMORY_TYPES = new Set([
  "fact", "preference", "decision", "identity",
  "event", "observation", "goal", "task",
  "error", "pattern", "dependency", "file_change",
]);

export function graphMemoryRoutes(graph: GraphMemory): Hono {
  const app = new Hono();

  // GET /api/memory/graph — list nodes, filterable by ?type=fact&limit=20
  app.get("/", canRead, (c) => {
    const typeParam = c.req.query("type");
    const limit = Number(c.req.query("limit") ?? 20);

    if (typeParam && VALID_MEMORY_TYPES.has(typeParam)) {
      return c.json({
        nodes: graph.getByType(typeParam as MemoryType, limit),
        total: graph.getNodeCount(),
      });
    }

    // Return top nodes by importance (all types)
    return c.json({
      nodes: graph.listNodes(limit),
      total: graph.getNodeCount(),
      edges: graph.getEdgeCount(),
    });
  });

  // GET /api/memory/graph/briefing — current briefing text
  // Note: must be before /:id to avoid "briefing" being treated as an id
  app.get("/briefing", canRead, (c) => {
    const maxNodes = Number(c.req.query("max") ?? 20);
    return c.json({ briefing: graph.getBriefing(maxNodes) });
  });

  // GET /api/memory/graph/contradictions — list unresolved contradictions
  app.get("/contradictions", canRead, (c) => {
    return c.json({ contradictions: graph.getContradictions() });
  });

  // GET /api/memory/graph/search — FTS search
  app.get("/search", canRead, (c) => {
    const query = c.req.query("q");
    if (!query) return c.json({ error: "q parameter is required" }, 400);

    const typeParam = c.req.query("type");
    const types = typeParam ? typeParam.split(",").filter((t) => VALID_MEMORY_TYPES.has(t)) as MemoryType[] : undefined;
    const limit = Number(c.req.query("limit") ?? 10);

    return c.json({ results: graph.search(query, types, limit) });
  });

  // GET /api/memory/graph/:id — single node + edges
  app.get("/:id", canRead, (c) => {
    const id = Number(c.req.param("id"));
    if (Number.isNaN(id)) return c.json({ error: "Invalid id" }, 400);

    const result = graph.getNodeWithEdges(id);
    if (!result) return c.json({ error: "Not found" }, 404);

    // Touch the node (bump access count)
    graph.touchNode(id);

    return c.json(result);
  });

  // DELETE /api/memory/graph/:id — delete a memory
  app.delete("/:id", canWrite, (c) => {
    const id = Number(c.req.param("id"));
    if (Number.isNaN(id)) return c.json({ error: "Invalid id" }, 400);

    graph.deleteNode(id);
    return c.json({ deleted: id });
  });

  // POST /api/memory/graph/prune — manual cleanup
  app.post("/prune", canWrite, (c) => {
    const expired = graph.pruneExpired();
    const lowImportance = graph.pruneByImportance();
    return c.json({ pruned: { expired, low_importance: lowImportance } });
  });

  // POST /api/memory/graph/decay — trigger importance decay
  app.post("/decay", canWrite, (c) => {
    graph.decayImportance();
    return c.json({ status: "decayed" });
  });

  return app;
}

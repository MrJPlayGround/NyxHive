import { Hono } from "hono";
import type { GraphMemory } from "../../memory/graph.js";
import type { MemoryStore } from "../../memory/store.js";
import type { KnowledgeStore } from "../../memory/knowledge.js";
import type { AuthEnv } from "../../auth/types.js";
import type { MemoryType } from "../../types.js";
import { clampInt } from "../../utils/parse.js";
import { canRead, canWrite } from "../middleware/rbac.js";

const VALID_GRAPH_TYPES: MemoryType[] = [
  "fact", "preference", "decision", "identity",
  "event", "observation", "goal", "task",
  "error", "pattern", "dependency", "file_change",
];

const TYPE_META: Record<string, { label: string; icon: string }> = {
  fact: { label: "Facts", icon: "brain" },
  preference: { label: "Preferences", icon: "heart" },
  decision: { label: "Decisions", icon: "arrow.triangle.branch" },
  identity: { label: "Identity", icon: "person" },
  event: { label: "Events", icon: "calendar" },
  observation: { label: "Observations", icon: "eye" },
  goal: { label: "Goals", icon: "target" },
  task: { label: "Tasks", icon: "checklist" },
  error: { label: "Errors", icon: "exclamationmark.triangle" },
  pattern: { label: "Patterns", icon: "repeat" },
  dependency: { label: "Dependencies", icon: "link" },
  file_change: { label: "File Changes", icon: "doc.text" },
};

export function memoryBankRoutes(
  graph: GraphMemory,
  memory: MemoryStore,
  knowledge: KnowledgeStore,
): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  // GET / - category summary with counts
  app.get("/", canRead, (c) => {
    const categories: Array<{ type: string; count: number; label: string; icon: string }> = [];

    for (const type of VALID_GRAPH_TYPES) {
      const nodes = graph.getByType(type, 1000);
      if (nodes.length > 0) {
        const meta = TYPE_META[type];
        categories.push({ type, count: nodes.length, label: meta.label, icon: meta.icon });
      }
    }

    // FTS5 saved memories
    const savedMemories = memory.listMemories(1000);
    if (savedMemories.length > 0) {
      categories.push({ type: "saved", count: savedMemories.length, label: "Saved Memories", icon: "bookmark" });
    }

    // Knowledge chunks
    const kStats = knowledge.getStats();
    if (kStats.totalChunks > 0) {
      categories.push({ type: "knowledge", count: kStats.totalChunks, label: "Knowledge", icon: "book" });
    }

    // Recent memories across key types
    const recentTypes: MemoryType[] = ["fact", "preference", "decision", "observation"];
    const recent: import("../../types.js").MemoryNode[] = [];
    for (const t of recentTypes) {
      recent.push(...graph.getByType(t, 3));
    }
    recent.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));

    return c.json({
      categories,
      recentMemories: recent.slice(0, 10),
      totalNodes: graph.getNodeCount(),
      totalEdges: graph.getEdgeCount(),
      totalChunks: kStats.totalChunks,
    });
  });

  // GET /:type - drill-down with optional search
  app.get("/:type", canRead, (c) => {
    const type = c.req.param("type");
    const limit = clampInt(c.req.query("limit"), 50, 1, 500);
    const offset = clampInt(c.req.query("offset"), 0, 0, 10000);
    const q = c.req.query("q");

    if (type === "saved") {
      const items = q ? memory.searchMemories(q, limit) : memory.listMemories(limit);
      return c.json({ type: "saved", items, total: items.length });
    }

    if (type === "knowledge") {
      return c.json({
        type: "knowledge",
        items: knowledge.getChunkPage(limit, offset),
        total: knowledge.countChunks(),
      });
    }

    if (!VALID_GRAPH_TYPES.includes(type as MemoryType)) {
      return c.json({ error: "Invalid memory type" }, 400);
    }

    const nodes = q
      ? graph.search(q, [type as MemoryType], limit)
      : graph.getByType(type as MemoryType, limit);

    return c.json({ type, items: nodes, total: nodes.length });
  });

  // DELETE /:type/:id
  app.delete("/:type/:id", canWrite, (c) => {
    const type = c.req.param("type");
    const id = Number.parseInt(c.req.param("id"));

    if (type === "saved") {
      memory.deleteMemory(id);
    } else {
      graph.deleteNode(id);
    }

    return c.json({ deleted: true });
  });

  return app;
}

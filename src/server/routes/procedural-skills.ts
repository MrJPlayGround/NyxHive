import { Hono } from "hono";
import { z } from "zod";
import type { ProceduralSkillDraftStatus, ProceduralSkillDraftStore } from "../../memory/procedural-skills.js";
import {
  buildProceduralSkillAuditReason,
  compareProceduralSkills,
  matchesProceduralSkillQuery,
  needsProceduralSkillAudit,
  type ProceduralSkillSort,
} from "../../memory/procedural-skill-analytics.js";
import { publishProceduralSkillDraft } from "../../agents/procedural-skills.js";
import { adminOnly, canRead } from "../middleware/rbac.js";
import { parseBody } from "./validate.js";

const VALID_STATUSES = new Set<ProceduralSkillDraftStatus>(["draft", "published", "rejected"]);
const VALID_SORTS = new Set<ProceduralSkillSort>(["newest", "most_used", "best_outcomes", "needs_audit"]);

const publishSchema = z.object({
  skill_name: z.string().trim().min(1).max(80).optional(),
});

const rejectSchema = z.object({
  reason: z.string().trim().min(1).max(500),
});

const rejectAuditSchema = z.object({
  ids: z.array(z.number().int().positive()).min(1).max(100),
  reason: z.string().trim().min(1).max(500).optional(),
});

function normalizeStatus(value: string | undefined): ProceduralSkillDraftStatus | undefined {
  if (!value) return undefined;
  return VALID_STATUSES.has(value as ProceduralSkillDraftStatus)
    ? value as ProceduralSkillDraftStatus
    : undefined;
}

function normalizeSort(value: string | undefined): ProceduralSkillSort {
  if (!value) return "newest";
  return VALID_SORTS.has(value as ProceduralSkillSort) ? value as ProceduralSkillSort : "newest";
}

export function proceduralSkillsRoutes(store: ProceduralSkillDraftStore): Hono {
  const app = new Hono();

  app.get("/", canRead, (c) => {
    const status = normalizeStatus(c.req.query("status"));
    if (c.req.query("status") && !status) {
      return c.json({ error: "Invalid status" }, 400);
    }

    const agentKey = c.req.query("agent")?.trim() || undefined;
    const query = c.req.query("query")?.trim() || "";
    const auditOnly = c.req.query("audit") === "true";
    const sort = normalizeSort(c.req.query("sort"));
    const limit = Math.max(1, Math.min(200, Number.parseInt(c.req.query("limit") || "50", 10) || 50));
    const drafts = store.list({ status, agentKey, limit: Math.max(limit, 200) })
      .filter((draft) => (auditOnly ? needsProceduralSkillAudit(draft) : true))
      .filter((draft) => matchesProceduralSkillQuery(draft, query))
      .sort((left, right) => compareProceduralSkills(left, right, sort))
      .slice(0, limit);
    return c.json({ drafts, total: drafts.length, sort, audit: auditOnly, query });
  });

  app.get("/:id", canRead, (c) => {
    const id = Number.parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id)) return c.json({ error: "Invalid id" }, 400);

    const draft = store.getById(id);
    if (!draft) return c.json({ error: "Not found" }, 404);
    return c.json(draft);
  });

  app.post("/audit/reject", adminOnly, async (c) => {
    const result = await parseBody(c, rejectAuditSchema);
    if (result instanceof Response) return result;

    const rejected: number[] = [];
    for (const id of result.ids) {
      const draft = store.getById(id);
      if (!draft || !needsProceduralSkillAudit(draft)) continue;
      store.reject(id, result.reason ?? buildProceduralSkillAuditReason(draft) ?? "Rejected after procedural skill audit");
      rejected.push(id);
    }

    return c.json({ rejected_ids: rejected, count: rejected.length });
  });

  app.post("/:id/publish", adminOnly, async (c) => {
    const id = Number.parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id)) return c.json({ error: "Invalid id" }, 400);

    const result = await parseBody(c, publishSchema);
    if (result instanceof Response) return result;

    const draft = store.getById(id);
    if (!draft) return c.json({ error: "Not found" }, 404);

    const published = publishProceduralSkillDraft(store, id, {
      skillName: result.skill_name,
    });
    return c.json({
      id,
      status: "published",
      skill_name: published.skillName,
      skill_path: published.skillPath,
    });
  });

  app.post("/:id/reject", adminOnly, async (c) => {
    const id = Number.parseInt(c.req.param("id"), 10);
    if (!Number.isFinite(id)) return c.json({ error: "Invalid id" }, 400);

    const result = await parseBody(c, rejectSchema);
    if (result instanceof Response) return result;

    const draft = store.reject(id, result.reason);
    if (!draft) return c.json({ error: "Not found" }, 404);

    return c.json({
      id,
      status: draft.status,
      rejected_reason: draft.rejected_reason,
    });
  });

  return app;
}

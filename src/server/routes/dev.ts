import { Hono } from "hono";
import { z } from "zod";
import type { DevPlanStore } from "../../development/plan.js";
import type { QueueProcessor } from "../../queue/processor.js";
import type { AgentRegistry } from "../../agents/registry.js";
import type { MemoryStore } from "../../memory/store.js";
import type { NyxHiveConfig } from "../../types.js";
import { executeDevPlan } from "../../development/loop.js";
import { logger } from "../../utils/logger.js";
import { parseBody } from "./validate.js";
import { adminOnly, canRead } from "../middleware/rbac.js";

const createPlanSchema = z.object({
  feature: z.string().min(1),
  branch: z.string().optional(),
  agent: z.string().min(1),
  stories: z.union([
    z.array(z.string()),
    z.array(z.object({ title: z.string(), acceptance_criteria: z.array(z.string()).optional() })),
  ]).optional(),
  checks: z.array(z.string()).optional(),
});

export function devRoutes(
  planStore: DevPlanStore,
  processor: QueueProcessor,
  registry: AgentRegistry,
  memory: MemoryStore | undefined,
  config: NyxHiveConfig,
): Hono {
  const app = new Hono();

  // GET /api/dev/plans — list all plans
  app.get("/plans", canRead, (c) => {
    const status = c.req.query("status");
    const plans = planStore.listPlans(status as import("../../development/plan.js").PlanStatus | undefined);
    return c.json(plans);
  });

  // GET /api/dev/plans/:id — get plan with stories
  app.get("/plans/:id", canRead, (c) => {
    const plan = planStore.getPlan(c.req.param("id"));
    if (!plan) return c.json({ error: "Plan not found" }, 404);
    const stories = planStore.getStories(plan.id);
    const progress = planStore.getPlanProgress(plan.id);
    return c.json({ ...plan, stories, progress });
  });

  // POST /api/dev/plans — create a new plan
  app.post("/plans", adminOnly, async (c) => {
    const body = await parseBody(c, createPlanSchema);
    if (body instanceof Response) return body;

    if (!registry.get(body.agent)) {
      return c.json({ error: `Agent '${body.agent}' not found` }, 400);
    }

    const plan = planStore.createPlan({
      feature: body.feature,
      branch: body.branch || `feat/${body.feature.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}`,
      agent: body.agent,
      createdBy: "api",
      checks: body.checks,
    });

    if (body.stories) {
      const storyData = body.stories.map((s) =>
        typeof s === "string" ? { title: s } : { title: s.title, acceptance_criteria: s.acceptance_criteria },
      );
      planStore.addStories(plan.id, storyData);
    }

    return c.json(plan, 201);
  });

  // POST /api/dev/plans/:id/start — start or resume execution
  app.post("/plans/:id/start", adminOnly, (c) => {
    const plan = planStore.getPlan(c.req.param("id"));
    if (!plan) return c.json({ error: "Plan not found" }, 404);

    if (plan.status !== "planning" && plan.status !== "paused") {
      return c.json({ error: `Plan is ${plan.status}, can only start from planning/paused` }, 400);
    }

    planStore.updatePlanStatus(plan.id, "running");
    executeDevPlan(plan.id, { planStore, processor, registry, memory, config })
      .catch(err => logger.error(`[dev-loop] Plan ${plan.id} crashed: ${err}`));

    return c.json({ status: "running", plan_id: plan.id });
  });

  // POST /api/dev/plans/:id/pause — pause after current story
  app.post("/plans/:id/pause", adminOnly, (c) => {
    const plan = planStore.getPlan(c.req.param("id"));
    if (!plan) return c.json({ error: "Plan not found" }, 404);
    if (plan.status !== "running") return c.json({ error: `Plan is ${plan.status}` }, 400);
    planStore.updatePlanStatus(plan.id, "paused");
    return c.json({ status: "paused", plan_id: plan.id });
  });

  // POST /api/dev/plans/:id/skip/:storyId — skip a story
  app.post("/plans/:id/skip/:storyId", adminOnly, (c) => {
    const plan = planStore.getPlan(c.req.param("id"));
    if (!plan) return c.json({ error: "Plan not found" }, 404);
    planStore.skipStory(c.req.param("storyId"));
    return c.json({ status: "skipped", story_id: c.req.param("storyId") });
  });

  // DELETE /api/dev/plans/:id — cancel and clean up
  app.delete("/plans/:id", adminOnly, (c) => {
    const plan = planStore.getPlan(c.req.param("id"));
    if (!plan) return c.json({ error: "Plan not found" }, 404);
    planStore.deletePlan(plan.id);
    return c.json({ deleted: true, plan_id: plan.id });
  });

  return app;
}

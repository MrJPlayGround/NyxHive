import { Hono } from "hono";
import type { Scheduler } from "../../scheduler/index.js";
import { canRead } from "../middleware/rbac.js";

export function briefingRoutes(scheduler: Scheduler): Hono {
  const app = new Hono();

  // GET /api/briefing/latest — most recent compiled briefing
  app.get("/latest", canRead, (c) => {
    const result = scheduler.getTaskResult("briefing:daily");
    if (!result || !result.last_result) {
      return c.json({ error: "No briefing available yet" }, 404);
    }
    return c.json(result);
  });

  // GET /api/briefing/data — raw data for briefing compilation (last 24h)
  app.get("/data", canRead, (c) => {
    const since = Date.now() - 24 * 60 * 60 * 1000;
    const tasks = scheduler.listTasks(true);
    const recentTasks = tasks.filter((t) => t.last_run_at && t.last_run_at > since);

    return c.json({
      period_start: since,
      period_end: Date.now(),
      tasks: recentTasks.map((t) => ({
        name: t.name,
        agent: t.agent,
        category: t.category,
        status: t.last_status,
        last_run_at: t.last_run_at,
        result_preview: t.last_result?.substring(0, 300) ?? null,
      })),
    });
  });

  return app;
}

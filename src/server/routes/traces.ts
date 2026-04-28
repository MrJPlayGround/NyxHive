import { Hono } from "hono";
import type { TraceStore } from "../../memory/traces.js";
import { canRead } from "../middleware/rbac.js";

export function tracesRoutes(traces: TraceStore) {
  const app = new Hono();

  // GET / — list recent traces
  app.get("/", canRead, (c) => {
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 20), 1), 200);
    const status = c.req.query("status") ?? undefined;
    const recent = traces.getRecentTraces(limit, status);
    return c.json(recent);
  });

  // GET /:id — trace with all events
  app.get("/:id", canRead, (c) => {
    const id = c.req.param("id");
    const trace = traces.getTrace(id);
    if (!trace) return c.json({ error: "trace not found" }, 404);
    const events = traces.getTraceEvents(id);
    return c.json({ ...trace, events });
  });

  return app;
}

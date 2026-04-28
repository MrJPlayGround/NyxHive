import { Hono } from "hono";
import type { MemoryStore } from "../../memory/store.js";
import type { TraceStore } from "../../memory/traces.js";
import type { AgentRegistry } from "../../agents/registry.js";
import { canRead } from "../middleware/rbac.js";

export function usageRoutes(memory: MemoryStore, traces?: TraceStore, registry?: AgentRegistry): Hono {
  const app = new Hono();

  // GET /api/usage — usage summary
  app.get("/", canRead, (c) => {
    const hours = Number(c.req.query("hours") ?? 24);
    const summary = memory.getUsageSummary(hours);
    const total = memory.getTotalCost(hours);
    const actual = memory.getActualCost(hours);
    return c.json({ summary, total_cost: total, actual_cost: actual, period_hours: hours });
  });

  // GET /api/usage/metrics — cost, latency, error rates
  app.get("/metrics", canRead, (c) => {
    const hours = Number(c.req.query("hours") ?? 24);
    const totalCost = memory.getTotalCost(hours);
    const actualCost = memory.getActualCost(hours);
    const cost = {
      total_usd: totalCost,
      actual_usd: actualCost,
      by_model: memory.getUsageSummary(hours),
    };
    const performance = traces?.getMetrics(hours) ?? null;
    const agents = registry?.getStatsSummary() ?? null;
    return c.json({ period_hours: hours, cost, performance, agents });
  });

  // GET /api/usage/routing — model routing success rates and hint stats
  app.get("/routing", canRead, (c) => {
    if (!traces) return c.json({ error: "trace store not configured" }, 503);
    const hours = Number(c.req.query("hours") ?? 168);
    return c.json({
      period_hours: hours,
      success_rates: traces.getSuccessRates(hours),
      hint_stats: traces.getHintStats(hours),
    });
  });

  // GET /api/usage/agents — per-agent cost breakdown (time-windowed)
  app.get("/agents", canRead, (c) => {
    if (!traces) return c.json({ error: "trace store not configured" }, 503);
    const hours = Number(c.req.query("hours") ?? 168);
    const since = Date.now() - hours * 3600000;

    const breakdown = traces.getCostByAgent(since);
    // Filter to registry-known agents only (excludes cross-instance phantoms)
    const knownAgents = registry ? registry.getKnownAgentKeys() : null;
    const filtered = knownAgents ? breakdown.filter((a) => knownAgents.has(a.agent.toLowerCase())) : breakdown;
    const totalEstimated = Math.round(filtered.reduce((s, a) => s + a.total_cost, 0) * 10000) / 100;
    const totalActual = Math.round(filtered.reduce((s, a) => s + a.actual_cost, 0) * 10000) / 100;
    return c.json({
      period_hours: hours,
      agents: filtered.map((a) => ({
        agent: a.agent,
        invocations: a.count,
        total_cost_cents: Math.round(a.total_cost * 10000) / 100,
        actual_cost_cents: Math.round(a.actual_cost * 10000) / 100,
        total_tokens_in: a.tokens_in,
        total_tokens_out: a.tokens_out,
        avg_duration_ms: a.avg_duration,
        models_used: a.models,
        top_task_types: a.task_types,
      })),
      total_cost_cents: totalEstimated,
      actual_cost_cents: totalActual,
    });
  });

  return app;
}

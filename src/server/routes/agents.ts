import { Hono } from "hono";
import type { NyxHiveConfig, AgentConfig } from "../../types.js";
import type { AgentRegistry } from "../../agents/registry.js";
import type { TraceStore } from "../../memory/traces.js";
import { loadAndCompileSoul } from "../../soul/runtime.js";
import { adminOnly, canRead } from "../middleware/rbac.js";

export function agentsRoutes(
  config: NyxHiveConfig,
  registry?: AgentRegistry,
  traceStore?: TraceStore,
  instanceSoulsDir?: string,
): Hono {
  const app = new Hono();

  // GET /api/agents — list all agents (enabled + disabled)
  app.get("/", canRead, (c) => {
    const includeDisabled = c.req.query("all") === "true";

    if (registry) {
      const entries = registry.getAllEntries(includeDisabled);
      return c.json({
        agents: [...entries].map(([key, entry]) => ({
          id: key,
          name: entry.name,
          provider: entry.provider,
          model: (entry.min_model && entry.min_model === entry.max_model) ? entry.min_model : entry.model,
          min_model: entry.min_model ?? null,
          max_model: entry.max_model ?? null,
          role: entry.role,
          enabled: entry.enabled,
          created_by: entry.created_by,
          working_directory: entry.working_directory,
          total_invocations: entry.total_invocations,
          estimated_cost_cents: entry.estimated_cost_cents,
          last_invoked_at: entry.last_invoked_at,
        })),
      });
    }

    // Fallback: no registry, use config
    return c.json({
      agents: Object.entries(config.agents).map(([key, a]) => ({
        id: key,
        name: a.name,
        provider: a.provider,
        model: (a.min_model && a.min_model === a.max_model) ? a.min_model : a.model,
        cli_fallback: a.cli_fallback,
        working_directory: a.working_directory,
      })),
    });
  });

  // GET /api/agents/:id — get a specific agent
  app.get("/:id", canRead, (c) => {
    const id = c.req.param("id");

    if (registry) {
      const entry = registry.getEntry(id);
      if (!entry) return c.json({ error: "agent not found" }, 404);
      const displayModel = (entry.min_model && entry.min_model === entry.max_model) ? entry.min_model : entry.model;
      return c.json({ id, ...entry, model: displayModel });
    }

    const agent = config.agents[id];
    if (!agent) return c.json({ error: "agent not found" }, 404);
    const displayModel = (agent.min_model && agent.min_model === agent.max_model) ? agent.min_model : agent.model;
    return c.json({ id, ...agent, model: displayModel });
  });

  // GET /api/agents/:id/stats — get agent performance stats
  app.get("/:id/stats", canRead, (c) => {
    if (!registry) return c.json({ error: "registry not available" }, 501);
    const id = c.req.param("id");
    const stats = registry.getStats(id);
    if (!stats) return c.json({ error: "agent not found" }, 404);
    return c.json(stats);
  });

  // GET /api/agents/stats/summary — get summary across all agents
  app.get("/stats/summary", canRead, (c) => {
    if (!registry) return c.json({ error: "registry not available" }, 501);
    return c.json(registry.getStatsSummary());
  });

  // POST /api/agents — create a new agent
  app.post("/", adminOnly, async (c) => {
    if (!registry) return c.json({ error: "registry not available" }, 501);

    const body = await c.req.json<{
      key: string;
      name: string;
      provider?: string;
      model?: string;
      system_prompt?: string;
      capabilities?: string[];
      always_cli?: boolean;
      agentic_mode?: AgentConfig["agentic_mode"];
      working_directory?: string;
    }>();

    if (!body.key || !body.name) {
      return c.json({ error: "key and name are required" }, 400);
    }

    const result = registry.create(body.key, {
      name: body.name,
      provider: body.provider,
      model: body.model,
      system_prompt: body.system_prompt,
      capabilities: body.capabilities,
      always_cli: body.always_cli,
      agentic_mode: body.agentic_mode,
      working_directory: body.working_directory,
    }, "api");

    if (!result.success) return c.json({ error: result.error }, 400);
    return c.json({ id: body.key, status: "created" }, 201);
  });

  // PATCH /api/agents/:id — update agent fields
  app.patch("/:id", adminOnly, async (c) => {
    if (!registry) return c.json({ error: "registry not available" }, 501);

    const id = c.req.param("id");
    const body = await c.req.json<Partial<AgentConfig & { role?: string }>>();

    const result = registry.update(id, body as any);
    if (!result.success) return c.json({ error: result.error }, 400);
    return c.json({ id, status: "updated" });
  });

  // DELETE /api/agents/:id — disable agent (soft-delete)
  app.delete("/:id", adminOnly, (c) => {
    if (!registry) return c.json({ error: "registry not available" }, 501);

    const id = c.req.param("id");
    const result = registry.disable(id);
    if (!result.success) return c.json({ error: result.error }, 400);
    return c.json({ id, status: "disabled" });
  });

  // POST /api/agents/:id/enable — re-enable a disabled agent
  app.post("/:id/enable", adminOnly, (c) => {
    if (!registry) return c.json({ error: "registry not available" }, 501);

    const id = c.req.param("id");
    const result = registry.enable(id);
    if (!result.success) return c.json({ error: result.error }, 400);
    return c.json({ id, status: "enabled" });
  });

  // GET /api/agents/:id/soul — compiled soul for an agent
  app.get("/:id/soul", canRead, (c) => {
    const agentKey = c.req.param("id");

    if (registry) {
      const entry = registry.getEntry(agentKey);
      if (!entry) return c.json({ error: "agent not found" }, 404);
    } else if (!config.agents[agentKey]) {
      return c.json({ error: "agent not found" }, 404);
    }

    try {
      const soul = loadAndCompileSoul(agentKey, undefined, instanceSoulsDir);
      if (!soul) return c.json({ error: "no soul configured for this agent" }, 404);

      return c.json({
        agent: agentKey,
        identity: soul.identity,
        voice: soul.voice,
        capabilities: soul.capabilities,
        rules: soul.rules,
        context: soul.context,
        model_capabilities: soul.model_capabilities,
        extras: soul.extras,
      });
    } catch (err) {
      return c.json({ error: `soul compilation failed: ${err}` }, 500);
    }
  });

  // GET /api/agents/:id/history — recent trace events for an agent
  app.get("/:id/history", canRead, (c) => {
    if (!traceStore) return c.json({ error: "trace store not available" }, 503);

    const agentKey = c.req.param("id");
    const limit = Math.min(Number.parseInt(c.req.query("limit") || "20"), 100);

    const events = traceStore.getAgentEvents(agentKey, limit);
    return c.json({
      agent: agentKey,
      events: events.map((e) => ({
        id: e.id,
        trace_id: e.trace_id,
        task: e.task,
        status: e.status,
        model: e.model,
        task_type: e.task_type,
        tokens_in: e.tokens_in,
        tokens_out: e.tokens_out,
        cost: e.cost,
        duration_ms: e.duration_ms,
        started_at: e.started_at,
        completed_at: e.completed_at,
      })),
    });
  });

  return app;
}

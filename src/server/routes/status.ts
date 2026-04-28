import { Hono } from "hono";
import type { QueueProcessor } from "../../queue/processor.js";
import type { TraceStore } from "../../memory/traces.js";
import type { NyxHiveConfig } from "../../types.js";
import { canRead } from "../middleware/rbac.js";
import { describeServerContract } from "../urls.js";
import { collectGatewayHealth, type GatewayHealthDeps } from "../gateway-health.js";
import { buildCapabilitySnapshot } from "../../capabilities/snapshot.js";
import { clampInt } from "../../utils/parse.js";

export function statusRoutes(
  processor: QueueProcessor,
  traces?: TraceStore,
  config?: NyxHiveConfig,
  healthDeps?: GatewayHealthDeps,
): Hono {
  const app = new Hono();

  app.get("/active", canRead, (c) => {
    const delegations = Array.from(processor.getActiveDelegations().entries()).map(([key, d]) => ({
      key,
      agent: d.agent,
      task: d.task,
      from_agent: d.fromAgent,
      dispatched_at: d.dispatchedAt,
      elapsed_ms: Date.now() - d.dispatchedAt,
    }));

    const runningTraces = traces?.getRecentTraces(10, "running") ?? [];

    return c.json({
      delegations,
      running_traces: runningTraces.map((t) => ({
        id: t.id,
        agent_count: t.agent_count,
        input_message: t.input_message?.substring(0, 100),
        sender: t.sender,
        channel: t.channel,
        created_at: t.created_at,
        elapsed_ms: Date.now() - t.created_at,
      })),
      server: config ? describeServerContract(config) : undefined,
      timestamp: Date.now(),
    });
  });

  app.get("/doctor", canRead, (c) => {
    if (!healthDeps) {
      return c.json({ status: "error", error: "Gateway diagnostics not configured", timestamp: Date.now() }, 500);
    }
    const report = collectGatewayHealth(healthDeps);
    return c.json(report, report.status === "error" ? 503 : 200);
  });

  app.get("/capabilities", canRead, (c) => {
    const snapshotConfig = config ?? healthDeps?.config;
    if (!snapshotConfig) {
      return c.json({ error: "Capability snapshot requires runtime config" }, 500);
    }

    return c.json(buildCapabilitySnapshot({
      config: snapshotConfig,
      providerRouter: healthDeps?.providerRouter,
      channels: processor.getChannels?.() ?? [],
      queueAvailable: Boolean(healthDeps?.queue),
      blockedPathReportsAvailable: Boolean(healthDeps?.runs),
      artifactStoreAvailable: Boolean(healthDeps?.runs),
    }));
  });

  app.get("/artifacts", canRead, (c) => {
    const runs = healthDeps?.runs;
    if (!runs) {
      return c.json({ error: "Artifact diagnostics require run storage" }, 500);
    }

    const limit = clampInt(c.req.query("limit"), 100, 1, 500);
    return c.json({
      artifacts: runs.listArtifacts({
        run_id: c.req.query("run_id") ?? undefined,
        message_id: c.req.query("message_id") ?? undefined,
        channel: c.req.query("channel") ?? undefined,
        limit,
      }),
    });
  });

  return app;
}

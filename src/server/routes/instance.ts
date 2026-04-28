import { Hono } from "hono";
import type { NyxHiveConfig } from "../../types.js";
import type { AgentRegistry } from "../../agents/registry.js";
import { describeServerContract } from "../urls.js";

export function instanceRoutes(config: NyxHiveConfig, registry?: AgentRegistry): Hono {
  const app = new Hono();

  // GET /instance — Public discovery endpoint (no auth)
  app.get("/", (c) => {
    // Build agent list from registry (enabled only) or config fallback
    const agents = registry
      ? [...registry.getAllEntries(false)].map(([key, entry]) => ({
          key,
          name: entry.name,
          role: entry.role ?? "worker",
        }))
      : Object.entries(config.agents).map(([key, a]) => ({
          key,
          name: a.name,
          role: a.role ?? "worker",
        }));

    return c.json({
      name: config.daemon.name,
      description: "Multi-agent AI lead platform",
      version: "0.1.0",
      agents,
      server: describeServerContract(config),
      features: {
        threads: true,
        parallel: true,
        git: false,
        automations: !!config.scheduler?.enabled,
      },
    });
  });

  return app;
}

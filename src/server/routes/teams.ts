import { Hono } from "hono";
import type { NyxHiveConfig } from "../../types.js";
import { canRead } from "../middleware/rbac.js";

export function teamsRoutes(config: NyxHiveConfig): Hono {
  const app = new Hono();

  // GET /api/teams — list all teams
  app.get("/", canRead, (c) => {
    return c.json(
      Object.entries(config.teams ?? {}).map(([key, t]) => ({
        id: key,
        name: t.name,
        agents: t.agents,
        description: t.description,
      })),
    );
  });

  // GET /api/teams/:id — get a specific team
  app.get("/:id", canRead, (c) => {
    const id = c.req.param("id");
    const team = config.teams?.[id];
    if (!team) {
      return c.json({ error: "team not found" }, 404);
    }
    return c.json({ id, ...team });
  });

  return app;
}

import { Hono } from "hono";
import type { OutcomeStore } from "../../memory/outcomes.js";
import { canRead } from "../middleware/rbac.js";

export function outcomeRoutes(outcomes: OutcomeStore): Hono {
  const app = new Hono();

  // GET /api/outcomes — query outcomes with filters
  app.get("/", canRead, (c) => {
    const agent = c.req.query("agent");
    const outcome = c.req.query("outcome") as "success" | "partial" | "failed" | "abandoned" | undefined;
    const since = c.req.query("since");
    const until = c.req.query("until");
    const limit = c.req.query("limit") ? Number(c.req.query("limit")) : undefined;

    return c.json(outcomes.query({ agent, outcome, since, until, limit }));
  });

  // GET /api/outcomes/stats — aggregate stats by agent
  app.get("/stats", canRead, (c) => {
    const since = c.req.query("since");
    return c.json(outcomes.getAgentStats(since ?? undefined));
  });

  // GET /api/outcomes/proposal/:id — outcomes for a specific proposal
  app.get("/proposal/:id", canRead, (c) => {
    const id = c.req.param("id");
    const proposalId = id.startsWith("proposal-") ? id : `proposal-${id}`;
    return c.json(outcomes.getByProposal(proposalId));
  });

  // GET /api/outcomes/unmerged — PRs pending merge check
  app.get("/unmerged", canRead, (c) => {
    return c.json(outcomes.listUnmergedPRs());
  });

  return app;
}

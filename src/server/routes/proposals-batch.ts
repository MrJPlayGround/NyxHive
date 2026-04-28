import { Hono } from "hono";
import type { ProposalStore, ProposalCategory, ProposalAutonomy } from "../../proposals/store.js";
import { logger } from "../../utils/logger.js";
import { canWrite } from "../middleware/rbac.js";

interface BatchRequestBody {
  action: "approve" | "reject";
  filter?: {
    category?: string;
    max_autonomy?: string;
    older_than_days?: number;
  };
  reason?: string;
  approved_by?: string;
}

export function proposalsBatchRoutes(proposalStore: ProposalStore): Hono {
  const app = new Hono();

  app.post("/", canWrite, async (c) => {
    const body = await c.req.json<BatchRequestBody>();

    if (!body.action || !["approve", "reject"].includes(body.action)) {
      return c.json({ error: "action must be 'approve' or 'reject'" }, 400);
    }

    if (body.action === "approve") {
      const result = proposalStore.batchApprove({
        category: body.filter?.category as ProposalCategory | undefined,
        maxAutonomy: body.filter?.max_autonomy as ProposalAutonomy | undefined,
        approvedBy: body.approved_by ?? "batch-api",
      });
      logger.info(`[batch] Approved ${result.count} proposals via API`);
      return c.json({ action: "approve", ...result });
    }

    // reject
    if (!body.reason) {
      return c.json({ error: "reason required for batch reject" }, 400);
    }
    const result = proposalStore.batchReject({
      category: body.filter?.category as ProposalCategory | undefined,
      olderThanMs: body.filter?.older_than_days
        ? body.filter.older_than_days * 24 * 60 * 60 * 1000
        : undefined,
      reason: body.reason,
    });
    logger.info(`[batch] Rejected ${result.count} proposals via API: ${body.reason}`);
    return c.json({ action: "reject", ...result });
  });

  return app;
}

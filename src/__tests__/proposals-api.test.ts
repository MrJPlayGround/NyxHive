import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import { proposalRoutes } from "../server/routes/proposals.js";
import { ProposalStore } from "../proposals/store.js";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import type { AuthEnv } from "../auth/types.js";

function withAuth(routes: Hono, basePath: string): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.use("/*", async (c, next) => {
    c.set("auth" as never, { type: "api_key", role: "owner" } as never);
    return next();
  });
  app.route(basePath, routes);
  return app;
}

describe("Proposal API routes", () => {
  let store: ProposalStore;
  let app: Hono<AuthEnv>;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "proposal-api-test-"));
    store = new ProposalStore(tmpDir, "test");
    app = withAuth(proposalRoutes(store), "/api/proposals");
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("GET /api/proposals returns empty list", async () => {
    const res = await app.request("/api/proposals");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  test("POST /api/proposals creates a proposal", async () => {
    const res = await app.request("/api/proposals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Test", description: "Desc", category: "maintenance", proposed_by: "nyx" }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.proposal.title).toBe("Test");
  });

  test("POST /api/proposals rejects missing fields", async () => {
    const res = await app.request("/api/proposals", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Test" }),
    });
    expect(res.status).toBe(400);
  });

  test("GET /api/proposals/:id returns proposal", async () => {
    const p = store.create({ title: "T", description: "D", category: "feature", proposed_by: "nyx" });
    const shortId = p.proposal_id.replace("proposal-", "");
    const res = await app.request(`/api/proposals/${shortId}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.title).toBe("T");
  });

  test("GET /api/proposals/:id returns 404 for unknown", async () => {
    const res = await app.request("/api/proposals/00000000");
    expect(res.status).toBe(404);
  });

  test("POST /api/proposals/:id/approve approves", async () => {
    const p = store.create({ title: "T", description: "D", category: "feature", proposed_by: "nyx" });
    const shortId = p.proposal_id.replace("proposal-", "");
    const res = await app.request(`/api/proposals/${shortId}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approved_by: "jay" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.proposal.status).toBe("approved");
  });

  test("POST /api/proposals/:id/reject rejects with reason", async () => {
    const p = store.create({ title: "T", description: "D", category: "feature", proposed_by: "nyx" });
    const shortId = p.proposal_id.replace("proposal-", "");
    const res = await app.request(`/api/proposals/${shortId}/reject`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "Not needed" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.proposal.status).toBe("rejected");
    expect(body.proposal.rejection_reason).toBe("Not needed");
  });

  test("POST /api/proposals/:id/reject emits proposal:rejected event via processor", async () => {
    const emitted: Array<{ type: string; data: Record<string, unknown> }> = [];
    const mockProcessor = {
      emitEvent: (type: string, data: Record<string, unknown>) => { emitted.push({ type, data }); },
    };
    const appWithProcessor = withAuth(proposalRoutes(store, mockProcessor as any), "/api/proposals");

    const p = store.create({ title: "Reject Me", description: "D", category: "maintenance", proposed_by: "scout" });
    const shortId = p.proposal_id.replace("proposal-", "");
    const res = await appWithProcessor.request(`/api/proposals/${shortId}/reject`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "Too complex" }),
    });
    expect(res.status).toBe(200);
    expect(emitted).toHaveLength(1);
    expect(emitted[0].type).toBe("proposal:rejected");
    expect(emitted[0].data.proposal_id).toBe(p.proposal_id);
    expect(emitted[0].data.reason).toBe("Too complex");
    expect(emitted[0].data.proposed_by).toBe("scout");
  });

  test("GET /api/proposals/stats returns counts", async () => {
    store.create({ title: "A", description: "D", category: "maintenance", proposed_by: "nyx" });
    store.create({ title: "B", description: "D", category: "feature", proposed_by: "nyx" });
    const res = await app.request("/api/proposals/stats");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.total).toBe(2);
    expect(body.pending).toBe(2);
  });

  test("GET /api/proposals/pending returns only pending approvals", async () => {
    store.create({ title: "A", description: "D", category: "maintenance", proposed_by: "nyx", autonomy: "auto" });
    store.create({ title: "B", description: "D", category: "feature", proposed_by: "nyx" });
    const res = await app.request("/api/proposals/pending");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].title).toBe("B");
  });

  test("DELETE /api/proposals/:id deletes", async () => {
    const p = store.create({ title: "T", description: "D", category: "maintenance", proposed_by: "nyx" });
    const shortId = p.proposal_id.replace("proposal-", "");
    const res = await app.request(`/api/proposals/${shortId}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(store.get(p.proposal_id)).toBeNull();
  });

  test("GET /api/proposals filters by status", async () => {
    const p = store.create({ title: "A", description: "D", category: "feature", proposed_by: "nyx" });
    store.approve(p.proposal_id, "jay");
    store.create({ title: "B", description: "D", category: "feature", proposed_by: "nyx" });
    const res = await app.request("/api/proposals?status=approved");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
    expect(body[0].title).toBe("A");
  });

  test("DELETE /api/proposals/terminal bulk-deletes terminal proposals", async () => {
    // Create proposals in various states
    const p1 = store.create({ title: "Rejected", description: "D", category: "feature", proposed_by: "nyx" });
    store.reject(p1.proposal_id, "nah");

    const p2 = store.create({ title: "Failed", description: "D", category: "feature", proposed_by: "nyx" });
    store.markExecuting(p2.proposal_id, "ref");
    store.markFailed(p2.proposal_id, "error");

    const p3 = store.create({ title: "Active", description: "D", category: "feature", proposed_by: "nyx" });

    const p4 = store.create({ title: "Completed", description: "D", category: "feature", proposed_by: "nyx" });
    store.markExecuting(p4.proposal_id, "ref");
    store.markCompleted(p4.proposal_id, "done", "forge");

    const res = await app.request("/api/proposals/terminal", { method: "DELETE" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.deleted).toBe(2); // rejected + failed

    // Active and completed should remain
    const remaining = store.list();
    expect(remaining).toHaveLength(2);
    expect(remaining.map(p => p.title).sort()).toEqual(["Active", "Completed"]);
  });

  test("POST /api/proposals/:id/review uses resolved review agent", async () => {
    const p = store.create({ title: "Review Me", description: "D", category: "feature", proposed_by: "nyx" });
    const shortId = p.proposal_id.replace("proposal-", "");
    let reviewAgent = "";
    let clearedChannel = "";
    let clearedSender = "";
    const mockProcessor = {
      resolveReviewAgent: (preferred: string[]) => {
        expect(preferred).toEqual(["nyx", "analyst"]);
        return "vortex";
      },
      resolveProposalReviewModel: (preferred: string[]) => {
        expect(preferred).toEqual(["nyx", "analyst"]);
        return "claude-opus-4-6";
      },
      processImmediate: async (opts: { agent?: string; modelOverride?: string }) => {
        reviewAgent = opts.agent ?? "";
        expect(opts.modelOverride).toBe("claude-opus-4-6");
        return { message_id: "msg-1", response: "**Verdict: APPROVE**", agent: "vortex" };
      },
      clearConversation: (channel: string, sender: string) => {
        clearedChannel = channel;
        clearedSender = sender;
      },
      emitEvent: () => {},
    };
    const appWithProcessor = withAuth(proposalRoutes(store, mockProcessor as any), "/api/proposals");

    const res = await appWithProcessor.request(`/api/proposals/${shortId}/review`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(reviewAgent).toBe("vortex");
    expect(clearedChannel).toBe("system");
    expect(clearedSender).toBe(`proposal-review:${p.proposal_id}`);
    const reviewed = store.get(p.proposal_id);
    expect(reviewed?.status).toBe("reviewed");
    expect(reviewed?.reviewed_by).toBe("vortex");
    expect(reviewed?.review_result).toBe("**Verdict: APPROVE**");
  });

  test("POST /api/proposals/:id/review rejects non-reviewable status", async () => {
    const p = store.create({ title: "Review Me", description: "D", category: "feature", proposed_by: "nyx" });
    store.approve(p.proposal_id, "jay");
    const shortId = p.proposal_id.replace("proposal-", "");

    const res = await app.request(`/api/proposals/${shortId}/review`, { method: "POST" });
    expect(res.status).toBe(400);
  });

  test("POST /api/proposals/:id/review rejects re-review when a completed review already exists", async () => {
    const p = store.create({ title: "Review Me", description: "D", category: "feature", proposed_by: "nyx" });
    store.markReviewing(p.proposal_id);
    store.saveReview(p.proposal_id, "**Verdict: APPROVE**\n**Why:** Solid.", "nyx");
    const shortId = p.proposal_id.replace("proposal-", "");

    const res = await app.request(`/api/proposals/${shortId}/review`, { method: "POST" });
    expect(res.status).toBe(409);
  });

  test("POST /api/proposals/:id/review allows retry after failed review", async () => {
    const p = store.create({ title: "Review Me", description: "D", category: "feature", proposed_by: "nyx" });
    store.markReviewing(p.proposal_id);
    store.saveReview(p.proposal_id, "Review failed: timeout", "system");
    const shortId = p.proposal_id.replace("proposal-", "");
    let calls = 0;
    const mockProcessor = {
      resolveReviewAgent: () => "vortex",
      resolveProposalReviewModel: () => "gpt-5.4",
      processImmediate: async () => {
        calls += 1;
        return { message_id: "msg-1", response: "**Verdict: APPROVE**", agent: "vortex" };
      },
      clearConversation: () => {},
      emitEvent: () => {},
    };
    const appWithProcessor = withAuth(proposalRoutes(store, mockProcessor as any), "/api/proposals");

    const res = await appWithProcessor.request(`/api/proposals/${shortId}/review`, { method: "POST" });
    expect(res.status).toBe(200);
    expect(calls).toBe(1);
  });
});

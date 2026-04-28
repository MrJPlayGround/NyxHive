import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AuthEnv } from "../auth/types.js";
import { ProceduralSkillDraftStore } from "../memory/procedural-skills.js";
import { proceduralSkillsRoutes } from "../server/routes/procedural-skills.js";

function withAuth(role: "owner" | "viewer"): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.use("/*", async (c, next) => {
    c.set("auth" as never, { type: "api_key", role } as never);
    return next();
  });
  return app;
}

describe("procedural skill routes", () => {
  let store: ProceduralSkillDraftStore;
  let app: Hono<AuthEnv>;
  let skillsDir: string;
  let previousSkillsDir: string | undefined;
  let previousGeneratedSkillsDir: string | undefined;

  beforeEach(() => {
    store = new ProceduralSkillDraftStore(new Database(":memory:"));
    skillsDir = mkdtempSync(join(tmpdir(), "nyxhive-procedural-routes-"));
    previousSkillsDir = process.env.NYXHIVE_SKILLS_DIR;
    previousGeneratedSkillsDir = process.env.NYXHIVE_GENERATED_SKILLS_DIR;
    process.env.NYXHIVE_SKILLS_DIR = join(skillsDir, "curated");
    process.env.NYXHIVE_GENERATED_SKILLS_DIR = join(skillsDir, "generated");

    app = withAuth("owner");
    app.route("/api/skills/procedural", proceduralSkillsRoutes(store));
  });

  afterEach(() => {
    if (previousSkillsDir === undefined) delete process.env.NYXHIVE_SKILLS_DIR;
    else process.env.NYXHIVE_SKILLS_DIR = previousSkillsDir;
    if (previousGeneratedSkillsDir === undefined) delete process.env.NYXHIVE_GENERATED_SKILLS_DIR;
    else process.env.NYXHIVE_GENERATED_SKILLS_DIR = previousGeneratedSkillsDir;
    rmSync(skillsDir, { recursive: true, force: true });
  });

  test("lists drafts with optional status filtering", async () => {
    const draftA = store.create({
      sourceHash: "route-hash-a",
      agentKey: "nyx",
      title: "Workflow: Fix reconnect churn",
      summary: "Reconnect churn workflow.",
      draftMarkdown: "# Reconnect churn",
    });
    const draftB = store.create({
      sourceHash: "route-hash-b",
      agentKey: "forge",
      title: "Workflow: Audit relay callback identity",
      summary: "Relay callback workflow.",
      draftMarkdown: "# Relay callback",
    });
    store.publish(draftB.id, "auto-relay-callback");

    const res = await app.request("/api/skills/procedural?status=draft&agent=nyx");
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.total).toBe(1);
    expect(body.drafts[0].id).toBe(draftA.id);
    expect(body.drafts[0].status).toBe("draft");
  });

  test("filters and sorts audit candidates by query and outcome health", async () => {
    const weak = store.create({
      sourceHash: "route-hash-weak",
      agentKey: "nyx",
      title: "Workflow: generic verification loop",
      summary: "Too generic to keep steering runs.",
      draftMarkdown: "# Generic verification",
    });
    const healthy = store.create({
      sourceHash: "route-hash-healthy",
      agentKey: "nyx",
      title: "Workflow: stabilize relay callback identity",
      summary: "Relay callback workflow.",
      draftMarkdown: "# Relay callback",
    });
    store.publish(weak.id, "auto-generic-verify");
    store.publish(healthy.id, "auto-relay-callback");
    store.recordUsage(weak.id);
    store.recordUsage(weak.id);
    store.recordUsage(weak.id);
    store.recordUsage(healthy.id);
    store.recordUsage(healthy.id);
    store.recordSuccess(healthy.id);
    store.recordSuccess(healthy.id);

    const res = await app.request("/api/skills/procedural?status=published&audit=true&query=generic&sort=needs_audit");
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.total).toBe(1);
    expect(body.drafts[0].id).toBe(weak.id);
    expect(body.drafts[0].published_skill_name).toBe("auto-generic-verify");
  });

  test("publishes a draft into an auto skill", async () => {
    const draft = store.create({
      sourceHash: "route-hash-publish",
      agentKey: "nyx",
      title: "Workflow: Stabilize cockpit reconnect path",
      summary: "Reconnect workflow.",
      draftMarkdown: "# Stabilize cockpit reconnect path",
    });

    const res = await app.request(`/api/skills/procedural/${draft.id}/publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skill_name: "auto-cockpit-reconnect" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.status).toBe("published");
    expect(body.skill_name).toBe("auto-cockpit-reconnect");
    expect(store.getById(draft.id)?.status).toBe("published");
  });

  test("bulk rejects audited published skills", async () => {
    const weak = store.create({
      sourceHash: "route-hash-bulk-weak",
      agentKey: "nyx",
      title: "Workflow: generic verification loop",
      summary: "Too generic to keep.",
      draftMarkdown: "# Generic verification",
    });
    const healthy = store.create({
      sourceHash: "route-hash-bulk-healthy",
      agentKey: "nyx",
      title: "Workflow: relay callback identity",
      summary: "Healthy workflow.",
      draftMarkdown: "# Relay callback",
    });
    store.publish(weak.id, "auto-generic-verify");
    store.publish(healthy.id, "auto-relay-callback");
    store.recordUsage(weak.id);
    store.recordUsage(weak.id);
    store.recordUsage(weak.id);
    store.recordUsage(healthy.id);
    store.recordSuccess(healthy.id);

    const res = await app.request("/api/skills/procedural/audit/reject", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids: [weak.id, healthy.id] }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.rejected_ids).toEqual([weak.id]);
    expect(store.getById(weak.id)?.status).toBe("rejected");
    expect(store.getById(healthy.id)?.status).toBe("published");
  });

  test("rejects a draft with a reason", async () => {
    const draft = store.create({
      sourceHash: "route-hash-reject",
      agentKey: "nyx",
      title: "Workflow: Update a one-off note",
      summary: "Too narrow to keep.",
      draftMarkdown: "# Update note",
    });

    const res = await app.request(`/api/skills/procedural/${draft.id}/reject`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reason: "too narrow for a reusable engineering skill" }),
    });

    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.status).toBe("rejected");
    expect(body.rejected_reason).toContain("too narrow");
  });

  test("blocks viewer role from publishing drafts", async () => {
    const viewerApp = withAuth("viewer");
    viewerApp.route("/api/skills/procedural", proceduralSkillsRoutes(store));
    const draft = store.create({
      sourceHash: "route-hash-viewer",
      agentKey: "nyx",
      title: "Workflow: Block viewer writes",
      summary: "Viewer should not publish.",
      draftMarkdown: "# Block viewer writes",
    });

    const res = await viewerApp.request(`/api/skills/procedural/${draft.id}/publish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(403);
  });
});

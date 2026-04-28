import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { ProposalStore } from "../proposals/store.js";
import { QueueDB } from "../queue/db.js";
import { QueueProcessor, parseProposalCommand } from "../queue/processor.js";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("Proposal execution tracking", () => {
  let store: ProposalStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "approval-test-"));
    store = new ProposalStore(tmpDir, "test");
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("markExecuting sets execution_ref and status", () => {
    const p = store.create({
      title: "Fix broken test",
      description: "The login test flakes under load",
      category: "bugfix",
      proposed_by: "nyx",
    });
    store.approve(p.proposal_id, "jay");
    store.markExecuting(p.proposal_id, `exec-${p.proposal_id}`);
    const updated = store.get(p.proposal_id);
    expect(updated!.status).toBe("executing");
    expect(updated!.execution_ref).toBe(`exec-${p.proposal_id}`);
  });

  test("markCompleted after execution transitions to completed", () => {
    const p = store.create({
      title: "Refactor utils",
      description: "Split large file",
      category: "maintenance",
      proposed_by: "forge",
    });
    store.approve(p.proposal_id, "jay");
    store.markExecuting(p.proposal_id, "exec-ref");
    store.markCompleted(p.proposal_id);
    expect(store.get(p.proposal_id)!.status).toBe("completed");
  });

  test("markFailed after execution transitions to failed", () => {
    const p = store.create({
      title: "Add feature",
      description: "New endpoint",
      category: "feature",
      proposed_by: "nyx",
    });
    store.approve(p.proposal_id, "jay");
    store.markExecuting(p.proposal_id, "exec-ref");
    store.markFailed(p.proposal_id);
    expect(store.get(p.proposal_id)!.status).toBe("failed");
  });

  test("full lifecycle: proposed → approved → executing → completed", () => {
    const p = store.create({
      title: "Lifecycle test",
      description: "Testing full flow",
      category: "maintenance",
      proposed_by: "nyx",
    });
    expect(p.status).toBe("proposed");

    const approved = store.approve(p.proposal_id, "jay");
    expect(approved!.status).toBe("approved");

    store.markExecuting(p.proposal_id, "exec-123");
    expect(store.get(p.proposal_id)!.status).toBe("executing");

    store.markCompleted(p.proposal_id);
    expect(store.get(p.proposal_id)!.status).toBe("completed");
  });
});

describe("resolveProposalAgent", () => {
  let proc: QueueProcessor;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "agent-routing-test-"));
    const queue = new QueueDB(tmpDir);
    proc = new QueueProcessor(queue, {
      agents: {
        nyx: { name: "Nyx", provider: "test", model: "test", working_directory: tmpDir, role: "lead" },
        analyst: { name: "Analyst", provider: "test", model: "test", working_directory: tmpDir, role: "expert" },
        tester: { name: "Tester", provider: "test", model: "test", working_directory: tmpDir, role: "worker" },
      },
      teams: {},
      baseDir: tmpDir,
    });
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("maintenance + code files routes to lead (nyx)", () => {
    const agent = (proc as any).resolveProposalAgent("maintenance", ["src/utils/logger.ts"]);
    expect(agent).toBe("nyx");
  });

  test("bugfix + code files routes to lead (nyx)", () => {
    const agent = (proc as any).resolveProposalAgent("bugfix", ["src/queue/processor.ts"]);
    expect(agent).toBe("nyx");
  });

  test("feature routes to lead (nyx)", () => {
    const agent = (proc as any).resolveProposalAgent("feature", ["src/new-feature.ts"]);
    expect(agent).toBe("nyx");
  });

  test("test routes to lead (nyx)", () => {
    const agent = (proc as any).resolveProposalAgent("test", ["src/__tests__/foo.test.ts"]);
    expect(agent).toBe("nyx");
  });

  test("improvement routes to lead (nyx)", () => {
    const agent = (proc as any).resolveProposalAgent("improvement", ["docs/api.md"]);
    expect(agent).toBe("nyx");
  });

  test("new_instance routes to orchestrator (nyx)", () => {
    const agent = (proc as any).resolveProposalAgent("new_instance", []);
    expect(agent).toBe("nyx");
  });

  test("configuration routes to orchestrator (nyx)", () => {
    const agent = (proc as any).resolveProposalAgent("configuration", []);
    expect(agent).toBe("nyx");
  });

  test("fallback: no coder agent routes to lead/orchestrator", () => {
    const tmpDir2 = mkdtempSync(join(tmpdir(), "agent-routing-fallback-"));
    const queue2 = new QueueDB(tmpDir2);
    const proc2 = new QueueProcessor(queue2, {
      agents: {
        nyx: { name: "Nyx", provider: "test", model: "test", working_directory: tmpDir2, role: "lead" },
        analyst: { name: "Analyst", provider: "test", model: "test", working_directory: tmpDir2, role: "expert" },
      },
      teams: {},
      baseDir: tmpDir2,
    });
    const agent = (proc2 as any).resolveProposalAgent("bugfix", ["src/foo.ts"]);
    expect(agent).toBe("nyx");
    rmSync(tmpDir2, { recursive: true, force: true });
  });
});

describe("resolveReviewAgent", () => {
  test("prefers the requested review agent when it exists", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "review-agent-pref-"));
    const queue = new QueueDB(tmpDir);
    const proc = new QueueProcessor(queue, {
      agents: {
        nyx: { name: "Nyx", provider: "test", model: "test", working_directory: tmpDir, role: "lead" },
        analyst: { name: "Analyst", provider: "test", model: "test", working_directory: tmpDir, role: "worker" },
      },
      teams: {},
      baseDir: tmpDir,
    });

    expect(proc.resolveReviewAgent(["nyx", "analyst"])).toBe("nyx");
    expect(proc.resolveReviewAgent(["analyst"])).toBe("analyst");

    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("falls back to the lead agent when preferred keys are missing", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "review-agent-fallback-"));
    const queue = new QueueDB(tmpDir);
    const proc = new QueueProcessor(queue, {
      agents: {
        vortex: { name: "Vortex", provider: "test", model: "test", working_directory: tmpDir, role: "lead" },
        tester: { name: "Tester", provider: "test", model: "test", working_directory: tmpDir, role: "worker" },
      },
      teams: {},
      baseDir: tmpDir,
    });

    expect(proc.resolveReviewAgent(["nyx", "analyst"])).toBe("vortex");

    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("prefers a reviewer role before the lead fallback", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "review-agent-reviewer-"));
    const queue = new QueueDB(tmpDir);
    const proc = new QueueProcessor(queue, {
      agents: {
        nyx: { name: "Nyx", provider: "test", model: "test", working_directory: tmpDir, role: "lead" },
        vigil: { name: "Vigil", provider: "test", model: "test", working_directory: tmpDir, role: "reviewer" },
      },
      teams: {},
      baseDir: tmpDir,
    });

    expect(proc.resolveReviewAgent(["analyst"])).toBe("vigil");

    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("defaults proposal review to the active Claude brain instead of silently escalating", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "review-model-anthropic-"));
    const queue = new QueueDB(tmpDir);
    const proc = new QueueProcessor(queue, {
      agents: {
        nyx: { name: "Nyx", provider: "anthropic", model: "claude-sonnet-4-6", cli_fallback: "claude", working_directory: tmpDir, role: "lead" },
        analyst: { name: "Analyst", provider: "openai", model: "gpt-5.5", working_directory: tmpDir, role: "reviewer" },
      },
      teams: {},
      baseDir: tmpDir,
    });

    expect(proc.resolveProposalReviewModel(["analyst"])).toBe("claude-sonnet-4-6");

    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("defaults proposal review to Codex when the primary brain is OpenAI", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "review-model-openai-"));
    const queue = new QueueDB(tmpDir);
    const proc = new QueueProcessor(queue, {
      agents: {
        nyx: { name: "Nyx", provider: "openai", model: "gpt-5.5", working_directory: tmpDir, role: "lead" },
        analyst: { name: "Analyst", provider: "anthropic", model: "claude-sonnet-4-6", cli_fallback: "claude", working_directory: tmpDir, role: "reviewer" },
      },
      teams: {},
      baseDir: tmpDir,
    });

    expect(proc.resolveProposalReviewModel(["analyst"])).toBe("gpt-5.5");

    rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe("ProposalNotification type compatibility", () => {
  test("ProposalNotification shape matches Proposal fields", () => {
    const tmpDir = mkdtempSync(join(tmpdir(), "notif-test-"));
    const store = new ProposalStore(tmpDir, "test");
    const p = store.create({
      title: "Test proposal",
      description: "For notification",
      category: "maintenance",
      proposed_by: "nyx",
      priority: "high",
      effort: "small",
      files_affected: ["src/foo.ts"],
    });

    // This verifies the ProposalNotification shape can be built from a Proposal
    const notification = {
      proposal_id: p.proposal_id,
      title: p.title,
      description: p.description,
      category: p.category,
      priority: p.priority,
      effort: p.effort,
      files_affected: p.files_affected,
      proposed_by: p.proposed_by,
    };

    expect(notification.proposal_id).toMatch(/^proposal-/);
    expect(notification.title).toBe("Test proposal");
    expect(notification.priority).toBe("high");
    expect(notification.effort).toBe("small");
    expect(notification.files_affected).toEqual(["src/foo.ts"]);

    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe("parseProposalCommand for approval gates", () => {
  test("approve triggers approval flow", () => {
    const cmd = parseProposalCommand("approve a1b2c3d4");
    expect(cmd).toEqual({ action: "approve", id: "a1b2c3d4" });
  });

  test("reject with reason triggers rejection flow", () => {
    const cmd = parseProposalCommand("reject a1b2c3d4 not needed right now");
    expect(cmd).toEqual({ action: "reject", id: "a1b2c3d4", reason: "not needed right now" });
  });

  test("non-command messages return null", () => {
    expect(parseProposalCommand("hello")).toBeNull();
    expect(parseProposalCommand("can you approve this?")).toBeNull();
    expect(parseProposalCommand("the approval is pending")).toBeNull();
  });
});

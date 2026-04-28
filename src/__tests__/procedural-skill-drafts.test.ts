import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { ProceduralSkillDraftStore } from "../memory/procedural-skills.js";

function createStore() {
  return new ProceduralSkillDraftStore(new Database(":memory:"));
}

describe("ProceduralSkillDraftStore", () => {
  test("creates and retrieves a draft", () => {
    const store = createStore();

    const created = store.create({
      sourceHash: "hash-1",
      agentKey: "nyx",
      conversationId: "conv-1",
      traceId: "trace-1",
      title: "Stabilize cockpit reconnect loops",
      summary: "Procedure for diagnosing reconnect churn and stale history races.",
      draftMarkdown: "# Skill\n\n## When to use\nReconnect churn\n",
    });

    expect(created.id).toBeGreaterThan(0);
    expect(created.status).toBe("draft");
    expect(created.agent_key).toBe("nyx");
    expect(store.getById(created.id)?.source_hash).toBe("hash-1");
  });

  test("dedupes drafts by source hash", () => {
    const store = createStore();

    const first = store.create({
      sourceHash: "same-hash",
      agentKey: "nyx",
      title: "One",
      summary: "First",
      draftMarkdown: "first",
    });
    const second = store.create({
      sourceHash: "same-hash",
      agentKey: "forge",
      title: "Two",
      summary: "Second",
      draftMarkdown: "second",
    });

    expect(second.id).toBe(first.id);
    expect(store.list().length).toBe(1);
    expect(store.getBySourceHash("same-hash")?.agent_key).toBe("nyx");
  });

  test("lists drafts by status and agent", () => {
    const store = createStore();
    const a = store.create({
      sourceHash: "hash-a",
      agentKey: "nyx",
      title: "A",
      summary: "A",
      draftMarkdown: "A",
    });
    const b = store.create({
      sourceHash: "hash-b",
      agentKey: "forge",
      title: "B",
      summary: "B",
      draftMarkdown: "B",
    });
    store.publish(a.id, "auto-nyx-a");
    store.reject(b.id, "too narrow");

    expect(store.list({ status: "published" }).map((draft) => draft.id)).toEqual([a.id]);
    expect(store.list({ status: "rejected" }).map((draft) => draft.id)).toEqual([b.id]);
    expect(store.list({ agentKey: "forge" }).map((draft) => draft.id)).toEqual([b.id]);
  });

  test("records published metadata, usage, and successful reuse", () => {
    const store = createStore();
    const created = store.create({
      sourceHash: "hash-publish",
      agentKey: "nyx",
      title: "Publish me",
      summary: "Summary",
      draftMarkdown: "draft",
    });

    const published = store.publish(created.id, "auto-publish-me", "/tmp/auto-publish-me/SKILL.md");
    expect(published?.status).toBe("published");
    expect(published?.published_skill_name).toBe("auto-publish-me");
    expect(published?.published_skill_path).toBe("/tmp/auto-publish-me/SKILL.md");
    expect(published?.published_at).not.toBeNull();

    const used = store.recordUsage(created.id);
    expect(used?.usage_count).toBe(1);
    expect(used?.last_used_at).not.toBeNull();

    const succeeded = store.recordSuccess(created.id);
    expect(succeeded?.success_count).toBe(1);
    expect(succeeded?.last_success_at).not.toBeNull();
  });

  test("refines draft markdown without changing provenance", () => {
    const store = createStore();
    const created = store.create({
      sourceHash: "hash-refine",
      agentKey: "nyx",
      title: "Original",
      summary: "Original summary",
      draftMarkdown: "# Original",
    });

    const refined = store.refine(created.id, {
      title: "Refined",
      summary: "Refined summary",
      draftMarkdown: "# Refined",
    });

    expect(refined?.id).toBe(created.id);
    expect(refined?.source_hash).toBe("hash-refine");
    expect(refined?.title).toBe("Refined");
    expect(refined?.draft_markdown).toBe("# Refined");
  });

  test("records rejection reason", () => {
    const store = createStore();
    const created = store.create({
      sourceHash: "hash-reject",
      agentKey: "nyx",
      title: "Reject me",
      summary: "Summary",
      draftMarkdown: "draft",
    });

    const rejected = store.reject(created.id, "duplicate of existing manual skill");
    expect(rejected?.status).toBe("rejected");
    expect(rejected?.rejected_reason).toContain("duplicate");
    expect(rejected?.published_skill_name).toBeNull();
    expect(rejected?.published_skill_path).toBeNull();
  });
});

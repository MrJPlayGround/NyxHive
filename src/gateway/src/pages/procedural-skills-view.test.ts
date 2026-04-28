import { describe, expect, test } from "bun:test";
import {
  buildProceduralSkillSummary,
  getVisibleProceduralSkills,
  needsProceduralSkillAudit,
  type ProceduralSkillDraftRecord,
} from "./procedural-skills-view";

function makeDraft(overrides: Partial<ProceduralSkillDraftRecord>): ProceduralSkillDraftRecord {
  return {
    id: 1,
    source_hash: "hash",
    agent_key: "nyx",
    conversation_id: "gateway:thread-1",
    trace_id: "trace-1",
    title: "Workflow: Stabilize cockpit reconnect path",
    summary: "Reconnect churn workflow.",
    draft_markdown: "# Skill",
    status: "draft",
    published_skill_name: null,
    rejected_reason: null,
    usage_count: 0,
    success_count: 0,
    created_at: "2026-04-10T10:00:00.000Z",
    updated_at: "2026-04-10T10:00:00.000Z",
    published_at: null,
    last_used_at: null,
    last_success_at: null,
    ...overrides,
  };
}

describe("procedural skills view helpers", () => {
  test("buildProceduralSkillSummary counts statuses and top agents", () => {
    const summary = buildProceduralSkillSummary([
      makeDraft({ id: 1, agent_key: "nyx", status: "draft" }),
      makeDraft({ id: 2, agent_key: "nyx", status: "published", success_count: 3 }),
      makeDraft({ id: 3, agent_key: "forge", status: "published", usage_count: 3, success_count: 0 }),
      makeDraft({ id: 4, agent_key: "forge", status: "rejected" }),
    ]);

    expect(summary.total).toBe(4);
    expect(summary.draftCount).toBe(1);
    expect(summary.publishedCount).toBe(2);
    expect(summary.rejectedCount).toBe(1);
    expect(summary.successfulReuseCount).toBe(3);
    expect(summary.auditCandidateCount).toBe(1);
    expect(summary.topAgents).toEqual([
      { agentKey: "forge", count: 2 },
      { agentKey: "nyx", count: 2 },
    ]);
  });

  test("needsProceduralSkillAudit flags weak published skills and ignores healthy ones", () => {
    expect(
      needsProceduralSkillAudit(makeDraft({ status: "published", usage_count: 2, success_count: 0 })),
    ).toBe(true);

    expect(
      needsProceduralSkillAudit(makeDraft({ status: "published", usage_count: 4, success_count: 3 })),
    ).toBe(false);

    expect(
      needsProceduralSkillAudit(makeDraft({ status: "draft", usage_count: 10, success_count: 0 })),
    ).toBe(false);
  });

  test("getVisibleProceduralSkills filters by status and query", () => {
    const drafts = [
      makeDraft({ id: 1, status: "draft", title: "Workflow: Fix reconnect churn" }),
      makeDraft({ id: 2, status: "published", published_skill_name: "auto-relay-callback", title: "Workflow: Relay callback identity" }),
      makeDraft({ id: 3, status: "draft", agent_key: "forge", title: "Workflow: Improve proposal batching" }),
    ];

    expect(
      getVisibleProceduralSkills(drafts, { status: "draft", query: "forge" }).map((draft) => draft.id),
    ).toEqual([3]);

    expect(
      getVisibleProceduralSkills(drafts, { status: "published", query: "relay" }).map((draft) => draft.id),
    ).toEqual([2]);

    expect(
      getVisibleProceduralSkills(
        [makeDraft({ id: 4, status: "draft", source_hash: "abc123def456", trace_id: "trace-cockpit-9" })],
        { status: "draft", query: "trace-cockpit-9" },
      ).map((draft) => draft.id),
    ).toEqual([4]);

    expect(
      getVisibleProceduralSkills(
        [makeDraft({ id: 5, status: "draft", source_hash: "abc123def456", trace_id: "trace-cockpit-9" })],
        { status: "draft", query: "abc123def456" },
      ).map((draft) => draft.id),
    ).toEqual([5]);
  });

  test("getVisibleProceduralSkills sorts newest updated drafts first", () => {
    const drafts = [
      makeDraft({ id: 1, status: "draft", updated_at: "2026-04-10T09:00:00.000Z" }),
      makeDraft({ id: 2, status: "draft", updated_at: "2026-04-10T12:00:00.000Z" }),
    ];

    expect(
      getVisibleProceduralSkills(drafts, { status: "draft", query: "" }).map((draft) => draft.id),
    ).toEqual([2, 1]);
  });

  test("getVisibleProceduralSkills supports audit-only filtering and outcome sorting", () => {
    const drafts = [
      makeDraft({ id: 1, status: "published", usage_count: 3, success_count: 0, updated_at: "2026-04-10T09:00:00.000Z" }),
      makeDraft({ id: 2, status: "published", usage_count: 4, success_count: 4, updated_at: "2026-04-10T12:00:00.000Z" }),
    ];

    expect(
      getVisibleProceduralSkills(drafts, { status: "published", query: "", auditOnly: true }).map((draft) => draft.id),
    ).toEqual([1]);

    expect(
      getVisibleProceduralSkills(drafts, { status: "published", query: "", sort: "best_outcomes" }).map((draft) => draft.id),
    ).toEqual([2, 1]);
  });
});

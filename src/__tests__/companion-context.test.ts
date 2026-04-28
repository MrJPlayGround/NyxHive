import { describe, expect, test } from "bun:test";
import { buildCompanionContext, summarizeProceduralSkillCompanionStatus } from "../queue/companion-context.js";
import type { ProceduralSkillAnalyticsRecord } from "../memory/procedural-skill-analytics.js";

function makeDraft(overrides: Partial<ProceduralSkillAnalyticsRecord> = {}): ProceduralSkillAnalyticsRecord {
  return {
    id: 1,
    source_hash: "hash-1",
    agent_key: "nyx",
    conversation_id: "conv-1",
    trace_id: "trace-1",
    title: "Workflow: Stabilize reconnect path",
    summary: "Reconnect workflow.",
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

describe("companion context", () => {
  test("direct workflow mode omits pending proposals and surfaces self-improvement status", () => {
    const status = summarizeProceduralSkillCompanionStatus([
      makeDraft({ status: "draft" }),
      makeDraft({ id: 2, status: "published", usage_count: 3, success_count: 0, published_skill_name: "auto-generic" }),
    ]);

    const block = buildCompanionContext({
      workflowMode: "direct",
      pendingProposals: ["- #12 Replace proposal queue"],
      proceduralSkills: status,
      recentChanges: [],
      escalations: [],
    });

    expect(block).toContain("[Self-improvement status]");
    expect(block).not.toContain("[Pending proposals awaiting review]");
    expect(block).toContain("Published skills needing audit: 1");
  });

  test("proposal-first mode includes pending proposals", () => {
    const block = buildCompanionContext({
      workflowMode: "proposal_first",
      pendingProposals: ["- #12 Replace proposal queue"],
      recentChanges: [],
      escalations: [],
    });

    expect(block).toContain("[Pending proposals awaiting review]");
    expect(block).toContain("#12 Replace proposal queue");
  });
});

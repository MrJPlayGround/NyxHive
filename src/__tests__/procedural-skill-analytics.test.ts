import { describe, expect, test } from "bun:test";
import {
  buildProceduralSkillAuditReason,
  compareProceduralSkills,
  getProceduralSkillSuccessRate,
  matchesProceduralSkillQuery,
  needsProceduralSkillAudit,
  type ProceduralSkillAnalyticsRecord,
} from "../memory/procedural-skill-analytics.js";

function makeDraft(overrides: Partial<ProceduralSkillAnalyticsRecord> = {}): ProceduralSkillAnalyticsRecord {
  return {
    id: 1,
    source_hash: "hash-1",
    agent_key: "nyx",
    conversation_id: "conv-1",
    trace_id: "trace-1",
    title: "Workflow: Stabilize cockpit reconnect path",
    summary: "Reconnect churn workflow.",
    draft_markdown: "# Skill",
    status: "published",
    published_skill_name: "auto-cockpit-reconnect",
    rejected_reason: null,
    usage_count: 3,
    success_count: 2,
    created_at: "2026-04-10T10:00:00.000Z",
    updated_at: "2026-04-10T10:00:00.000Z",
    published_at: "2026-04-10T10:10:00.000Z",
    last_used_at: "2026-04-10T12:00:00.000Z",
    last_success_at: "2026-04-10T12:01:00.000Z",
    ...overrides,
  };
}

describe("procedural skill analytics", () => {
  test("calculates success rates", () => {
    expect(getProceduralSkillSuccessRate(makeDraft({ usage_count: 4, success_count: 3 }))).toBe(0.75);
    expect(getProceduralSkillSuccessRate(makeDraft({ usage_count: 0, success_count: 0 }))).toBeNull();
  });

  test("flags and explains audit candidates", () => {
    const weak = makeDraft({ usage_count: 3, success_count: 0 });
    expect(needsProceduralSkillAudit(weak)).toBe(true);
    expect(buildProceduralSkillAuditReason(weak)).toContain("selected 3 times");

    const healthy = makeDraft({ usage_count: 4, success_count: 3 });
    expect(needsProceduralSkillAudit(healthy)).toBe(false);
    expect(buildProceduralSkillAuditReason(healthy)).toBeNull();
  });

  test("matches query against provenance fields", () => {
    const draft = makeDraft({ trace_id: "trace-cockpit-9", source_hash: "abc123def456" });
    expect(matchesProceduralSkillQuery(draft, "trace-cockpit-9")).toBe(true);
    expect(matchesProceduralSkillQuery(draft, "abc123def456")).toBe(true);
    expect(matchesProceduralSkillQuery(draft, "relay")).toBe(false);
  });

  test("sorts by outcome quality and audit priority", () => {
    const healthy = makeDraft({ id: 1, usage_count: 4, success_count: 4 });
    const weak = makeDraft({ id: 2, usage_count: 4, success_count: 0 });

    expect(compareProceduralSkills(healthy, weak, "best_outcomes")).toBeLessThan(0);
    expect(compareProceduralSkills(healthy, weak, "needs_audit")).toBeGreaterThan(0);
  });
});

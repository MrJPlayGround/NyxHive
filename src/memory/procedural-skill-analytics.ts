export interface ProceduralSkillAnalyticsRecord {
  id: number;
  source_hash: string;
  agent_key: string;
  conversation_id: string | null;
  trace_id: string | null;
  title: string;
  summary: string;
  draft_markdown: string;
  status: "draft" | "published" | "rejected";
  published_skill_name: string | null;
  published_skill_path?: string | null;
  rejected_reason: string | null;
  usage_count: number;
  success_count: number;
  created_at: string;
  updated_at: string;
  published_at: string | null;
  last_used_at: string | null;
  last_success_at: string | null;
}

export type ProceduralSkillSort = "newest" | "most_used" | "best_outcomes" | "needs_audit";

export function getProceduralSkillSuccessRate(draft: Pick<ProceduralSkillAnalyticsRecord, "usage_count" | "success_count">): number | null {
  if (draft.usage_count <= 0) return null;
  return draft.success_count / draft.usage_count;
}

export function needsProceduralSkillAudit(
  draft: Pick<ProceduralSkillAnalyticsRecord, "status" | "usage_count" | "success_count">,
): boolean {
  if (draft.status !== "published") return false;
  if (draft.usage_count < 2) return false;
  if (draft.success_count === 0) return true;
  return draft.usage_count >= 3 && draft.success_count / draft.usage_count < 0.34;
}

export function buildProceduralSkillAuditReason(
  draft: Pick<ProceduralSkillAnalyticsRecord, "status" | "usage_count" | "success_count" | "published_skill_name" | "title">,
): string | null {
  if (!needsProceduralSkillAudit(draft)) return null;
  const label = draft.published_skill_name ?? draft.title;
  if (draft.success_count === 0) {
    return `${label} has been selected ${draft.usage_count} times without a confirmed successful reuse. Review whether it is too generic or misleading.`;
  }
  const rate = Math.round(((draft.success_count / Math.max(draft.usage_count, 1)) * 100));
  return `${label} is underperforming with ${draft.success_count}/${draft.usage_count} successful reuses (${rate}%). Review or tighten it before it keeps steering future runs.`;
}

export function matchesProceduralSkillQuery(
  draft: Pick<
    ProceduralSkillAnalyticsRecord,
    "title" | "summary" | "agent_key" | "conversation_id" | "trace_id" | "source_hash" | "published_skill_name" | "rejected_reason"
  >,
  query: string,
): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  const haystack = [
    draft.title,
    draft.summary,
    draft.agent_key,
    draft.conversation_id ?? "",
    draft.trace_id ?? "",
    draft.source_hash,
    draft.published_skill_name ?? "",
    draft.rejected_reason ?? "",
  ]
    .join("\n")
    .toLowerCase();
  return haystack.includes(normalized);
}

function compareNewest(a: ProceduralSkillAnalyticsRecord, b: ProceduralSkillAnalyticsRecord): number {
  const aTime = Date.parse(a.updated_at || a.created_at);
  const bTime = Date.parse(b.updated_at || b.created_at);
  if (bTime !== aTime) return bTime - aTime;
  return b.id - a.id;
}

export function compareProceduralSkills(
  a: ProceduralSkillAnalyticsRecord,
  b: ProceduralSkillAnalyticsRecord,
  sort: ProceduralSkillSort,
): number {
  if (sort === "most_used") {
    if (b.usage_count !== a.usage_count) return b.usage_count - a.usage_count;
    if (b.success_count !== a.success_count) return b.success_count - a.success_count;
    return compareNewest(a, b);
  }

  if (sort === "best_outcomes") {
    const aRate = getProceduralSkillSuccessRate(a) ?? -1;
    const bRate = getProceduralSkillSuccessRate(b) ?? -1;
    if (bRate !== aRate) return bRate - aRate;
    if (b.success_count !== a.success_count) return b.success_count - a.success_count;
    return compareNewest(a, b);
  }

  if (sort === "needs_audit") {
    const aAudit = needsProceduralSkillAudit(a) ? 1 : 0;
    const bAudit = needsProceduralSkillAudit(b) ? 1 : 0;
    if (bAudit !== aAudit) return bAudit - aAudit;
    if (b.usage_count !== a.usage_count) return b.usage_count - a.usage_count;
    return compareNewest(a, b);
  }

  return compareNewest(a, b);
}

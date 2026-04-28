import {
  buildProceduralSkillAuditReason,
  compareProceduralSkills,
  matchesProceduralSkillQuery,
  needsProceduralSkillAudit,
  type ProceduralSkillSort,
} from "../../../memory/procedural-skill-analytics.js";

export interface ProceduralSkillDraftRecord {
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
  rejected_reason: string | null;
  usage_count: number;
  success_count: number;
  created_at: string;
  updated_at: string;
  published_at: string | null;
  last_used_at: string | null;
  last_success_at: string | null;
}

export type ProceduralSkillStatusFilter = "draft" | "published" | "rejected";
export type ProceduralSkillViewSort = ProceduralSkillSort;

export interface ProceduralSkillSummary {
  total: number;
  draftCount: number;
  publishedCount: number;
  rejectedCount: number;
  successfulReuseCount: number;
  auditCandidateCount: number;
  topAgents: Array<{ agentKey: string; count: number }>;
}

export function buildProceduralSkillSummary(
  drafts: ProceduralSkillDraftRecord[],
): ProceduralSkillSummary {
  const agentCounts = new Map<string, number>();
  let draftCount = 0;
  let publishedCount = 0;
  let rejectedCount = 0;
  let successfulReuseCount = 0;
  let auditCandidateCount = 0;

  for (const draft of drafts) {
    agentCounts.set(draft.agent_key, (agentCounts.get(draft.agent_key) ?? 0) + 1);
    if (draft.status === "draft") draftCount += 1;
    if (draft.status === "published") publishedCount += 1;
    if (draft.status === "rejected") rejectedCount += 1;
    successfulReuseCount += draft.success_count;
    if (needsProceduralSkillAudit(draft)) auditCandidateCount += 1;
  }

  const topAgents = [...agentCounts.entries()]
    .map(([agentKey, count]) => ({ agentKey, count }))
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return a.agentKey.localeCompare(b.agentKey);
    })
    .slice(0, 4);

  return {
    total: drafts.length,
    draftCount,
    publishedCount,
    rejectedCount,
    successfulReuseCount,
    auditCandidateCount,
    topAgents,
  };
}

export function getVisibleProceduralSkills(
  drafts: ProceduralSkillDraftRecord[],
  opts: { status: ProceduralSkillStatusFilter; query: string; sort?: ProceduralSkillViewSort; auditOnly?: boolean },
): ProceduralSkillDraftRecord[] {
  const sort = opts.sort ?? "newest";
  return drafts
    .filter((draft) => draft.status === opts.status)
    .filter((draft) => (opts.auditOnly ? needsProceduralSkillAudit(draft) : true))
    .filter((draft) => matchesProceduralSkillQuery(draft, opts.query))
    .sort((a, b) => compareProceduralSkills(a, b, sort));
}

export { buildProceduralSkillAuditReason, needsProceduralSkillAudit };

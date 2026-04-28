import { needsProceduralSkillAudit, type ProceduralSkillAnalyticsRecord } from "../memory/procedural-skill-analytics.js";

export type WorkflowMode = "direct" | "proposal_first";

export interface ProceduralSkillCompanionSummary {
  draftCount: number;
  publishedCount: number;
  auditCount: number;
}

export interface CompanionContextInput {
  workflowMode: WorkflowMode;
  pendingProposals: string[];
  fleetSummary?: string | null;
  recentChanges: string[];
  escalations: string[];
  proceduralSkills?: ProceduralSkillCompanionSummary | null;
}

export function summarizeProceduralSkillCompanionStatus(
  drafts: ProceduralSkillAnalyticsRecord[],
): ProceduralSkillCompanionSummary | null {
  if (drafts.length === 0) return null;
  let draftCount = 0;
  let publishedCount = 0;
  let auditCount = 0;
  for (const draft of drafts) {
    if (draft.status === "draft") draftCount += 1;
    if (draft.status === "published") publishedCount += 1;
    if (needsProceduralSkillAudit(draft)) auditCount += 1;
  }
  return { draftCount, publishedCount, auditCount };
}

export function buildCompanionContext(input: CompanionContextInput): string | null {
  const sections: string[] = [];

  if (input.workflowMode === "proposal_first" && input.pendingProposals.length > 0) {
    sections.push([
      "[Pending proposals awaiting review]",
      ...input.pendingProposals,
    ].join("\n"));
  }

  if (input.fleetSummary) {
    sections.push(`[Fleet health]\n${input.fleetSummary}`);
  }

  if (input.proceduralSkills && (input.proceduralSkills.draftCount > 0 || input.proceduralSkills.auditCount > 0)) {
    sections.push([
      "[Self-improvement status]",
      `- Draft skills awaiting review: ${input.proceduralSkills.draftCount}`,
      `- Published auto-skills: ${input.proceduralSkills.publishedCount}`,
      `- Published skills needing audit: ${input.proceduralSkills.auditCount}`,
    ].join("\n"));
  }

  if (input.recentChanges.length > 0) {
    sections.push(`[Recent decisions and changes since the last conversation]\n${input.recentChanges.slice(0, 5).join("\n")}`);
  }

  if (input.escalations.length > 0) {
    sections.push(`[Pending escalations]\n${input.escalations.join("\n")}`);
  }

  if (sections.length === 0) return null;
  return `[Conversation bootstrap]\nThis is a new or resumed companion conversation. Treat the following as current ambient context, not a user request.\n\n${sections.join("\n\n")}`;
}

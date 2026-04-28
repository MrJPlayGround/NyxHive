import type { Proposal } from "./store.js";
import type { ProposalStore } from "./store.js";

export interface ReviewAutopilotResult {
  advanced: boolean;
  reason: string;
  proposal: Proposal | null;
}

export function canAutoAdvanceReviewedProposal(proposal: Proposal): { ok: boolean; reason: string } {
  if (proposal.status !== "reviewed") {
    return { ok: false, reason: `status is ${proposal.status}, not reviewed` };
  }
  if (proposal.verdict !== "APPROVE") {
    return { ok: false, reason: `review verdict is ${proposal.verdict ?? "missing"}, not APPROVE` };
  }
  if (proposal.autonomy !== "auto") {
    return { ok: false, reason: "proposal requires owner approval" };
  }
  return { ok: true, reason: "review approved and proposal is auto-eligible" };
}

export function autoAdvanceReviewedProposal(
  store: ProposalStore,
  proposalId: string,
  approvedBy: string,
): ReviewAutopilotResult {
  const proposal = store.get(proposalId);
  if (!proposal) {
    return { advanced: false, reason: "proposal not found", proposal: null };
  }

  const decision = canAutoAdvanceReviewedProposal(proposal);
  if (!decision.ok) {
    return { advanced: false, reason: decision.reason, proposal };
  }

  const approved = store.approve(proposalId, approvedBy);
  return {
    advanced: approved?.status === "approved",
    reason: approved ? decision.reason : "approval update failed",
    proposal: approved,
  };
}

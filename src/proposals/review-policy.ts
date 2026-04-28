import type { Proposal } from "./store.js";

type ReviewableProposalState = Pick<Proposal, "status" | "verdict" | "review_result">;

function isRetryableReviewFailure(reviewResult: string | null | undefined): boolean {
  const normalized = reviewResult?.trim().toLowerCase() ?? "";
  return normalized.startsWith("review failed:") || normalized.startsWith("auto-review failed:");
}

export function canRetryProposalReview(proposal: ReviewableProposalState): boolean {
  if (proposal.status !== "reviewed") return false;
  return proposal.verdict == null || proposal.verdict === "UNCLEAR" || isRetryableReviewFailure(proposal.review_result);
}

export function getProposalReviewEligibility(
  proposal: ReviewableProposalState,
): { ok: true } | { ok: false; error: string; statusCode: 400 | 409 } {
  if (proposal.status === "proposed") {
    return { ok: true };
  }

  if (canRetryProposalReview(proposal)) {
    return { ok: true };
  }

  if (proposal.status === "reviewed") {
    return { ok: false, error: "Proposal already has a completed review", statusCode: 409 };
  }

  return {
    ok: false,
    error: `Proposal must be in 'proposed' status to review (currently '${proposal.status}')`,
    statusCode: 400,
  };
}

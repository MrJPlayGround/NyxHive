import type { AgentConfig } from "../types.js";

type ReviewModelAgent = Pick<AgentConfig, "provider" | "model" | "cli_fallback">;

export const DEFAULT_PROPOSAL_REVIEW_MODEL = "gpt-5.5";
export const ANTHROPIC_PROPOSAL_REVIEW_MODEL = "claude-opus-4-6";
export const DEFAULT_PROPOSAL_EXECUTION_MODEL = "gpt-5.5";

function normalize(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

export function getBestProposalReviewModel(agent?: ReviewModelAgent): string {
  if (!agent) return DEFAULT_PROPOSAL_REVIEW_MODEL;

  const provider = normalize(agent.provider);
  const model = normalize(agent.model);
  const cliFallback = normalize(agent.cli_fallback);

  if (provider === "anthropic" || cliFallback === "claude" || model.startsWith("claude-")) {
    return agent.model || ANTHROPIC_PROPOSAL_REVIEW_MODEL;
  }

  if (provider === "openai" || model.startsWith("gpt-") || model.startsWith("o3")) {
    return DEFAULT_PROPOSAL_REVIEW_MODEL;
  }

  return agent.model || DEFAULT_PROPOSAL_REVIEW_MODEL;
}

export function resolveProposalReviewModel(opts?: {
  requestedModel?: string;
  primaryAgent?: ReviewModelAgent;
  reviewAgent?: ReviewModelAgent;
}): string {
  const requestedModel = opts?.requestedModel?.trim();
  if (requestedModel) return requestedModel;
  return getBestProposalReviewModel(opts?.primaryAgent ?? opts?.reviewAgent);
}

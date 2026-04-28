export type ModelTrustTier =
  | "tier_0_no_model"
  | "tier_1_draft"
  | "tier_2_constrained"
  | "tier_3_trusted"
  | "tier_4_frontier";

export type ModelAuthorityRole =
  | "none"
  | "draft_only"
  | "constrained_internal"
  | "trusted_internal"
  | "authoritative";

export interface ModelTrustMetadata {
  tier: ModelTrustTier;
  authorityRole: ModelAuthorityRole;
}

export function inferModelTrust(model: string | null | undefined): ModelTrustMetadata {
  if (!model) return { tier: "tier_0_no_model", authorityRole: "none" };

  const normalized = model.toLowerCase();
  if (
    normalized.includes("gpt-5")
    || normalized.includes("opus")
    || normalized.includes("claude-4.5")
    || normalized.includes("claude-sonnet-4-6")
  ) {
    return { tier: "tier_4_frontier", authorityRole: "authoritative" };
  }

  if (
    normalized.includes("sonnet")
    || normalized.includes("gemini-2.5-pro")
    || normalized.includes("qwen3.5-flash")
  ) {
    return { tier: "tier_3_trusted", authorityRole: "trusted_internal" };
  }

  if (
    normalized.includes("haiku")
    || normalized.includes("mini")
    || normalized.includes("flash")
    || normalized.includes("nova-lite")
    || normalized.includes("mistral-small")
  ) {
    return { tier: "tier_2_constrained", authorityRole: "constrained_internal" };
  }

  if (
    normalized.includes("qwen")
    || normalized.includes("mistral")
    || normalized.includes("deepseek")
    || normalized.includes("llama")
    || normalized.includes("ollama")
    || normalized.includes("local")
  ) {
    return { tier: "tier_1_draft", authorityRole: "draft_only" };
  }

  return { tier: "tier_2_constrained", authorityRole: "constrained_internal" };
}

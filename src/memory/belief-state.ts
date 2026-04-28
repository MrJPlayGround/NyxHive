import type { MemoryBeliefType, MemoryCurrentness, MemorySourceReliability } from "./retrieval-trace.js";

export interface MemoryTrustInput {
  confidence?: number | null;
  sourceReliability?: MemorySourceReliability | string | null;
  userConfirmed?: boolean | number | null;
  status?: string | null;
  supersedesId?: number | null;
  supersededById?: number | null;
  expiresAt?: number | null;
  createdAt?: number | null;
  now?: number;
}

export interface MemoryTrustAssessment {
  currentness: MemoryCurrentness;
  trusted: boolean;
  score: number;
  reasons: string[];
}

export const MEMORY_BELIEF_TYPES: Record<MemoryBeliefType, {
  durable: boolean;
  overtrustRisk: "low" | "medium" | "high";
  defaultConfidence: number;
}> = {
  user_stated_fact: { durable: true, overtrustRisk: "medium", defaultConfidence: 0.82 },
  inferred_preference: { durable: true, overtrustRisk: "high", defaultConfidence: 0.62 },
  assistant_observation: { durable: true, overtrustRisk: "high", defaultConfidence: 0.55 },
  workflow_procedure: { durable: true, overtrustRisk: "medium", defaultConfidence: 0.76 },
  temporary_context: { durable: false, overtrustRisk: "high", defaultConfidence: 0.45 },
  durable_context: { durable: true, overtrustRisk: "medium", defaultConfidence: 0.74 },
  superseded_fact: { durable: true, overtrustRisk: "high", defaultConfidence: 0.2 },
  uncertain_belief: { durable: true, overtrustRisk: "high", defaultConfidence: 0.35 },
};

export function normalizeMemoryBeliefType(value: string | null | undefined): MemoryBeliefType {
  switch (value) {
    case "user_stated_fact":
    case "inferred_preference":
    case "assistant_observation":
    case "workflow_procedure":
    case "temporary_context":
    case "durable_context":
    case "superseded_fact":
    case "uncertain_belief":
      return value;
    case "preference":
      return "inferred_preference";
    case "procedure":
    case "pattern":
      return "workflow_procedure";
    case "observation":
      return "assistant_observation";
    case "fact":
    default:
      return "user_stated_fact";
  }
}

export function clampConfidence(value: number | null | undefined, fallback = 0.6): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(0, Math.min(1, value));
}

export function assessMemoryTrust(input: MemoryTrustInput): MemoryTrustAssessment {
  const now = input.now ?? Date.now();
  const reasons: string[] = [];
  let currentness: MemoryCurrentness = "current";
  let score = clampConfidence(input.confidence, 0.6);

  const reliability = input.sourceReliability ?? (input.userConfirmed ? "user_confirmed" : "assistant_inferred");
  if (input.userConfirmed || reliability === "user_confirmed") {
    score += 0.12;
    reasons.push("user_confirmed");
  } else if (reliability === "user_stated") {
    score += 0.06;
    reasons.push("user_stated");
  } else if (reliability === "assistant_inferred") {
    score -= 0.12;
    reasons.push("assistant_inferred");
  }

  if (input.status === "superseded" || input.supersededById != null) {
    currentness = "superseded";
    score -= 0.55;
    reasons.push("superseded");
  } else if (input.status === "stale") {
    currentness = "stale";
    score -= 0.25;
    reasons.push("marked_stale");
  } else if (input.expiresAt != null && input.expiresAt <= now) {
    currentness = "expired";
    score -= 0.45;
    reasons.push("expired");
  } else if (input.status === "uncertain") {
    currentness = "uncertain";
    score -= 0.18;
    reasons.push("uncertain");
  }

  if (input.createdAt && now - input.createdAt > 180 * 24 * 60 * 60 * 1000 && currentness === "current") {
    currentness = "uncertain";
    score -= 0.08;
    reasons.push("old_unconfirmed");
  }

  score = Math.round(clampConfidence(score, 0) * 1000) / 1000;
  return {
    currentness,
    trusted: currentness === "current" && score >= 0.55,
    score,
    reasons,
  };
}

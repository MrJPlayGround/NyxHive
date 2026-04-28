import type { RelativeTier } from "../soul/types.js";
import {
  resolveAutoConversationMode,
  type ConversationMode,
  type AutoConversationModeReasoning,
} from "../runtime/conversation-mode-router.js";

export interface TelegramModelRouteDecision {
  tier: RelativeTier;
  mode: ConversationMode;
  reasoning: AutoConversationModeReasoning;
  reason: string;
}

export function chooseTelegramModelTier(message: string): TelegramModelRouteDecision {
  const resolved = resolveAutoConversationMode({ message });
  const tier: RelativeTier =
    resolved.mode === "quick"
      ? "min"
      : resolved.mode === "build" || resolved.mode === "deep"
        ? "max"
        : "default";

  return {
    tier,
    mode: resolved.mode,
    reasoning: resolved.reasoning,
    reason: resolved.reason,
  };
}

export type { SoulContextStrategy } from "../soul/types.js";

export interface ContextMetrics {
  messageCount: number;
  tokenCount: number;
  budgetTokens: number;
  utilizationPct: number;
  truncated: boolean;
  quarantinedOutputs?: number;
  systemPromptTokens: number;
  totalTokens: number;
}

export interface ContextBudget {
  contextWindow: number;
  budgetRatio: number;
  systemPromptTokens: number;
  responseReserve: number;
  historyBudget: number;
}

export interface ContextWindow {
  messages: { role: "user" | "assistant"; content: string }[];
  metrics: ContextMetrics;
}

/** Context pressure band — drives compaction and agent behavior. */
export type PressureBand = "green" | "yellow" | "orange" | "red";

/** Context pressure state, surfaced to agents via system prompt and metrics. */
export interface ContextPressure {
  band: PressureBand;
  utilizationPct: number;
  estimatedTurnsRemaining: number;
  summaryOnlyMode?: boolean;
  manualReviewRequired?: boolean;
  lastCompaction?: {
    timestamp: number;
    messagesRemoved: number;
    trigger: string;
  };
}

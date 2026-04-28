/**
 * Context Compaction Manager
 *
 * Four-band pressure model with score-based selective eviction.
 *
 * Bands:
 *   Green  (0-60%)   — Normal operation, no action
 *   Yellow (60-75%)  — Score messages, surface headroom warning to agent
 *   Orange (75-90%)  — Active compaction: selective eviction by importance score
 *   Red    (90%+)    — Emergency: aggressive trim, summary-only, code block strip
 *
 * Key improvement over recency-based eviction: a user constraint from turn 3
 * survives while a "got it" from turn 15 gets evicted first.
 */

import { logger } from "../utils/logger.js";
import type { MemoryStore, StoredMessage } from "../memory/store.js";
import type { GraphMemory } from "../memory/graph.js";
import type { ProviderRouter } from "../providers/router.js";
import { estimateTokens } from "./tokens.js";
import { progressiveSummarize, compactSummary } from "./summarize.js";
import type { MessageScore } from "./scoring.js";
import { scoreMessages, selectEvictions } from "./scoring.js";
import { getContextWindow } from "../defaults.js";
import type { PressureBand, ContextPressure } from "./types.js";
import type { SoulContextStrategy } from "../soul/types.js";

// --- Thresholds (configurable via constructor) ---

export interface CompactionThresholds {
  yellow: number;
  orange: number;
  red: number;
  cooldownMs: number;
  preserveRecentCount: number;
  maxSummaryTokens: number;
}

const DEFAULT_THRESHOLDS: CompactionThresholds = {
  yellow: 0.60,
  orange: 0.75,
  red: 0.90,
  cooldownMs: 60_000,
  preserveRecentCount: 4,
  maxSummaryTokens: 1500,
};

/** Minimum messages to keep after any compaction */
const MIN_KEEP_AFTER_COMPACT = 6;
const SUMMARY_RESUMMARIZE_AFTER = 5;

// --- Types ---

export interface CompactionEvent {
  conversationId: string;
  trigger: PressureBand;
  tokensBefore: number;
  tokensAfter: number;
  messagesRemoved: number;
  memoriesFlushed: number;
  highValuePreserved: number;
  timestamp: number;
}

export interface CompactionState {
  lastCompaction: Map<string, number>;
  events: CompactionEvent[];
  /** Tracks summary generation count per conversation for hygiene */
  summaryGenerations: Map<string, number>;
  emergencyMode: Map<string, { activatedAt: number; manualReviewRequired: boolean }>;
}

export interface SummaryCycle {
  generationCount: number;
  forceFullResummarization: boolean;
  maxSummaryTokens: number;
}

// --- Compaction Manager ---

export class CompactionManager {
  private state: CompactionState = {
    lastCompaction: new Map(),
    events: [],
    summaryGenerations: new Map(),
    emergencyMode: new Map(),
  };
  private thresholds: CompactionThresholds;

  constructor(thresholds?: Partial<CompactionThresholds>) {
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...thresholds };
  }

  /**
   * Assess the current context pressure for a conversation.
   * Cheap — just estimates tokens and returns the band.
   */
  assessPressure(
    conversationId: string,
    model: string,
    memory: MemoryStore,
    avgTokensPerTurn?: number,
  ): ContextPressure {
    const messages = memory.getMessages(conversationId, 500);
    const messageTokens = messages.reduce(
      (sum, msg) => sum + estimateTokens(msg.content, { mode: "fast" }),
      0,
    );
    const summaryTokens = this.estimateSummaryInjectionTokens(conversationId, memory);
    const totalTokens = messageTokens + summaryTokens;

    const availableBudget = this.getAvailableBudget(model);
    const utilizationRatio = totalTokens / availableBudget;
    const band = this.classifyBand(utilizationRatio);

    // Estimate remaining turns based on average tokens per turn
    const turnCount = Math.max(1, Math.ceil(messages.length / 2));
    const avgPerTurn = avgTokensPerTurn ?? (messageTokens > 0 ? messageTokens / turnCount : 2000);
    const remainingTokens = Math.max(0, availableBudget - totalTokens);
    const estimatedTurnsRemaining = Math.max(0, Math.floor(remainingTokens / avgPerTurn));

    const lastEvent = this.state.events
      .filter((e) => e.conversationId === conversationId)
      .at(-1);
    const emergencyState = this.state.emergencyMode.get(conversationId);

    return {
      band,
      utilizationPct: Math.round(utilizationRatio * 100),
      estimatedTurnsRemaining,
      summaryOnlyMode: emergencyState != null,
      manualReviewRequired: emergencyState?.manualReviewRequired,
      lastCompaction: lastEvent
        ? {
            timestamp: lastEvent.timestamp,
            messagesRemoved: lastEvent.messagesRemoved,
            trigger: lastEvent.trigger,
          }
        : undefined,
    };
  }

  /**
   * Format a pressure signal for injection into system prompt.
   * Returns null if green band (no signal needed).
   */
  formatPressureSignal(pressure: ContextPressure): string | null {
    if (pressure.band === "green") return null;

    const parts = [`[Context: ${pressure.band} — ${pressure.utilizationPct}% used`];

    if (pressure.estimatedTurnsRemaining <= 20) {
      parts.push(`~${pressure.estimatedTurnsRemaining} turns remaining`);
    }

    if (pressure.summaryOnlyMode) {
      parts.push("summary-first mode active");
    }

    if (pressure.band === "red") {
      parts.push("keep responses concise");
    }

    if (pressure.manualReviewRequired) {
      parts.push("manual review required");
    }

    return `${parts.join(", ")}]`;
  }

  /**
   * Check if a conversation needs compaction and execute if so.
   * Called after each conversation turn.
   *
   * Returns the pressure state (compaction may or may not have been performed).
   */
  async checkAndCompact(
    conversationId: string,
    model: string,
    memory: MemoryStore,
    router: ProviderRouter,
    graphMemory?: GraphMemory,
    agentRole?: string,
  ): Promise<ContextPressure> {
    const messages = memory.getMessages(conversationId, 500);
    const messageTokens = messages.reduce(
      (sum, msg) => sum + estimateTokens(msg.content, { mode: "fast" }),
      0,
    );
    const summaryTokens = this.estimateSummaryInjectionTokens(conversationId, memory);
    const totalTokens = messageTokens + summaryTokens;

    const availableBudget = this.getAvailableBudget(model);
    const utilizationRatio = totalTokens / availableBudget;
    const band = this.classifyBand(utilizationRatio);

    // Build base pressure state
    const turnCount = Math.max(1, Math.ceil(messages.length / 2));
    const avgPerTurn = messageTokens > 0 ? messageTokens / turnCount : 2000;
    const pressure = this.assessPressure(conversationId, model, memory, avgPerTurn);

    // Green/Yellow: no compaction needed
    if (band === "green" || band === "yellow") {
      this.state.emergencyMode.delete(conversationId);
      if (band === "yellow") {
        logger.info(`[compaction] ${conversationId} entered yellow band (${Math.round(utilizationRatio * 100)}%)`);
      }
      return pressure;
    }

    // Cooldown check (skip for red — emergency always fires)
    const lastCompact = this.state.lastCompaction.get(conversationId) ?? 0;
    if (band !== "red" && Date.now() - lastCompact < this.thresholds.cooldownMs) {
      return pressure;
    }

    if (messages.length < MIN_KEEP_AFTER_COMPACT + 2) return pressure;

    logger.info(
      `[compaction] ${band} band for ${conversationId}: ${totalTokens} tokens (${Math.round(utilizationRatio * 100)}% of ${availableBudget} budget)`,
    );

    const performed = await this.performCompaction(
      conversationId,
      messages,
      totalTokens,
      availableBudget,
      band,
      memory,
      router,
      graphMemory,
      agentRole,
    );

    // Re-assess after compaction
    if (performed) {
      return this.assessPressure(conversationId, model, memory, avgPerTurn);
    }

    return pressure;
  }

  private async performCompaction(
    conversationId: string,
    messages: StoredMessage[],
    tokensBefore: number,
    availableBudget: number,
    band: "orange" | "red",
    memory: MemoryStore,
    router: ProviderRouter,
    graphMemory?: GraphMemory,
    agentRole?: string,
  ): Promise<boolean> {
    // Score all messages for importance-based eviction, using cached values when valid.
    const scores = this.scoreConversationMessages(conversationId, messages, memory);

    // Determine target: how many tokens to free
    const targetUtilization = band === "red" ? 0.30 : 0.50;
    const targetTokens = tokensBefore - Math.floor(availableBudget * targetUtilization);

    if (targetTokens <= 0) return false;

    // Select messages to evict based on importance scores
    const evictIds = selectEvictions(
      messages,
      scores,
      targetTokens,
      (content) => estimateTokens(content, { mode: "fast" }),
      this.thresholds.preserveRecentCount,
      MIN_KEEP_AFTER_COMPACT,
    );

    if (evictIds.size === 0) return false;

    let messagesRemoved = 0;
    let memoriesFlushed = 0;
    let manualReviewRequired = false;

    const messagesToRemove = messages.filter((m) => evictIds.has(m.id));
    const messagesToKeep = messages.filter((m) => !evictIds.has(m.id));
    let highValuePreserved = scores.filter(
      (s) => s.score >= 40 && !evictIds.has(s.messageId),
    ).length;

    // Red band: strip code blocks from surviving messages
    if (band === "red") {
      for (const msg of messagesToKeep) {
        if (msg.role === "assistant" && /```[\s\S]*?```/.test(msg.content)) {
          const stripped = msg.content.replace(
            /```(?:\w+)?\n([\s\S]*?)```/g,
            (_match, _code: string) => "[code block removed for context]",
          );
          // Update in-place in DB
          memory.updateMessageContent?.(conversationId, msg.id, stripped);
        }
      }
    }

    // Pre-compaction memory flush
    if (graphMemory && messagesToRemove.length > 0) {
      try {
        const { flushMemoryBeforeSummarization } = await import("../memory/conversation-memory.js");
        const channel = conversationId.split(":")[0] ?? "unknown";
        memoriesFlushed = await flushMemoryBeforeSummarization(
          { graph: graphMemory, memory },
          router,
          conversationId,
          channel,
          messagesToRemove,
        );
      } catch (err) {
        logger.warn(`[compaction] Pre-compaction memory flush failed: ${err}`);
      }
    }

    // Summarize (including messages being removed)
    const existingSummary = memory.getConversationSummary(conversationId);
    const summaryCycle = this.prepareSummaryCycle(conversationId);
    let summary = await progressiveSummarize(
      messages,
      summaryCycle.forceFullResummarization ? null : existingSummary,
      router,
      agentRole,
    );

    if (summary) {
      summary = this.finalizeSummaryCycle(conversationId, summaryCycle, summary);
      memory.saveConversationSummary(conversationId, summary);
    }

    // Delete evicted messages
    for (const id of evictIds) {
      memory.deleteMessage(conversationId, id);
      messagesRemoved++;
    }
    memory.clearImportanceScores(conversationId);

    let triggeredEmergencyRecovery = false;
    if (band === "red") {
      const postStandardTokens = this.estimateConversationTokens(conversationId, memory);
      if (postStandardTokens > Math.floor(availableBudget * 0.85)) {
        triggeredEmergencyRecovery = true;
        const emergencyResult = await this.performEmergencyRecovery(
          conversationId,
          availableBudget,
          memory,
          router,
          graphMemory,
        );
        messagesRemoved += emergencyResult.messagesRemoved;
        memoriesFlushed += emergencyResult.memoriesFlushed;
        manualReviewRequired = emergencyResult.manualReviewRequired;
      } else {
        this.state.emergencyMode.delete(conversationId);
      }
    }

    // Red band post-compaction: inject system notice when standard compaction was enough
    if (band === "red" && !triggeredEmergencyRecovery) {
      memory.saveMessage(
        conversationId,
        "user",
        `[System: emergency context compaction performed — ${messagesToRemove.length} messages summarized, ${highValuePreserved} high-value messages preserved. If context seems missing, key decisions are in the conversation summary above.]`,
        null, null, 0, 0, 0,
      );
    }

    const keptTokens = this.estimateConversationTokens(conversationId, memory);

    this.state.lastCompaction.set(conversationId, Date.now());

    const event: CompactionEvent = {
      conversationId,
      trigger: band,
      tokensBefore,
      tokensAfter: keptTokens,
      messagesRemoved,
      memoriesFlushed,
      highValuePreserved,
      timestamp: Date.now(),
    };
    this.state.events.push(event);
    if (this.state.events.length > 50) {
      this.state.events = this.state.events.slice(-50);
    }

    logger.info(
      `[compaction] ${band} compaction for ${conversationId}: ${tokensBefore} → ${keptTokens} tokens, ` +
      `removed ${messagesToRemove.length} messages (${highValuePreserved} high-value preserved), ` +
      `flushed ${memoriesFlushed} memories`,
    );

    return true;
  }

  private scoreConversationMessages(
    conversationId: string,
    messages: StoredMessage[],
    memory: MemoryStore,
  ): MessageScore[] {
    const hasMissingScores = messages.some((message) => message.importance_score == null);
    if (!hasMissingScores) {
      return messages
        .map((message) => ({
          messageId: message.id,
          score: message.importance_score ?? 0,
          signals: ["cached"],
        }))
        .sort((left, right) => left.score - right.score);
    }

    const scores = scoreMessages(messages);
    for (const { messageId, score } of scores) {
      memory.updateMessageImportanceScore(conversationId, messageId, score);
    }
    return scores;
  }

  private getAvailableBudget(model: string): number {
    const contextWindow = getContextWindow(model);
    const systemPromptReserve = 8000;
    const responseReserve = 4096;
    return Math.max(1000, contextWindow - systemPromptReserve - responseReserve);
  }

  private estimateSummaryInjectionTokens(conversationId: string, memory: MemoryStore): number {
    const summary = memory.getConversationSummary(conversationId);
    if (!summary) return 0;
    return estimateTokens(
      `[CONVERSATION SUMMARY — neutral compressed state, not dialogue, not a prior user or assistant turn]\n${summary}`,
      { mode: "fast" },
    );
  }

  private classifyBand(utilizationRatio: number): PressureBand {
    if (utilizationRatio >= this.thresholds.red) return "red";
    if (utilizationRatio >= this.thresholds.orange) return "orange";
    if (utilizationRatio >= this.thresholds.yellow) return "yellow";
    return "green";
  }

  prepareSummaryCycle(
    conversationId: string,
    maxSummaryTokens = this.thresholds.maxSummaryTokens,
  ): SummaryCycle {
    const generationCount = (this.state.summaryGenerations.get(conversationId) ?? 0) + 1;
    return {
      generationCount,
      forceFullResummarization: generationCount >= SUMMARY_RESUMMARIZE_AFTER,
      maxSummaryTokens,
    };
  }

  finalizeSummaryCycle(
    conversationId: string,
    cycle: SummaryCycle,
    summary: string,
  ): string {
    let nextSummary = summary;
    if (estimateTokens(nextSummary, { mode: "fast" }) > cycle.maxSummaryTokens) {
      nextSummary = compactSummary(nextSummary, cycle.maxSummaryTokens);
    }

    this.state.summaryGenerations.set(
      conversationId,
      cycle.forceFullResummarization ? 0 : cycle.generationCount,
    );

    return nextSummary;
  }

  getContextStrategyOverride(
    conversationId: string,
    model: string,
    memory: MemoryStore,
  ): SoulContextStrategy | undefined {
    if (!this.state.emergencyMode.has(conversationId)) return undefined;

    const pressure = this.assessPressure(conversationId, model, memory);
    if (pressure.band === "green" || pressure.band === "yellow") {
      this.state.emergencyMode.delete(conversationId);
      return undefined;
    }

    return {
      context_mode: "inject",
      inject_recency: 4,
      include_summary: true,
      strip_code_blocks: true,
    };
  }

  /** Get recent compaction events for observability. */
  getEvents(limit = 10): CompactionEvent[] {
    return this.state.events.slice(-limit);
  }

  /** Get compaction stats for a specific conversation. */
  getConversationStats(conversationId: string): { lastCompaction: number | null; eventCount: number } {
    return {
      lastCompaction: this.state.lastCompaction.get(conversationId) ?? null,
      eventCount: this.state.events.filter((e) => e.conversationId === conversationId).length,
    };
  }

  private estimateConversationTokens(conversationId: string, memory: MemoryStore): number {
    const messageTokens = memory.getMessages(conversationId, 500).reduce(
      (sum, msg) => sum + estimateTokens(msg.content, { mode: "fast" }),
      0,
    );
    return messageTokens + this.estimateSummaryInjectionTokens(conversationId, memory);
  }

  private async performEmergencyRecovery(
    conversationId: string,
    availableBudget: number,
    memory: MemoryStore,
    router: ProviderRouter,
    graphMemory?: GraphMemory,
  ): Promise<{ messagesRemoved: number; memoriesFlushed: number; manualReviewRequired: boolean }> {
    const allMessages = memory.getMessages(conversationId, 500);
    const keptMessages = allMessages.slice(-4);
    const removedMessages = allMessages.slice(0, Math.max(0, allMessages.length - 4));

    for (const msg of keptMessages) {
      if (msg.role === "assistant" && /```[\s\S]*?```/.test(msg.content)) {
        const stripped = msg.content.replace(/```[\s\S]*?```/g, "[code block removed for context]");
        memory.updateMessageContent?.(conversationId, msg.id, stripped);
      }
    }

    let memoriesFlushed = 0;
    if (graphMemory && removedMessages.length > 0) {
      try {
        const { flushMemoryBeforeSummarization } = await import("../memory/conversation-memory.js");
        const channel = conversationId.split(":")[0] ?? "unknown";
        memoriesFlushed = await flushMemoryBeforeSummarization(
          { graph: graphMemory, memory },
          router,
          conversationId,
          channel,
          removedMessages,
        );
      } catch (err) {
        logger.warn(`[compaction] Emergency memory flush failed: ${err}`);
      }
    }

    const messagesRemoved = memory.trimToRecent(conversationId, 4);
    memory.clearImportanceScores(conversationId);

    const tokensAfter = this.estimateConversationTokens(conversationId, memory);
    const manualReviewRequired = tokensAfter > Math.floor(availableBudget * 0.85);
    this.state.emergencyMode.set(conversationId, {
      activatedAt: Date.now(),
      manualReviewRequired,
    });

    logger.error(
      `[compaction] ${JSON.stringify({
        type: "context_emergency_recovery",
        conversationId,
        messagesRemoved,
        messagesKept: 4,
        tokensAfter,
        availableBudget,
        manualReviewRequired,
      })}`,
    );

    return { messagesRemoved, memoriesFlushed, manualReviewRequired };
  }
}

import { logger } from "../utils/logger.js";
import type { AgentConfig, NyxHiveConfig, TeamConfig } from "../types.js";
import type { ConversationMessage } from "../agents/invoke.js";
import type { ProviderRouter } from "../providers/router.js";
import type { MemoryStore } from "../memory/store.js";
import type { GraphMemory } from "../memory/graph.js";
import type { ContextBudget } from "../context/types.js";
import type { SoulContextStrategy } from "../soul/types.js";
import { buildContextWindow, progressiveSummarize, extractMessageEssence, CompactionManager, type ContextMetrics } from "../context/index.js";
import { getContextWindow, EXTRACTION_INTERVAL } from "../defaults.js";
import { extractMemories } from "../memory/extract.js";
import { loadAndCompileSoul } from "../soul/runtime.js";
import { resolveConversationIdentity } from "../conversations/identity.js";
import { sanitizeAssistantResponse } from "../chat/response-sanitizer.js";

interface ConversationState {
  teamName: string;
  agents: string[];
  currentAgentIdx: number;
  messages: Array<{ agent: string; content: string }>;
  startedAt: number;
  locked: boolean;
}

/**
 * Tracks team conversations where multiple agents collaborate on a single message.
 * Each conversation flows through agents in order, each seeing previous agents' responses.
 */
export class ConversationTracker {
  private conversations = new Map<string, ConversationState>();

  startConversation(
    conversationId: string,
    team: TeamConfig,
  ): void {
    this.conversations.set(conversationId, {
      teamName: team.name,
      agents: [...team.agents],
      currentAgentIdx: 0,
      messages: [],
      startedAt: Date.now(),
      locked: false,
    });
    logger.debug(`[conversation] Started team conversation ${conversationId} with agents: ${team.agents.join(", ")}`);
  }

  getNextAgent(conversationId: string): string | null {
    const conv = this.conversations.get(conversationId);
    if (!conv) return null;
    if (conv.currentAgentIdx >= conv.agents.length) return null;
    return conv.agents[conv.currentAgentIdx];
  }

  addAgentResponse(conversationId: string, agent: string, content: string): void {
    const conv = this.conversations.get(conversationId);
    if (!conv) return;

    conv.messages.push({ agent, content });
    conv.currentAgentIdx++;
    logger.debug(`[conversation] ${agent} responded in ${conversationId} (${conv.currentAgentIdx}/${conv.agents.length})`);
  }

  isComplete(conversationId: string): boolean {
    const conv = this.conversations.get(conversationId);
    if (!conv) return true;
    return conv.currentAgentIdx >= conv.agents.length;
  }

  getAggregatedResponse(conversationId: string): string {
    const conv = this.conversations.get(conversationId);
    if (!conv) return "";

    if (conv.messages.length === 1) {
      return conv.messages[0].content;
    }

    return conv.messages
      .map((m) => `**${m.agent}:**\n${m.content}`)
      .join("\n\n---\n\n");
  }

  getConversationContext(conversationId: string): string {
    const conv = this.conversations.get(conversationId);
    if (!conv || conv.messages.length === 0) return "";

    return conv.messages
      .map((m) => `[${m.agent}]: ${m.content}`)
      .join("\n\n");
  }

  endConversation(conversationId: string): void {
    this.conversations.delete(conversationId);
  }

  hasConversation(conversationId: string): boolean {
    return this.conversations.has(conversationId);
  }
}

/**
 * Narrow interface for what ConversationManager needs from the processor.
 */
export interface ConversationManagerContext {
  memory: MemoryStore | undefined;
  router: ProviderRouter | undefined;
  nyxhiveConfig: NyxHiveConfig | undefined;
  instanceSoulsDir?: string;
  graphMemory: GraphMemory | undefined;
  getAgent(key: string): AgentConfig | undefined;
}

/**
 * Manages individual conversation history: loading, saving, summarization,
 * graph memory extraction, and context strategy resolution.
 * Extracted from QueueProcessor to reduce its size.
 */
export class ConversationManager {
  private compaction = new CompactionManager();

  /** Access compaction manager for observability. */
  getCompactionManager(): CompactionManager {
    return this.compaction;
  }

  /**
   * Build a stable conversation ID for a sender on a channel.
   */
  conversationId(channel: string, senderId?: string, sender?: string): string {
    const identity = resolveConversationIdentity({ channel, senderId, sender });
    if (identity.usedFallback) {
      logger.warn(`[conversation] No sender identity for local channel=${channel} — using '${identity.identity}' fallback.`);
    }
    return identity.conversationKey;
  }

  /**
   * Resolve the context strategy for an agent: config takes precedence, soul fills in.
   */
  getContextStrategy(agentKey: string, ctx: ConversationManagerContext): SoulContextStrategy | undefined {
    const agentConfig = ctx.getAgent(agentKey);

    // Load soul-level strategy as base
    let soulStrategy: SoulContextStrategy | undefined;
    try {
      const soul = loadAndCompileSoul(agentKey, undefined, ctx.instanceSoulsDir);
      soulStrategy = soul?.capabilities?.context_strategy;
    } catch (err) {
      logger.warn(`[context] Soul strategy load failed for ${agentKey}: ${err}`);
    }

    // Config-level strategy overrides soul (merge: config wins per-field, soul fills gaps)
    const configStrategy = agentConfig?.context_strategy;
    if (configStrategy && soulStrategy) {
      return { ...soulStrategy, ...configStrategy };
    }

    return configStrategy ?? soulStrategy;
  }

  /**
   * Load recent conversation history from memory store, bounded by token budget.
   */
  getConversationHistory(
    convId: string,
    model: string | undefined,
    systemPromptLength: number | undefined,
    agentKey: string | undefined,
    ctx: ConversationManagerContext,
  ): { messages: ConversationMessage[]; metrics: ContextMetrics } {
    if (!ctx.memory) {
      return { messages: [], metrics: { messageCount: 0, tokenCount: 0, budgetTokens: 0, utilizationPct: 0, truncated: false, systemPromptTokens: 0, totalTokens: 0 } };
    }

    const baseStrategy = agentKey ? this.getContextStrategy(agentKey, ctx) : undefined;
    const emergencyStrategy = (ctx.memory && model)
      ? this.compaction.getContextStrategyOverride(convId, model, ctx.memory)
      : undefined;
    const strategy = baseStrategy || emergencyStrategy
      ? { ...baseStrategy, ...emergencyStrategy }
      : undefined;

    const maxHistory = ctx.nyxhiveConfig?.context?.max_history ?? 200;
    const budgetRatio = strategy?.history_budget_ratio ?? ctx.nyxhiveConfig?.context?.history_budget_ratio ?? 0.5;
    const contextWindow = getContextWindow(model ?? "default") || 8000;
    const systemPromptTokens = Math.ceil((systemPromptLength ?? 0) / 3.5);
    const responseReserve = 4096;
    // Apply ratio to available space (after system prompt + response reserve), not raw context window.
    // Old formula: contextWindow * ratio - systemPrompt - reserve → goes negative on small models.
    // New formula: (contextWindow - systemPrompt - reserve) * ratio → always proportional to actual space.
    const availableForHistory = Math.max(0, contextWindow - systemPromptTokens - responseReserve);
    const historyBudget = Math.max(500, Math.floor(availableForHistory * budgetRatio));

    const budget: ContextBudget = {
      contextWindow,
      budgetRatio,
      systemPromptTokens,
      responseReserve,
      historyBudget,
    };

    const summary = ctx.memory.getConversationSummary(convId);
    const stored = ctx.memory.getMessages(convId, maxHistory)
      .map((message) => message.role === "assistant"
        ? { ...message, content: this.sanitizeResponse(message.content) }
        : message)
      .filter((message) => message.role !== "assistant" || message.content.trim().length > 0);

    return buildContextWindow(stored, summary, budget, strategy);
  }

  /**
   * Build compressed parent context for depth > 0 delegations.
   * Extracts key messages from conversation to preserve constraints (e.g., language preference, cost budgets).
   */
  buildParentContext(convId: string, maxChars: number | undefined, ctx: ConversationManagerContext): string | null {
    if (!ctx.memory) return null;
    const messages = ctx.memory.getMessages(convId, 20)
      .map((message) => message.role === "assistant"
        ? { ...message, content: this.sanitizeResponse(message.content) }
        : message)
      .filter((message) => message.role !== "assistant" || message.content.trim().length > 0);
    if (messages.length === 0) return null;

    const lines: string[] = [];
    let total = 0;
    for (const msg of [...messages].reverse()) {
      const essence = extractMessageEssence(msg.role, msg.content, 400);
      const line = `${msg.role === "user" ? "User" : "Assistant"}: ${essence}`;
      if (total + line.length > (maxChars ?? 4000)) break;
      lines.unshift(line);
      total += line.length;
    }
    return lines.length > 0 ? lines.join("\n") : null;
  }

  /**
   * Strip hallucinated tool call XML from responses before saving to history.
   * MiniMax and some models emit fake <tool_call> XML that pollutes conversation context.
   */
  sanitizeResponse(response: string): string {
    return sanitizeAssistantResponse(response);
  }

  /**
   * Save a user message and assistant response to conversation history.
   */
  saveToHistory(
    convId: string,
    channel: string,
    senderId: string,
    userMessage: string,
    assistantResponse: string,
    model: string | null,
    provider: string | null,
    tokensIn: number,
    tokensOut: number,
    cost: number,
    agentKey: string | undefined,
    ctx: ConversationManagerContext,
  ): void {
    if (!ctx.memory) return;

    ctx.memory.ensureConversation(convId, channel, senderId);
    ctx.memory.saveMessage(convId, "user", userMessage, null, null, 0, 0, 0);
    ctx.memory.saveMessage(convId, "assistant", this.sanitizeResponse(assistantResponse), model, provider, tokensIn, tokensOut, cost);

    // Trigger summarization if conversation exceeds threshold
    const threshold = ctx.nyxhiveConfig?.context?.summary_threshold ?? 20;
    const messageCount = ctx.memory.getMessageCount(convId);
    if (messageCount > threshold) {
      this.summarizeConversation(convId, agentKey, ctx).catch((err) => {
        logger.warn(`[conversation] Summarization failed for ${convId}: ${err}`);
        // Fallback: hard cap when summarization is unavailable
        const hardCap = ctx.nyxhiveConfig?.context?.max_history ?? 200;
        if (messageCount > hardCap) {
          ctx.memory?.trimToRecent(convId, hardCap);
          logger.info(`[conversation] Hard cap applied: trimmed ${convId} to ${hardCap} messages`);
        }
      });
    } else {
      // Even when below summary threshold, enforce absolute hard cap
      const hardCap = ctx.nyxhiveConfig?.context?.max_history ?? 200;
      if (messageCount > hardCap) {
        ctx.memory.trimToRecent(convId, hardCap);
        logger.info(`[conversation] Hard cap applied: trimmed ${convId} to ${hardCap} messages`);
      }
    }

    // Trigger graph memory extraction every EXTRACTION_INTERVAL messages
    if (ctx.graphMemory && ctx.router && messageCount > 0 && messageCount % EXTRACTION_INTERVAL === 0) {
      this.extractWithRetry(convId, channel, ctx);
    }

    // Token-based compaction: check if conversation is approaching context limits
    if (ctx.memory && ctx.router && model) {
      const agentRole = agentKey ? ctx.getAgent(agentKey)?.role : undefined;
      this.compaction.checkAndCompact(
        convId, model, ctx.memory, ctx.router, ctx.graphMemory, agentRole,
      ).catch((err) => {
        logger.warn(`[conversation] Token-based compaction failed for ${convId}: ${err}`);
      });
    }
  }

  /** Save a steer batch to conversation history so the agent sees it on next turn. */
  saveSteerToHistory(
    convId: string,
    steerContent: string,
    ctx: ConversationManagerContext,
  ): void {
    if (!ctx.memory) return;
    ctx.memory.saveMessage(convId, "user", steerContent, null, null, 0, 0, 0);
  }

  private async summarizeConversation(convId: string, agentKey: string | undefined, ctx: ConversationManagerContext): Promise<void> {
    if (!ctx.memory || !ctx.router) return;

    const messages = ctx.memory.getMessages(convId, 100);
    if (messages.length === 0) return;

    const existingSummary = ctx.memory.getConversationSummary(convId);
    const agentRole = agentKey ? ctx.getAgent(agentKey)?.role : undefined;
    const summaryCycle = this.compaction.prepareSummaryCycle(
      convId,
      ctx.nyxhiveConfig?.context?.summary_max_tokens,
    );

    logger.info(`[conversation] Summarizing conversation ${convId} (${messages.length} messages, role=${agentRole ?? "default"})`);

    const summary = await progressiveSummarize(
      messages,
      summaryCycle.forceFullResummarization ? null : existingSummary,
      ctx.router,
      agentRole,
    );
    if (!summary) return;

    ctx.memory.saveConversationSummary(
      convId,
      this.compaction.finalizeSummaryCycle(convId, summaryCycle, summary),
    );

    // Pre-summarization memory flush: extract important facts from messages about to be trimmed
    const threshold = ctx.nyxhiveConfig?.context?.summary_threshold ?? 20;
    const keepAfterSummary = Math.max(10, Math.floor(threshold * 0.8));
    const messagesToTrim = messages.slice(0, Math.max(0, messages.length - keepAfterSummary));
    if (messagesToTrim.length > 0 && ctx.graphMemory && ctx.router) {
      try {
        const { flushMemoryBeforeSummarization } = await import("../memory/conversation-memory.js");
        const channel = convId.split(":")[0] ?? "unknown";
        await flushMemoryBeforeSummarization(
          { graph: ctx.graphMemory, memory: ctx.memory },
          ctx.router,
          convId,
          channel,
          messagesToTrim,
        );
      } catch (err) {
        logger.warn(`[conversation] Pre-summarization flush failed for ${convId}: ${err}`);
      }
    }

    ctx.memory.trimOldMessages(convId, keepAfterSummary);
    logger.info(`[conversation] Summarized ${convId} — ${summary.length} chars, trimmed to ${keepAfterSummary} recent messages`);
  }

  /**
   * Retry-wrapper for memory extraction. One retry with 2s delay on failure.
   */
  private extractWithRetry(convId: string, channel: string, ctx: ConversationManagerContext): void {
    this.extractAndStoreMemories(convId, channel, ctx).catch(async (err) => {
      logger.warn(`[conversation] Memory extraction failed for ${convId}, retrying in 2s: ${err}`);
      await new Promise(resolve => setTimeout(resolve, 2000));
      try {
        await this.extractAndStoreMemories(convId, channel, ctx);
      } catch (retryErr) {
        logger.error(`[conversation] Memory extraction failed after retry for ${convId}: ${retryErr}`);
      }
    });
  }

  /**
   * Extract structured memories from recent conversation and store in the knowledge graph.
   * Non-blocking: failures are logged but don't affect response delivery.
   */
  private async extractAndStoreMemories(convId: string, channel: string, ctx: ConversationManagerContext): Promise<void> {
    if (!ctx.memory || !ctx.router || !ctx.graphMemory) return;

    const graph = ctx.graphMemory;
    const messages = ctx.memory.getMessages(convId, EXTRACTION_INTERVAL);
    if (messages.length === 0) return;

    const transcript = messages
      .map((m) => `${m.role}: ${m.content.slice(0, 300)}`)
      .join("\n");

    const existingMemories = graph.getExistingSummary(30);

    logger.info(`[conversation] Extracting memories from ${convId} (${messages.length} messages)`);

    const extracted = await extractMemories(transcript, existingMemories, ctx.router);
    if (extracted.length === 0) return;

    for (const mem of extracted) {
      // Check for similar existing nodes (potential contradictions or updates)
      const similar = graph.findSimilar(mem.type, mem.content, 3);

      const nodeId = graph.addNode(mem.type, mem.content, {
        conversationId: convId,
        channel,
      }, mem.importance);

      // If the extraction says it updates something, find and link
      if (mem.updates && similar.length > 0) {
        // Link to the most relevant existing node as an update
        graph.addEdge(nodeId, similar[0].id, "updates");
        logger.info(`[conversation] Memory ${nodeId} updates existing node ${similar[0].id}`);
      }

      // Check for contradictions among same-type nodes
      for (const existing of similar) {
        if (existing.content.toLowerCase() !== mem.content.toLowerCase() &&
            mem.updates && mem.updates.toLowerCase().includes("contradict")) {
          graph.addEdge(nodeId, existing.id, "contradicts");
          logger.info(`[conversation] Memory ${nodeId} contradicts existing node ${existing.id}`);
        }
      }
    }

    logger.info(`[conversation] Stored ${extracted.length} graph memories from ${convId}`);
  }
}

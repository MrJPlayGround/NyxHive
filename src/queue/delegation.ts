import { logger } from "../utils/logger.js";
import type { ConversationMessage, CLIProgress } from "../agents/invoke.js";
import type { ProviderRouter } from "../providers/router.js";
import type { MemoryStore } from "../memory/store.js";
import type { KnowledgeStore } from "../memory/knowledge.js";
import type { EmbeddingProvider } from "../memory/embeddings.js";
import type { AgentConfig, InvocationResult, NyxHiveConfig, RelayOriginContext } from "../types.js";
import { ORCHESTRATOR_MAX_TURNS } from "../defaults.js";
import type { AgentAction } from "../agents/actor.js";
import type { TraceStore } from "../memory/traces.js";
import type { Sandbox } from "../sandbox/index.js";
import type { AgentRegistry } from "../agents/registry.js";
import type { PatternStore } from "../memory/patterns.js";
import type { KnowledgeSearchResult } from "./knowledge-search.js";
import type { KnowledgeTaskContext } from "../memory/knowledge.js";
import type { BuildSystemPromptResult, RetrievalTrace } from "../memory/retrieval-trace.js";
import type { RelayCallbackManager } from "../federation/relay.js";
import type { DelegationRunStore } from "../runs/store.js";
import type { DelegationRun } from "../types.js";

// Re-export from sub-modules for backwards compatibility
export { buildDelegationEnvelope, buildContinuationPrompt, sanitizeAbsolutePaths } from "./delegation-executor.js";
export { composeDelegationResponse, buildSynthesisPrompt, invokeForReentry } from "./delegation-synthesis.js";

// Import the extracted functions used by DelegationEngine methods
import { executeDelegationTurn } from "./delegation-executor.js";
import { composeDelegationResponse, buildSynthesisPrompt, invokeForReentry } from "./delegation-synthesis.js";

/** Cost ceiling for a single delegation (including continuations). */
export const DELEGATION_COST_CEILING_USD = 10;

/**
 * Everything the delegation engine needs from the processor.
 * Processor methods and state are threaded through this interface
 * so DelegationEngine never touches QueueProcessor internals directly.
 */
export interface DelegationContext {
  // --- Processor methods ---
  isOrchestratorAgent(key: string): boolean;
  canOrchestrate(key: string): boolean;
  getAgent(key: string): AgentConfig | undefined;
  getKnownAgentKeys(): Set<string>;
  emit(type: string, data: Record<string, unknown>): void;
  searchKnowledge(message: string, conversationContext?: string, taskContext?: KnowledgeTaskContext): Promise<KnowledgeSearchResult>;
  mergeKnowledgeContext(parent: string | null, task: string | null): string | null;
  getConversationHistory(
    convId: string,
    model?: string,
    systemPromptLength?: number,
    agentKey?: string,
  ): { messages: ConversationMessage[]; metrics: { messageCount: number; tokenCount: number; budgetTokens: number; utilizationPct: number; truncated: boolean; systemPromptTokens: number; totalTokens: number } };
  buildParentContext(convId: string, maxChars?: number): string | null;
  buildSystemPrompt(agentKey: string, basePrompt: string | undefined, knowledgeContext: string | null, channel?: string, taskContext?: { filePaths?: string[]; taskType?: string; keywords?: string[] }, mode?: "sdk" | "cli", knowledgeTrace?: RetrievalTrace): BuildSystemPromptResult;
  executeManagementActions(
    actions: AgentAction[],
    agentKey: string,
    origin?: { channel: string; senderId: string; messageId?: string },
  ): Promise<string[]>;
  queueFollowup(task: string, targetAgent: string, senderAgent: string, priority: number): void;
  handleBtw?(targetAgent: string, question: string, sourceAgent: string): Promise<void>;
  handleSteer?(targetAgent: string, message: string, sourceAgent: string): Promise<void>;

  // --- Config fields ---
  config: {
    baseDir: string;
    router?: ProviderRouter;
    memory?: MemoryStore;
    knowledge?: KnowledgeStore;
    embedder?: EmbeddingProvider;
    patterns?: PatternStore;
    cliEscalationTasks?: string[];
    nyxhiveConfig?: NyxHiveConfig;
    traces?: TraceStore;
    sandbox?: Sandbox;
    registry?: AgentRegistry;
    vault?: import("../security/vault.js").CredentialVault;
    routing?: import("../memory/routing.js").RoutingStore;
    classifierFeedback?: import("../soul/classifier-feedback.js").ClassifierFeedbackStore;
    instanceSoulsDir?: string;
    relayCallbacks?: RelayCallbackManager;
    runs?: DelegationRunStore;
  };

  // --- Mutable processor state ---
  modelOverrides: Map<string, { model: string; provider?: string; cli_fallback?: string; setAt: number }>;
  conversationBudgetWarned: Map<string, number>;
  activeDelegations: Map<string, {
    agent: string;
    task: string;
    dispatchedAt: number;
    convId: string;
    fromAgent: string;
  }>;
  currentRelay?: RelayOriginContext;
  currentRun?: DelegationRun | null;
  taskId?: string | null;
  _scheduler: import("../scheduler/index.js").Scheduler | undefined;

  // --- Delegation ---
  coderAgent: string | undefined;
}

/**
 * DelegationEngine encapsulates the entire delegation pipeline:
 * actor-model mention parsing, re-entry loops for orchestrators,
 * parallel sub-task dispatch, and response composition.
 *
 * All processor state is accessed through the DelegationContext.
 */
export class DelegationEngine {

  // Task type → preferred agent role mapping for auto-delegation routing.
  // When the orchestrator fails to delegate, we use the task classification
  // to pick the right agent instead of blindly falling back to coderAgent.
  private static readonly TASK_ROLE_MAP: Record<string, import("../agents/registry.js").AgentRole[]> = {
    coding: ["coder", "lead"],
    code_review: ["reviewer", "coder"],
    research: ["expert", "lead", "coder"],
    analysis: ["expert", "lead", "coder"],
    expert: ["expert", "lead"],
    worker_subtask: ["worker", "coder"],
    // Everything else falls back to coderAgent
  };

  /**
   * Resolve the best agent for a given task type by checking the registry
   * for agents matching the preferred role, falling back to coderAgent.
   */
  private resolveAgentForTask(
    taskType: import("../providers/types.js").TaskType,
    ctx: DelegationContext,
  ): string | undefined {
    const preferredRoles = DelegationEngine.TASK_ROLE_MAP[taskType];
    if (!preferredRoles || !ctx.config.registry) return ctx.coderAgent;
    if (typeof ctx.config.registry.getAllEntries !== "function") return ctx.coderAgent;

    const allEntries = ctx.config.registry.getAllEntries();
    for (const role of preferredRoles) {
      for (const [key, entry] of allEntries) {
        if (entry.role === role && entry.enabled) {
          return key;
        }
      }
    }

    // No role match found — fall back to coderAgent
    return ctx.coderAgent;
  }

  /**
   * Validate that the orchestrator actually delegated when it should have.
   * Uses task classification to route to the right agent role instead of
   * blindly falling back to coderAgent.
   */
  validateOrchestratorDelegation(
    result: InvocationResult,
    agentKey: string,
    originalMessage: string,
    ctx: DelegationContext,
  ): InvocationResult {
    const entry = ctx.config.registry?.getEntry(agentKey);
    if (!entry || entry.role !== "orchestrator") return result;

    const hasDelegationTags = /\[@[\w][\w.-]*:\s*[^\]]+\]/.test(result.response);
    const inputHasDelegationTags = /\[@[\w][\w.-]*:\s*[^\]]+\]/.test(originalMessage);

    // If orchestrator delegated, nothing to fix
    if (hasDelegationTags) return result;

    // If user's message explicitly contains delegation tags but orchestrator swallowed them,
    // re-inject the original delegation tags. Orchestrators must never absorb explicit delegations.
    if (inputHasDelegationTags) {
      const tags = originalMessage.match(/\[@[\w][\w.-]*:\s*[^\]]+\]/g) ?? [];
      if (tags.length) {
        logger.warn(
          `[delegation] Orchestrator swallowed explicit delegation tags — re-injecting from input. Message: "${originalMessage.slice(0, 80)}"`,
        );
        result.response = `${result.response}\n\n${tags.join("\n")}`;
        return result;
      }
    }

    // Trivial messages don't need delegation
    const trimmed = originalMessage.trim();
    if (/^(ok|thanks|thank you|ty|thx|k|sure|cool|nice|got it|yes|no|yep|nope|hi|hello|hey)\.?$/i.test(trimmed) || trimmed.length < 15) {
      return result;
    }

    // Orchestrator completed a review (verdict in response) — no delegation needed
    if (/\*\*Verdict:\s*(APPROVE|REJECT)\*\*/i.test(result.response)) {
      return result;
    }

    // Orchestrator failed to delegate a non-trivial message — route to the right agent
    const classified = ctx.config.router?.classifyLocal(originalMessage) ?? "unknown";
    const targetAgent = this.resolveAgentForTask(classified as import("../providers/types.js").TaskType, ctx);

    if (!targetAgent) {
      logger.warn(`[delegation] Orchestrator didn't delegate but no suitable agent found (classified: ${classified})`);
      return result;
    }

    logger.warn(
      `[delegation] Orchestrator handled non-trivial message directly (classified: ${classified}) — auto-injecting [@${targetAgent}:]. Message: "${originalMessage.slice(0, 80)}"`,
    );

    ctx.config.registry?.recordDelegationExpected(targetAgent);
    result.response = `${result.response}\n\n[@${targetAgent}: ${originalMessage}]`;
    logger.info(`[delegation] Auto-injected tag appended (target: ${targetAgent}, task: ${classified}), response tail: "${result.response.slice(-120)}"`);
    return result;
  }

  /**
   * Process actor model mentions recursively.
   * Parses [@agent: task] from an agent's response, invokes each subtask,
   * and assembles the final composite response.
   *
   * For orchestrator agents at depth 0, supports a re-entry loop: after delegation
   * results return, the orchestrator is invoked again to synthesize or chain further
   * delegations. This enables sequential multi-step workflows.
   */
  async processWithActorModel(
    primaryResult: InvocationResult,
    traceId: string | null,
    parentEventId: number | null,
    convId: string,
    channel: string,
    senderId: string,
    depth: number,
    messageCount: { value: number },
    ctx: DelegationContext,
    originMessageId?: string,
    onProgress?: (info: CLIProgress) => void,
    originalUserMessage?: string,
    parentKnowledgeContext?: string | null,
  ): Promise<string> {
    // Re-entry loop: for orchestrator/lead agents at the top level (depth 0)
    // primaryResult.agent is the display name (e.g. "Nyx"), registry uses lowercase keys
    const agentKey = primaryResult.agent.toLowerCase();
    if (ctx.canOrchestrate(agentKey) && depth === 0) {
      return this.processWithReentryLoop(
        primaryResult, traceId, parentEventId, convId, channel, senderId,
        messageCount, ctx, originMessageId, onProgress, originalUserMessage, parentKnowledgeContext,
      );
    }

    // Non-orchestrator or recursive depth > 0: single-pass delegation (existing behavior)
    return this.executeSingleDelegationPass(
      primaryResult, traceId, parentEventId, convId, channel, senderId,
      depth, messageCount, ctx, originMessageId, onProgress, originalUserMessage, parentKnowledgeContext,
    );
  }

  /**
   * Re-entry loop for orchestrator agents. After each delegation turn, the orchestrator
   * is invoked again with the results so it can synthesize or chain further delegations.
   * Loops until natural convergence (no mentions) or ORCHESTRATOR_MAX_TURNS is reached.
   */
  private async processWithReentryLoop(
    primaryResult: InvocationResult,
    traceId: string | null,
    parentEventId: number | null,
    convId: string,
    channel: string,
    senderId: string,
    messageCount: { value: number },
    ctx: DelegationContext,
    originMessageId?: string,
    onProgress?: (info: CLIProgress) => void,
    originalUserMessage?: string,
    parentKnowledgeContext?: string | null,
  ): Promise<string> {
    let currentResponse = primaryResult.response;
    const currentAgent = primaryResult.agent;
    const allActionResults: string[] = [];
    const loopStartTime = Date.now();

    logger.info(`[delegation] Re-entry loop start for ${currentAgent}, response length: ${currentResponse.length}`);

    for (let turn = 0; turn < ORCHESTRATOR_MAX_TURNS; turn++) {
      const turnResult = await executeDelegationTurn(
        currentResponse, currentAgent, traceId, parentEventId, convId, channel, senderId,
        0, messageCount, ctx,
        this.processWithActorModel.bind(this),
        originMessageId, onProgress, originalUserMessage, parentKnowledgeContext,
      );

      allActionResults.push(...turnResult.actionResults);
      logger.info(`[delegation] Re-entry turn ${turn}: ${turnResult.mentions.length} mentions found`);

      // Natural convergence: no delegation mentions — orchestrator is done
      if (turnResult.mentions.length === 0) {
        const parts = [turnResult.cleanedResponse, ...allActionResults, turnResult.unknownErrors].filter(Boolean);
        return parts.join("\n\n");
      }

      // Delegations were processed — check if we can re-enter
      if (turn + 1 >= ORCHESTRATOR_MAX_TURNS) {
        // Turn limit reached — fall back to mechanical concatenation
        logger.info(`[processor] Orchestrator re-entry limit (${ORCHESTRATOR_MAX_TURNS}) reached, returning composed response`);
        return composeDelegationResponse(
          turnResult.cleanedResponse, allActionResults, turnResult.subtaskResults, turnResult.unknownErrors,
          ctx, originMessageId, currentAgent, channel,
        );
      }

      // RE-ENTRY: invoke orchestrator again with delegation results
      logger.info(`[processor] Orchestrator re-entry turn ${turn + 1} — ${turnResult.subtaskResults.length} delegation result(s)`);

      // Emit synthesis_start event for streaming clients
      if (originMessageId) {
        ctx.emit("synthesis_start", {
          message_id: originMessageId,
          channel,
          agent: currentAgent,
          agent_count: turnResult.subtaskResults.length,
        });
      }

      // Emit progress so clients know the orchestrator is synthesizing
      if (onProgress) {
        onProgress({
          phase: "working",
          activity: "Reviewing delegation results",
          agent: currentAgent,
          delegationDepth: 0,
          turns: turn + 1,
          elapsed: Date.now() - loopStartTime,
          tokensIn: 0,
          tokensOut: 0,
        });
      }

      const synthesisPromptText = buildSynthesisPrompt(turnResult.subtaskResults, originalUserMessage);
      const reentryResult = await invokeForReentry(
        primaryResult, synthesisPromptText, convId, channel, senderId,
        traceId, parentEventId, ctx, onProgress,
      );

      currentResponse = reentryResult.response;
      // currentAgent stays the same — it's still the orchestrator
    }

    // Should not reach here, but safety fallback
    return currentResponse;
  }

  /**
   * Single-pass delegation processing (original behavior, used for non-orchestrator agents
   * and recursive sub-delegation at depth > 0).
   */
  private async executeSingleDelegationPass(
    primaryResult: InvocationResult,
    traceId: string | null,
    parentEventId: number | null,
    convId: string,
    channel: string,
    senderId: string,
    depth: number,
    messageCount: { value: number },
    ctx: DelegationContext,
    originMessageId?: string,
    onProgress?: (info: CLIProgress) => void,
    originalUserMessage?: string,
    parentKnowledgeContext?: string | null,
  ): Promise<string> {
    const turnResult = await executeDelegationTurn(
      primaryResult.response, primaryResult.agent, traceId, parentEventId, convId, channel, senderId,
      depth, messageCount, ctx,
      this.processWithActorModel.bind(this),
      originMessageId, onProgress, originalUserMessage, parentKnowledgeContext,
    );

    if (turnResult.mentions.length === 0 && turnResult.actionResults.length === 0) {
      return turnResult.unknownErrors
        ? `${turnResult.cleanedResponse}\n\n${turnResult.unknownErrors}`
        : turnResult.cleanedResponse;
    }
    if (turnResult.mentions.length === 0) {
      return [turnResult.cleanedResponse, ...turnResult.actionResults, turnResult.unknownErrors].filter(Boolean).join("\n\n");
    }

    return composeDelegationResponse(
      turnResult.cleanedResponse, turnResult.actionResults, turnResult.subtaskResults, turnResult.unknownErrors,
      ctx, originMessageId, primaryResult.agent, channel,
    );
  }

  // --- Thin wrappers exposing extracted functions as methods (for test compat) ---

  /** Delegates to standalone executeDelegationTurn function. */
  async executeDelegationTurn(
    response: string,
    agentKey: string,
    traceId: string | null,
    parentEventId: number | null,
    convId: string,
    channel: string,
    senderId: string,
    depth: number,
    messageCount: { value: number },
    ctx: DelegationContext,
    originMessageId?: string,
    onProgress?: (info: CLIProgress) => void,
    originalUserMessage?: string,
    parentKnowledgeContext?: string | null,
  ) {
    return executeDelegationTurn(
      response, agentKey, traceId, parentEventId, convId, channel, senderId,
      depth, messageCount, ctx,
      this.processWithActorModel.bind(this),
      originMessageId, onProgress, originalUserMessage, parentKnowledgeContext,
    );
  }

  /** Delegates to standalone composeDelegationResponse function. */
  composeDelegationResponse(
    cleanedResponse: string,
    actionResults: string[],
    subtaskResults: Array<{ agent: string; agentKey: string; response: string }>,
    unknownErrors: string,
    ctx: DelegationContext,
    originMessageId?: string,
    agentKey?: string,
    channel?: string,
  ): string {
    return composeDelegationResponse(
      cleanedResponse, actionResults, subtaskResults, unknownErrors,
      ctx, originMessageId, agentKey, channel,
    );
  }

  /** Delegates to standalone buildSynthesisPrompt function. */
  buildSynthesisPrompt(
    subtaskResults: Array<{ agent: string; agentKey: string; response: string }>,
    originalUserMessage?: string,
  ): string {
    return buildSynthesisPrompt(subtaskResults, originalUserMessage);
  }
}

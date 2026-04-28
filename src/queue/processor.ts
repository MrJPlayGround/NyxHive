import { join } from "node:path";
import { emitActivity } from "../activity/ring-buffer.js";
import { randomUUID } from "node:crypto";
import type { CommandDefinition, PublicProcessorAPI, HiveStores } from "../framework/types.js";
import { matchCommand } from "../framework/commands.js";
import { resolveNotificationTargets } from "../notifications/routing.js";
import { logger } from "../utils/logger.js";
import { QueueDB } from "./db.js";
import { ConversationTracker, ConversationManager, type ConversationManagerContext } from "./conversation.js";
import { routeMessage } from "../agents/routing.js";
import { invokeAgent, invokeCliRuntime, invokeNativeAPI, type CLIProgress, type InvokeOpts } from "../agents/invoke.js";
import type { ProviderRouter } from "../providers/router.js";
import type { MemoryStore } from "../memory/store.js";
import type { KnowledgeStore } from "../memory/knowledge.js";
import type { EmbeddingProvider } from "../memory/embeddings.js";
import type {
  AgentConfig,
  ConversationMode,
  InputRequest,
  InputRequestOption,
  MessageData,
  NyxHiveConfig,
  ProcessImmediateOpts,
  ProcessImmediateResult,
  RelayOriginContext,
  SSEEvent,
  SessionRuntime,
  SuspendedMessage,
  SuspendedProcessHandle,
  ThreadEvent,
  InvocationResult,
  TeamConfig,
} from "../types.js";
import type { FileAttachment, TaskType } from "../providers/types.js";
import { POLL_INTERVAL_MS, AGENT_TIMEOUT_MS, BUDGET_CHECK_INTERVAL_MS, getBudgetConfig, getContextWindow, IDLE_THRESHOLD_MS, IDLE_COOLDOWN_MS, AUTONOMOUS_BUDGET_CEILING, RALPH_MAX_ROUNDS } from "../defaults.js";
import type { GraphMemory } from "../memory/graph.js";
import type { AgentAction } from "../agents/actor.js";
import type { TraceStore } from "../memory/traces.js";
import { redactSecrets, redactForGroup } from "../utils/redaction.js";
import { formatError } from "../utils/error.js";
import { parseClarification } from "../agents/clarify.js";
import type { Sandbox } from "../sandbox/index.js";
import type { AgentRegistry } from "../agents/registry.js";
import { getBillingType } from "../defaults.js";
import type { DevPlanStore } from "../development/plan.js";
import { ManagementActionExecutor, type ManagementContext } from "./management.js";
import { DelegationEngine, type DelegationContext } from "./delegation.js";
import type { PatternStore } from "../memory/patterns.js";
import type { OutcomeStore } from "../memory/outcomes.js";
import { parseProposalCommand } from "./model-utils.js";
import { buildSystemPrompt, type SystemPromptTaskContext } from "./system-prompt-builder.js";
import { extractAndPersistMemories } from "./memory-extraction.js";
import { searchKnowledgeWithChunks as searchKnowledgeWithChunksFn, applyRetrievalFeedback, mergeKnowledgeContext as mergeKnowledgeContextFn, type KnowledgeSearchResult } from "./knowledge-search.js";
import { EventBus } from "./event-bus.js";
import { ModelOverrideManager, inferProviderForModel } from "./model-overrides.js";
import { BtwContextCache, BtwRateLimiter, buildBtwMessages } from "./btw.js";
import { SteersDB } from "./steers.js";
import { sanitizeInput, type TrustOrigin } from "../security/input-sanitizer.js";
import { applySenderRolePolicy } from "../security/sender-role-policy.js";
import { validateOutboundHttpUrl } from "../security/url-boundary.js";
import type { ActiveTask, BtwResponse, SteerResponse } from "../types.js";
import type { AssemblyTrace, BuildSystemPromptResult, RetrievalTrace } from "../memory/retrieval-trace.js";
import type { RelayCallbackManager } from "../federation/relay.js";
import type { DelegationRunStore } from "../runs/store.js";
import { buildRunContextNote, deriveRunResult, resolveRunBrain } from "../runs/result.js";
import type { DelegationRun, DelegationRunEnvironment, DelegationRunFileTouch, DelegationRunStatus, DelegationRunUsage } from "../types.js";
import type { ContextMetrics, ContextPressure } from "../context/types.js";
import {
  buildTokenDisciplineReport,
  logTokenDisciplineWarnings,
  type TokenDisciplineReport,
} from "../context/token-discipline.js";
import { resolvePrimaryAgentKey } from "../agents/primary.js";
import { executeRalphLoop, buildRalphInstructions } from "./ralph-loop.js";
import { loadAndCompileSoul, resolveModel } from "../soul/runtime.js";
import type { ConversationUsageSummary } from "../memory/store.js";
import { resolveProposalReviewModel as selectProposalReviewModel } from "../proposals/model-policy.js";
import type { ProceduralSkillDraftStore } from "../memory/procedural-skills.js";
import { recordProceduralSkillDraftIfQualified } from "./procedural-skill-extraction.js";
import { buildCompanionContext, summarizeProceduralSkillCompanionStatus } from "./companion-context.js";
import { formatCompiledKnowledgeContext, type CompiledKnowledgeStore } from "../memory/compiled-knowledge.js";
import { resolveProductRuntimeMode, resolvePromptProfile, resolveRuntimeMode, type RuntimeMode } from "../runtime/mode.js";
import { resolveIngressConversationMode } from "../runtime/conversation-mode-router.js";
import { filterMemoryLanesForRuntime, filterRetrievalTraceForRuntime } from "../memory/lanes.js";
import { sanitizeAssistantResponse } from "../chat/response-sanitizer.js";
import {
  ExistingAgentRuntimeAdapter,
  kernelEventToSSE,
  resolveKernelRuntimeMode,
  type AgentKernelRuntime,
} from "../kernel/index.js";

// Re-export for backwards compatibility (external importers: channels, tests)
export { resolveModelAlias, parseProposalCommand } from "./model-utils.js";

export function assertDeliverableResponse(response: string, messageId: string): string {
  if (response.trim().length === 0) {
    throw new Error(`Agent produced an empty final response for message ${messageId}`);
  }
  return response;
}

interface ProcessorConfig {
  agents: Record<string, AgentConfig>;
  teams: Record<string, TeamConfig>;
  baseDir: string;
  defaultAgent?: string;
  router?: ProviderRouter;
  memory?: MemoryStore;
  knowledge?: KnowledgeStore;
  embedder?: EmbeddingProvider;
  patterns?: PatternStore;
  outcomes?: OutcomeStore;
  proceduralSkills?: ProceduralSkillDraftStore;
  compiledKnowledge?: CompiledKnowledgeStore;
  cliEscalationTasks?: string[];
  nyxhiveConfig?: NyxHiveConfig;
  relayCallbacks?: RelayCallbackManager;
  runs?: DelegationRunStore;
  traces?: TraceStore;
  graphMemory?: GraphMemory;
  sandbox?: Sandbox;
  registry?: AgentRegistry;
  vault?: import("../security/vault.js").CredentialVault;
  routing?: import("../memory/routing.js").RoutingStore;
  classifierFeedback?: import("../soul/classifier-feedback.js").ClassifierFeedbackStore;
  commands?: CommandDefinition[];
  dualBrain?: import("../agents/primary.js").DualBrainConfig;
  instanceSoulsDir?: string;
  kernelRuntime?: AgentKernelRuntime;
}

type ProcessImmediateInternalOpts = ProcessImmediateOpts & {
  _resumeMessageId?: string;
  _resumeProcessHandle?: SuspendedProcessHandle;
  _resumeRequestId?: string;
};

type RelayExecutionContext = RelayOriginContext & {
  callbackSender: string;
  callbackSenderId?: string;
};

function normalizeRelayCallbackSenderId(senderId?: string, fallbackSender?: string): string | undefined {
  const trimmed = senderId?.trim();
  if (!trimmed || trimmed === "api_key" || trimmed === "relay") {
    return fallbackSender?.trim() || undefined;
  }
  return trimmed;
}

function hasLeadingAgentMention(message: string): boolean {
  return /^@\w+\b/.test(message.trim());
}

function withRelaySenderMetadata(
  relay: RelayOriginContext | undefined,
  sender?: string,
  senderId?: string,
): RelayExecutionContext | undefined {
  if (!relay) return undefined;
  const callbackSender = sender?.trim() || relay.originInstance;
  return {
    ...relay,
    callbackSender,
    callbackSenderId: normalizeRelayCallbackSenderId(senderId, callbackSender),
  };
}

interface CliSessionRecord {
  sessionId: string;
  runtime?: SessionRuntime;
  createdAt: number;
  updatedAt: number;
  turns: number;
  lastTurnTokensIn?: number;
}


type ActiveTaskTarget = Pick<ActiveTask, "message_id" | "conversation_id">;
type ActiveTaskTargetResolutionErrorCode =
  | "agent_idle"
  | "ambiguous_target"
  | "conversation_not_found"
  | "thread_not_found";

interface ActiveTaskTargetResolutionError {
  error: ActiveTaskTargetResolutionErrorCode;
  status: 400 | 404 | 409;
  active_conversations?: Array<ActiveTaskTarget>;
}

type ActiveTaskTargetResolution = ActiveTaskTarget | ActiveTaskTargetResolutionError;

function isSessionRuntime(value: string | null | undefined): value is SessionRuntime {
  return value === "claude_cli" || value === "native_api" || value === "codex_app_server";
}

function getExpectedSessionRuntime(agent: AgentConfig): SessionRuntime | undefined {
  if (agent.provider === "anthropic") return "claude_cli";
  if (agent.cli_fallback === "codex") return "codex_app_server";
  // Non-Anthropic agents with tool access use the native API loop which supports
  // session continuity via native-session.ts (equivalent of Claude's --resume).
  if (agent.provider !== "anthropic" && agent.capabilities?.includes("tool_use")) return "native_api";
  return undefined;
}

function hasRuntimeContinuationIntent(message?: string): boolean {
  const trimmed = message?.trim();
  if (!trimmed) return false;
  if (/^\/resume\b/i.test(trimmed)) return true;
  if (/\b(continue|resume|pick back up|pick up where|carry on|keep going)\b/i.test(trimmed)) return true;
  return /^(do it|go ahead|ship it|run with it|same|that one|this one)[.!?]*$/i.test(trimmed);
}


/**
 * Core message processor. Polls the queue for pending messages, classifies them,
 * routes to the appropriate agent (SDK or CLI), handles delegation chains,
 * conversation management, budget enforcement, and emits SSE events for live UI updates.
 *
 * Owns the processing lifecycle: enqueue → classify → invoke → respond → emit.
 * Supports concurrent thread processing via a thread pool alongside sequential
 * per-agent chains for channel messages.
 */

/** Parse JSON-serialized files from queue DB into FileAttachment[]. */
function parseQueuedFiles(filesJson: string): FileAttachment[] | undefined {
	let raw: Array<{ name?: string; type?: string; mimeType?: string; data?: string; base64?: string; size?: number }>;
	try {
		raw = JSON.parse(filesJson) as Array<{ name?: string; type?: string; mimeType?: string; data?: string; base64?: string; size?: number }>;
	} catch {
		return undefined;
	}
	if (!Array.isArray(raw) || raw.length === 0) return undefined;
	return raw.map((f) => {
		const base64 = (f.base64 ?? f.data)?.trim();
		const name = f.name ?? "attachment";
		if (!base64) {
			throw new Error(`Attachment content unavailable for ${name}; queued metadata does not include file bytes. Ask the user to resend the attachment.`);
		}
		return {
			name,
			mimeType: f.mimeType ?? f.type ?? "application/octet-stream",
			base64,
			size: f.size ?? Math.ceil(base64.length * 3 / 4),
		};
	});
}

function recordInboundFileArtifacts(
  runs: DelegationRunStore | undefined,
  files: FileAttachment[] | undefined,
  provenance: {
    run_id?: string | null;
    message_id?: string | null;
    trace_id?: string | null;
    channel?: string | null;
  },
): void {
  if (!runs || !files?.length) return;
  files.forEach((file, index) => {
    try {
      runs.recordInboundArtifact({
        ...provenance,
        source: `${provenance.channel ?? "unknown"}.message.files[${index}]`,
        file,
        handler_status: "unprocessed",
      });
    } catch (err) {
      logger.warn(`[artifacts] Failed to persist inbound artifact ${file.name}: ${formatError(err)}`);
    }
  });
}

const INPUT_REQUEST_TIMEOUT_MS = 30 * 60 * 1000;

function formatInputRequestForDisplay(request: InputRequest): string {
  const lines = [request.question.trim()];
  if (request.options && request.options.length > 0) {
    lines.push(request.options.map((option, index) => (
      option.description
        ? `${index + 1}. ${option.key}: ${option.description}`
        : `${index + 1}. ${option.key}`
    )).join("\n"));
    lines.push("Reply with your choice.");
  }
  return lines.join("\n\n").trim();
}

function inputRequestFromResult(result: InvocationResult): InputRequest | null {
  if (result.input_request?.question?.trim()) {
    return {
      question: result.input_request.question.trim(),
      options: result.input_request.options?.length ? result.input_request.options : undefined,
      timeout_ms: result.input_request.timeout_ms,
      context_hint: result.input_request.context_hint,
    };
  }

  const clarification = parseClarification(result.response);
  if (!clarification) return null;
  return {
    question: clarification.question,
    options: clarification.options.length > 0 ? clarification.options : undefined,
    timeout_ms: INPUT_REQUEST_TIMEOUT_MS,
  };
}

function processHandleFromResult(result: InvocationResult): SuspendedProcessHandle | undefined {
  if (!result.session_id) return undefined;
  return {
    session_id: result.session_id,
    session_runtime: result.session_runtime,
  };
}


export class QueueProcessor {
  private queue: QueueDB;
  private config: ProcessorConfig;
  private conversations: ConversationTracker;
  private running = false;
  private agentChains: Map<string, Promise<void>> = new Map();
  // Thread pool — concurrent execution for thread messages (bypasses agentChains)
  private threadPool: Map<string, Promise<void>> = new Map(); // thread_id → processing promise
  private activeThreadCount = 0;
  private maxConcurrentThreads: number;

  // Extracted subsystems
  private eventBus = new EventBus();
  private modelOverridesMgr = new ModelOverrideManager();
  // Track last task type per conversation for follow-up detection
  private lastTaskTypes: Map<string, { type: string; setAt: number }> = new Map();
  // Active CLI processes for cancellation
  private activeProcesses: Map<string, {
    controller: AbortController;
    agent: string;
    startedAt: number;
    messageExcerpt: string;
  }> = new Map(); // key: convId
  // Pending clarifications awaiting user response
  private pendingClarifications: Map<string, {
    messageId?: string;
    requestId: string;
    originalMessage: string;
    agent: string;
    question: string;
    options: InputRequestOption[];
    processHandle?: SuspendedProcessHandle;
    timeoutAt?: number;
    threadId?: string;
    timestamp: number;
  }> = new Map(); // key: convId
  // Budget check throttle
  private lastBudgetCheck = 0;
  // Idle discovery state
  private lastActivityAt = Date.now();
  private lastIdleTriggerAt = 0;
  // Track which traces already fired the per-conversation budget warning
  private conversationBudgetWarned: Map<string, number> = new Map();
  private consecutiveFailures: Map<string, { count: number; setAt: number }> = new Map();
  private remoteMcpHealth: Map<string, { url: string; status: "up" | "down" | "unknown"; lastChecked: number; error?: string }> = new Map();
  // CLI session IDs for --resume (conversation continuity). Key: `convId:agentKey`
  private cliSessions: Map<string, CliSessionRecord> = new Map();
  // Rate limiter for memory extraction — 1 extraction per conversation per 5 minutes
  private lastExtractionAt = new Map<string, number>();
  // Active delegations — tracks in-flight agent tasks so orchestrators can answer status questions
  private activeDelegations: Map<string, {
    agent: string;
    task: string;
    dispatchedAt: number;
    convId: string;
    fromAgent: string;
  }> = new Map();

  private management = new ManagementActionExecutor();
  private delegation = new DelegationEngine();
  private conversationMgr = new ConversationManager();
  private btwCache = new BtwContextCache();
  private btwLimiter = new BtwRateLimiter(5, 60_000);
  private steersDb: SteersDB | null = null;
  private _stores?: HiveStores;

  setStores(stores: HiveStores): void {
    this._stores = stores;
  }

  get stores(): HiveStores | undefined {
    return this._stores;
  }

  getPublicAPI(): PublicProcessorAPI {
    return {
      enqueue: async (opts) => {
        const id = this.queue.enqueueMessage({
          channel: opts.channel ?? "api",
          sender: opts.sender ?? "system",
          message: opts.content,
          thread_id: opts.threadId,
        });
        return id;
      },
      onEvent: (handler) => {
        return this.eventBus.onEvent((event) => {
          handler(event.type ?? "unknown", event);
        });
      },
      onResponse: (handler) => {
        return this.eventBus.onGlobalThreadEvent((event) => {
          if (event.type === "response") {
            handler(event as any);
          }
        });
      },
      getStatus: () => ({
        running: this.running,
        queueLength: this.queue.getPendingCountAll(),
        activeProcesses: this.activeProcesses.size,
      }),
      getActiveAgents: () => {
        return Array.from(this.activeProcesses.values()).map((proc) => ({
          name: proc.agent,
          busy: true,
        }));
      },
    };
  }

  // --- BTW & Steering public API ---

  getActiveTasks(agentKey: string): ActiveTask[] {
    return this.queue.getActiveTasks(agentKey);
  }

  getContextPressure(conversationId: string): ContextPressure | null {
    if (!this.config.memory) return null;

    const hasHistory = this.config.memory.getMessageCount(conversationId) > 0;
    const hasSummary = this.config.memory.getConversationSummary(conversationId) != null;
    if (!hasHistory && !hasSummary) return null;

    const primaryAgentKey = resolvePrimaryAgentKey(this.getAgents(), this.config.nyxhiveConfig?.daemon);
    const model = primaryAgentKey ? this.getAgent(primaryAgentKey)?.model : undefined;
    if (!model) return null;

    return this.conversationMgr.getCompactionManager().assessPressure(
      conversationId,
      model,
      this.config.memory,
    );
  }

  resolveActiveTaskTarget(
    agentKey: string,
    opts: { conversationId?: string; threadId?: string } = {},
  ): ActiveTaskTargetResolution {
    const tasks = this.queue.getActiveTasks(agentKey);
    if (tasks.length === 0) {
      return { error: "agent_idle", status: 409 };
    }

    const conversationId = opts.conversationId?.trim();
    const threadId = opts.threadId?.trim();

    if (conversationId || threadId) {
      const matches = tasks.filter((task) => this.activeTaskMatches(task, { conversationId, threadId }));
      if (matches.length === 1) {
        return { message_id: matches[0].message_id, conversation_id: matches[0].conversation_id };
      }
      if (matches.length > 1) {
        return {
          error: "ambiguous_target",
          status: 400,
          active_conversations: matches.map(({ message_id, conversation_id }) => ({ message_id, conversation_id })),
        };
      }
      return { error: threadId ? "thread_not_found" : "conversation_not_found", status: 404 };
    }

    if (tasks.length === 1) {
      return { message_id: tasks[0].message_id, conversation_id: tasks[0].conversation_id };
    }

    return {
      error: "ambiguous_target",
      status: 400,
      active_conversations: tasks.map(({ message_id, conversation_id }) => ({ message_id, conversation_id })),
    };
  }

  formatActiveTaskResolutionError(
    agentKey: string,
    resolution: ActiveTaskTargetResolutionError,
    opts: { action: "btw" | "steer"; conversationId?: string; threadId?: string },
  ): string {
    const verb = opts.action === "btw" ? "query" : "steer";
    if (resolution.error === "agent_idle") {
      return `Agent '${agentKey}' is idle — no active task to ${verb}`;
    }
    if (resolution.error === "conversation_not_found") {
      return `No active task for agent '${agentKey}' matched conversation_id '${opts.conversationId ?? ""}'`;
    }
    if (resolution.error === "thread_not_found") {
      return `No active task for agent '${agentKey}' matched threadId '${opts.threadId ?? ""}'`;
    }

    const active = resolution.active_conversations?.map((task) => task.conversation_id).filter(Boolean) ?? [];
    const suffix = active.length > 0 ? ` Active conversation_ids: ${active.join(", ")}` : "";
    return `Agent '${agentKey}' has multiple active tasks — provide a conversation_id or threadId.${suffix}`;
  }

  getBtwContext(messageId: string) {
    return this.btwCache.get(messageId);
  }

  async handleBtw(
    agentKey: string,
    messageId: string,
    question: string,
    source: string,
  ): Promise<BtwResponse | null> {
    if (!this.btwLimiter.check(source)) {
      throw new Error("Rate limit exceeded for BTW queries");
    }

    const cached = this.btwCache.get(messageId);
    if (!cached) return null;

    const progress = this.queue.getMessageProgress(messageId);
    const messages = buildBtwMessages(cached, question, {
      activity: progress?.activity ?? undefined,
      text: progress?.text ?? undefined,
    });

    if (!this.config.router) {
      throw new Error("No provider router available for BTW queries");
    }

    const model = "claude-haiku-4-5-20251001";
    const result = await this.config.router.complete({
      model,
      system: cached.systemPrompt,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      maxTokens: 500,
    }, "anthropic", model);

    this.emit("btw:query", { agent: agentKey, source, message_id: messageId });

    return {
      answer: result.content,
      context_tokens: result.tokensIn + result.tokensOut,
      model: result.model,
    };
  }

  async handleSteer(
    agentKey: string,
    targetMessageId: string,
    conversationId: string,
    opts: {
      message: string;
      priority: "normal" | "interrupt";
      source: string;
      channel?: string | null;
      ttl_seconds?: number;
      on_expire?: "discard";
    },
  ): Promise<SteerResponse> {
    if (!this.steersDb) throw new Error("Steers not initialized");

    const steerId = this.steersDb.enqueue({
      target_message_id: targetMessageId,
      target_agent: agentKey,
      conversation_id: conversationId,
      source: opts.source,
      channel: opts.channel ?? null,
      message: opts.message,
      priority: opts.priority,
      ttl_seconds: opts.ttl_seconds,
      on_expire: opts.on_expire,
    });

    this.emit("steer:queued", {
      steer_id: steerId,
      agent: agentKey,
      source: opts.source,
      message_id: targetMessageId,
    });

    return {
      steer_id: steerId,
      status: "queued",
      target_message_id: targetMessageId,
      estimated_delivery: opts.priority === "interrupt" ? "next_checkpoint" : "next_turn",
    };
  }

  // --- End BTW & Steering ---

  private activeTaskMatches(
    task: ActiveTask,
    opts: { conversationId?: string; threadId?: string },
  ): boolean {
    const message = this.queue.getMessageByMessageId(task.message_id);
    const conversationIds = new Set<string>();

    if (task.conversation_id) conversationIds.add(task.conversation_id);
    if (message?.conversation_id) conversationIds.add(message.conversation_id);
    if (message) {
      conversationIds.add(this.conversationMgr.conversationId(message.channel, message.sender_id, message.sender));
    }

    if (opts.conversationId && conversationIds.has(opts.conversationId)) {
      return true;
    }

    if (!opts.threadId) {
      return false;
    }

    if (message?.thread_id === opts.threadId || message?.sender_id === opts.threadId) {
      return true;
    }

    if (conversationIds.has(opts.threadId)) {
      return true;
    }

    return conversationIds.has(this.conversationMgr.conversationId("gateway", opts.threadId));
  }

  constructor(queue: QueueDB, config: ProcessorConfig) {
    this.queue = queue;
    this.config = config;
    this.conversations = new ConversationTracker();
    this.maxConcurrentThreads = config.nyxhiveConfig?.threads?.max_concurrent ?? 5;
    this.loadCliSessions();
    this.initSteers();
  }

  private initSteers(): void {
    const db = this.config.memory?.getDb();
    if (!db) return;
    try {
      this.steersDb = new SteersDB(db);
      logger.info("[processor] SteersDB initialized");
    } catch (err) {
      logger.warn(`[processor] Failed to initialize SteersDB: ${formatError(err)}`);
    }
  }

  /** Load persisted runtime-aware invocation sessions from SQLite on startup. */
  private loadCliSessions(): void {
    const db = this.config.memory?.getDb();
    if (!db) return;
    try {
      db.exec(`CREATE TABLE IF NOT EXISTS cli_sessions (
        key TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        runtime TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER,
        turns INTEGER,
        last_turn_tokens_in INTEGER
      )`);
      const tableInfo = db.query("PRAGMA table_info(cli_sessions)").all() as Array<{ name: string }>;
      const columns = new Set(tableInfo.map((row) => row.name));
      if (!columns.has("runtime")) db.exec("ALTER TABLE cli_sessions ADD COLUMN runtime TEXT");
      if (!columns.has("updated_at")) db.exec("ALTER TABLE cli_sessions ADD COLUMN updated_at INTEGER");
      if (!columns.has("turns")) db.exec("ALTER TABLE cli_sessions ADD COLUMN turns INTEGER");
      if (!columns.has("last_turn_tokens_in")) db.exec("ALTER TABLE cli_sessions ADD COLUMN last_turn_tokens_in INTEGER");
      // Prune sessions older than 30 minutes — thread history provides
      // enough context for resumption, so sessions are just a perf shortcut.
      db.run("DELETE FROM cli_sessions WHERE created_at < ?", [Date.now() - 30 * 60 * 1000]);
      const rows = db.query(
        "SELECT key, session_id, runtime, created_at, updated_at, turns, last_turn_tokens_in FROM cli_sessions",
      ).all() as Array<{
        key: string;
        session_id: string;
        runtime: string | null;
        created_at: number;
        updated_at: number | null;
        turns: number | null;
        last_turn_tokens_in: number | null;
      }>;
      let legacyRows = 0;
      for (const row of rows) {
        if (!isSessionRuntime(row.runtime)) legacyRows++;
        this.cliSessions.set(row.key, {
          sessionId: row.session_id,
          runtime: isSessionRuntime(row.runtime) ? row.runtime : undefined,
          createdAt: row.created_at,
          updatedAt: row.updated_at ?? row.created_at,
          turns: row.turns ?? 0,
          lastTurnTokensIn: row.last_turn_tokens_in ?? undefined,
        });
      }
      if (rows.length > 0) {
        logger.info(
          `[processor] Loaded ${rows.length} persisted sessions${legacyRows > 0 ? ` (${legacyRows} legacy rows without runtime metadata)` : ""}`,
        );
      }
    } catch (err) {
      logger.warn(`[processor] Failed to load CLI sessions: ${err}`);
    }
  }

  /** Persist a runtime-aware invocation session to SQLite. */
  private persistCliSession(key: string, session: CliSessionRecord): void {
    const db = this.config.memory?.getDb();
    if (!db) return;
    try {
      db.run(
        "INSERT OR REPLACE INTO cli_sessions (key, session_id, runtime, created_at, updated_at, turns, last_turn_tokens_in) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [key, session.sessionId, session.runtime ?? null, session.createdAt, session.updatedAt, session.turns, session.lastTurnTokensIn ?? null],
      );
    } catch { /* non-critical */ }
  }

  /** Remove a persisted CLI session. */
  private deleteCliSession(key: string): void {
    const db = this.config.memory?.getDb();
    if (!db) return;
    try {
      db.run("DELETE FROM cli_sessions WHERE key = ?", [key]);
    } catch { /* non-critical */ }
  }

  private discardCliSession(key: string, reason: string): void {
    logger.info(`[processor] Discarding persisted session ${key}: ${reason}`);
    this.cliSessions.delete(key);
    this.deleteCliSession(key);
  }

  private resolveCliSessionId(key: string, agent: AgentConfig): string | undefined {
    const session = this.cliSessions.get(key);
    if (!session) return undefined;
    const expectedRuntime = getExpectedSessionRuntime(agent);
    if (!expectedRuntime) {
      this.discardCliSession(key, "agent no longer supports resumable runtime sessions");
      return undefined;
    }
    if (!session.runtime) {
      this.discardCliSession(key, `legacy row without runtime metadata cannot be resumed safely (expected ${expectedRuntime})`);
      return undefined;
    }
    if (session.runtime !== expectedRuntime) {
      this.discardCliSession(key, `runtime mismatch stored=${session.runtime} expected=${expectedRuntime}`);
      return undefined;
    }
    const rolloverReason: string | null = null;
    if (!rolloverReason) return session.sessionId;
    logger.info(`[processor] Rotating ${expectedRuntime} session ${key}: ${rolloverReason}`);
    this.discardCliSession(key, rolloverReason);
    return undefined;
  }

  private resolveCliSessionIdForTurn(
    key: string,
    agent: AgentConfig,
    turn: { message?: string; runtimeMode?: RuntimeMode | "unknown" },
  ): string | undefined {
    const runtimeMode = turn.runtimeMode ?? "unknown";
    if (!hasRuntimeContinuationIntent(turn.message)) {
      if (this.cliSessions.has(key)) {
        logger.info(`[processor] Not resuming persisted runtime session ${key}: fresh ${runtimeMode} turn without continuation intent`);
      }
      return undefined;
    }
    return this.resolveCliSessionId(key, agent);
  }

  private updateCliSession(key: string, sessionId: string, runtime: SessionRuntime, lastTurnTokensIn?: number): void {
    const previous = this.cliSessions.get(key);
    const now = Date.now();
    const session: CliSessionRecord = {
      sessionId,
      runtime,
      createdAt: previous?.sessionId === sessionId && previous.runtime === runtime ? previous.createdAt : now,
      updatedAt: now,
      turns: previous?.sessionId === sessionId && previous.runtime === runtime ? previous.turns + 1 : 1,
      lastTurnTokensIn: lastTurnTokensIn ?? previous?.lastTurnTokensIn,
    };
    this.cliSessions.set(key, session);
    this.persistCliSession(key, session);
  }

  private resolveSessionRuntimeForResult(
    agent: AgentConfig,
    result: Pick<InvocationResult, "method" | "session_id" | "session_runtime">,
  ): SessionRuntime | undefined {
    if (!result.session_id) return undefined;
    if (result.session_runtime) return result.session_runtime;
    if (result.method === "cli") return "claude_cli";
    if (result.method === "api") return "native_api";
    return undefined;
  }

  private rememberInvocationSession(
    key: string,
    agent: AgentConfig,
    result: Pick<InvocationResult, "method" | "session_id" | "session_runtime" | "last_turn_tokens_in">,
  ): void {
    if (!result.session_id) return;
    const runtime = this.resolveSessionRuntimeForResult(agent, result);
    if (!runtime) {
      logger.warn(`[processor] Skipping session persistence for ${key}: missing runtime metadata for method=${result.method}`);
      return;
    }
    this.updateCliSession(key, result.session_id, runtime, result.last_turn_tokens_in);
  }

  private seedCliSessionFromHandle(key: string, handle?: SuspendedProcessHandle): void {
    if (!handle?.session_id) return;
    const runtime = isSessionRuntime(handle.session_runtime) ? handle.session_runtime : undefined;
    if (!runtime) return;
    const previous = this.cliSessions.get(key);
    const now = Date.now();
    const session: CliSessionRecord = {
      sessionId: handle.session_id,
      runtime,
      createdAt: previous?.sessionId === handle.session_id && previous.runtime === runtime ? previous.createdAt : now,
      updatedAt: now,
      turns: previous?.sessionId === handle.session_id && previous.runtime === runtime ? previous.turns : 0,
      lastTurnTokensIn: previous?.lastTurnTokensIn,
    };
    this.cliSessions.set(key, session);
    this.persistCliSession(key, session);
  }

  private rememberSuspendedRequest(convId: string, suspended: SuspendedMessage): void {
    this.pendingClarifications.set(convId, {
      messageId: suspended.message_id,
      requestId: suspended.request_id,
      originalMessage: suspended.original_message,
      agent: suspended.agent ?? "",
      question: suspended.request.question,
      options: suspended.request.options ?? [],
      processHandle: suspended.process_handle,
      timeoutAt: suspended.timeout_at,
      threadId: suspended.thread_id,
      timestamp: suspended.suspended_at,
    });
  }

  private clearSuspendedRequest(convId: string, messageId?: string): void {
    this.pendingClarifications.delete(convId);
    if (messageId) {
      this.queue.clearSuspendedMessage(messageId);
    }
  }

  private emitInputRequested(suspended: SuspendedMessage): void {
    this.emit("input.requested", {
      message_id: suspended.message_id,
      requestId: suspended.request_id,
      agent: suspended.agent,
      channel: suspended.channel,
      sender_id: suspended.sender_id,
      threadId: suspended.thread_id,
      question: suspended.request.question,
      options: suspended.request.options ?? [],
      createdAt: suspended.suspended_at,
    });
  }

  private emitInputResolved(suspended: SuspendedMessage, resolution: string, channel?: string, senderId?: string): void {
    this.emit("request.resolved", {
      requestId: suspended.request_id,
      kind: "user_input",
      resolution,
      resolvedAt: Date.now(),
      channel: channel ?? suspended.channel,
      sender_id: senderId ?? suspended.sender_id,
      threadId: suspended.thread_id,
    });
  }

  private suspendMessageRun(opts: {
    messageId: string;
    convId: string;
    channel: string;
    sender: string;
    senderId?: string;
    taskId?: string;
    agentKey: string;
    threadId?: string;
    originalMessage: string;
    responseText: string;
    request: InputRequest;
    result: InvocationResult;
  }): SuspendedMessage {
    const requestId = `input:${opts.messageId}:${randomUUID().slice(0, 8)}`;
    const suspended = this.queue.suspendMessage({
      messageId: opts.messageId,
      channel: opts.channel,
      sender: opts.sender,
      sender_id: opts.senderId,
      task_id: opts.taskId,
      agent: opts.agentKey,
      thread_id: opts.threadId,
      original_message: opts.originalMessage,
      requestId,
      request: {
        ...opts.request,
        timeout_ms: opts.request.timeout_ms ?? INPUT_REQUEST_TIMEOUT_MS,
      },
      responseText: opts.responseText,
      processHandle: processHandleFromResult(opts.result),
    });
    this.rememberSuspendedRequest(opts.convId, suspended);
    this.emitInputRequested(suspended);
    logger.info(`[processor] Input requested by ${opts.agentKey} for ${opts.convId}: "${opts.request.question}"`);
    return suspended;
  }

  private findSuspendedRunForReply(channel: string, sender: string, senderId?: string): { convId: string; suspended: SuspendedMessage } | null {
    const convId = this.conversationMgr.conversationId(channel, senderId, sender);
    const pending = this.pendingClarifications.get(convId);
    if (pending?.messageId) {
      const suspended = this.queue.getSuspendedMessage(pending.messageId);
      if (suspended && suspended.channel === channel) {
        return { convId, suspended };
      }
      this.pendingClarifications.delete(convId);
    }

    const suspended = this.queue.getSuspendedForSender(channel, sender, senderId);
    if (!suspended) return null;
    this.rememberSuspendedRequest(convId, suspended);
    return { convId, suspended };
  }

  async resumeSuspendedMessage(
    messageId: string,
    reply: string,
    opts: {
      async?: boolean;
      channel?: string;
      sender?: string;
      sender_id?: string;
      sender_role?: string;
      thread_id?: string;
      onProgress?: (info: CLIProgress) => void;
      onEvent?: (event: SSEEvent) => void;
    } = {},
  ): Promise<{ message_id: string; status: "resumed"; response?: string; agent?: string; trace_id?: string }> {
    const suspended = this.queue.getSuspendedMessage(messageId);
    if (!suspended) {
      throw new Error("Suspended message not found");
    }

    const convId = this.conversationMgr.conversationId(suspended.channel, suspended.sender_id, suspended.sender);
    this.pendingClarifications.delete(convId);
    this.emitInputResolved(suspended, "responded", opts.channel, opts.sender_id);

    if (opts.async) {
      const resumed = this.queue.resumeSuspendedMessage(messageId, reply, "pending");
      if (!resumed) {
        throw new Error("Failed to resume suspended message");
      }
      return { message_id: messageId, status: "resumed" };
    }

    const result = await this.processImmediate({
      channel: opts.channel ?? suspended.channel,
      sender: opts.sender ?? suspended.sender,
      sender_id: opts.sender_id ?? suspended.sender_id,
      sender_role: opts.sender_role,
      thread_id: opts.thread_id ?? suspended.thread_id,
      task_id: suspended.task_id,
      message: reply,
      agent: suspended.agent,
      onProgress: opts.onProgress,
      onEvent: opts.onEvent,
      _resumeMessageId: messageId,
      _resumeProcessHandle: suspended.process_handle,
      _resumeRequestId: suspended.request_id,
    });

    return { message_id: result.message_id, status: "resumed", response: result.response, agent: result.agent, trace_id: result.trace_id };
  }

  private getKernelRuntime(): AgentKernelRuntime {
    return this.config.kernelRuntime ?? new ExistingAgentRuntimeAdapter({
      baseDir: this.config.baseDir,
      config: this.config.nyxhiveConfig,
    });
  }

  private shouldUseKernelPrimaryPath(opts: {
    agentKey: string;
    message: string;
    useRalphMode: boolean;
    resumeProcessHandle?: SuspendedProcessHandle;
  }): boolean {
    if (resolveKernelRuntimeMode(this.config.nyxhiveConfig) !== "kernel") return false;
    if (opts.useRalphMode || opts.resumeProcessHandle) return false;
    if (hasLeadingAgentMention(opts.message)) return false;
    const primaryAgent = this.config.defaultAgent
      ?? resolvePrimaryAgentKey(this.getAgents(), this.config.nyxhiveConfig?.daemon);
    return opts.agentKey === primaryAgent;
  }

  private async invokeKernelRuntimeForImmediate(opts: {
    agentKey: string;
    agentConfig: AgentConfig;
    message: string;
    messageId: string;
    channel: string;
    sender?: string;
    senderId?: string;
    threadId?: string;
    conversationId?: string;
    files?: FileAttachment[];
    invokeOpts: InvokeOpts;
    emitImmediateEvent: (type: string, data: Record<string, unknown>) => void;
  }): Promise<InvocationResult> {
    const startedAt = Date.now();
    let response: string | undefined;
    let model: string | undefined;
    let tokensIn: number | undefined;
    let tokensOut: number | undefined;
    let costCents: number | undefined;

    const runtime = this.getKernelRuntime();
    for await (const event of runtime.stream({
      message: opts.message,
      agentKey: opts.agentKey,
      agent: opts.agentConfig,
      channel: opts.channel,
      sender: opts.sender,
      senderId: opts.senderId,
      threadId: opts.threadId,
      conversationId: opts.conversationId,
      attachments: opts.files,
      metadata: {
        messageId: opts.messageId,
        invokeOpts: opts.invokeOpts,
      },
    })) {
      const sse = kernelEventToSSE(event);
      opts.emitImmediateEvent(sse.type, {
        ...sse.data,
        message_id: opts.messageId,
        agent: opts.agentKey,
        channel: opts.channel,
        sender_id: opts.senderId,
      });

      if (event.type === "kernel:usage") {
        model = event.model ?? model;
        tokensIn = event.input_tokens ?? tokensIn;
        tokensOut = event.output_tokens ?? tokensOut;
        costCents = event.cost_cents ?? costCents;
      } else if (event.type === "kernel:response") {
        response = event.response;
        costCents = event.cost_cents ?? costCents;
      }
    }

    if (response === undefined) {
      throw new Error(`Kernel runtime produced no response for message ${opts.messageId}`);
    }

    return {
      response,
      agent: opts.agentKey,
      method: "api",
      model,
      tokens_in: tokensIn,
      tokens_out: tokensOut,
      cost: costCents === undefined ? undefined : costCents / 100,
      duration_ms: Date.now() - startedAt,
    };
  }

  /** Number of in-flight agent invocations (chains + threads). */
  getInflightCount(): number {
    return this.agentChains.size + this.threadPool.size;
  }

  /** Get all in-flight delegation tasks, keyed by delegation ID. Used by orchestrators to answer status questions. */
  getActiveDelegations(): Map<string, { agent: string; task: string; dispatchedAt: number; convId: string; fromAgent: string }> {
    return this.activeDelegations;
  }

  /** Access the entity-relationship graph memory (optional subsystem). */
  getGraphMemory(): import("../memory/graph.js").GraphMemory | undefined {
    return this.config.graphMemory;
  }

  /** Access the vector-indexed knowledge store (optional subsystem). */
  getKnowledge(): import("../memory/knowledge.js").KnowledgeStore | undefined {
    return this.config.knowledge;
  }

  /** Access the execution trace store for cost/performance analytics (optional subsystem). */
  getTraces(): import("../memory/traces.js").TraceStore | undefined {
    return this.config.traces;
  }

  /** Access the pattern store for learned delegation/routing patterns (optional subsystem). */
  getPatterns(): PatternStore | undefined {
    return this.config.patterns;
  }

  /** Access the outcome store for task success/failure tracking (optional subsystem). */
  getOutcomes(): OutcomeStore | undefined {
    return this.config.outcomes;
  }

  /** Access the routing store for learned delegation routing (optional subsystem). */
  getRouting(): import("../memory/routing.js").RoutingStore | undefined {
    return this.config.routing;
  }

  /** Access the embedding provider (optional subsystem). */
  getEmbedder(): import("../memory/embeddings.js").EmbeddingProvider | undefined {
    return this.config.embedder;
  }

  /** Set a per-sender model override for an agent. Returns the resolved model name, or null if agent not found. */
  setModelOverride(senderId: string, agentKey: string, model: string): string | null {
    return this.modelOverridesMgr.set(senderId, agentKey, model, (key) => this.getAgent(key));
  }

  /** Clear a sender's model override for a specific agent. */
  clearModelOverride(senderId: string, agentKey: string): void {
    this.modelOverridesMgr.clear(senderId, agentKey);
  }

  /** Clear all model overrides for a sender across all agents. */
  clearAllModelOverrides(senderId: string): void {
    this.modelOverridesMgr.clearAll(senderId);
  }

  /** Get the raw model override string for a sender+agent pair, if set. */
  getModelOverride(senderId: string, agentKey: string): string | undefined {
    return this.modelOverridesMgr.get(senderId, agentKey);
  }

  /** Get the provider override for a sender+agent pair, if set. */
  getModelOverrideProvider(senderId: string, agentKey: string): string | undefined {
    return this.modelOverridesMgr.getProvider(senderId, agentKey);
  }

  /** Get the effective model for a sender+agent: override if set, otherwise agent's default. */
  getEffectiveModel(senderId: string, agentKey: string): string {
    return this.modelOverridesMgr.getEffective(senderId, agentKey, (key) => this.getAgent(key));
  }

  /** Get the agent's natural default model (accounting for min/max pin). */
  getNaturalDefault(agentKey: string): string {
    return this.modelOverridesMgr.getNaturalDefault(agentKey, (key) => this.getAgent(key));
  }

  /** Get routing stats: success rates by model + task type, and hint usage */
  getRoutingStats(sinceHours = 168): {
    successRates: Array<{ model: string; task_type: string; total: number; completed: number; failed: number; success_rate: number; avg_cost: number; avg_duration_ms: number }>;
    hintStats: Array<{ model_hint: string; resolved_model: string | null; total: number; completed: number; failed: number; avg_cost: number }>;
  } | null {
    if (!this.config.traces) return null;
    return {
      successRates: this.config.traces.getSuccessRates(sinceHours),
      hintStats: this.config.traces.getHintStats(sinceHours),
    };
  }

  /** Look up an agent config, preferring registry if available */
  private getAgent(key: string): AgentConfig | undefined {
    return this.config.registry?.get(key) ?? this.config.agents[key];
  }

  /** Get all enabled agents as a record, preferring registry */
  private getAgents(): Record<string, AgentConfig> {
    return this.config.registry?.getAll() ?? this.config.agents;
  }

  /** Get the set of known agent keys for actor model matching */
  private getKnownAgentKeys(): Set<string> {
    return this.config.registry?.getKnownAgentKeys() ?? new Set(Object.keys(this.config.agents));
  }

  /** Get the registry if available (for stats tracking) */
  getRegistry(): AgentRegistry | undefined {
    return this.config.registry;
  }

  /** Check if an agent is a pure orchestrator (read-only, skips knowledge search) */
  private isOrchestratorAgent(agentKey: string): boolean {
    return this.config.registry?.getEntry(agentKey)?.role === "orchestrator";
  }

  /** Check if an agent can orchestrate (orchestrator or lead — gets re-entry loop, active delegations, management) */
  private canOrchestrate(agentKey: string): boolean {
    const role = this.config.registry?.getEntry(agentKey)?.role;
    return role === "orchestrator" || role === "lead";
  }

  private isCompanionAgent(agentKey: string): boolean {
    return this.getAgent(agentKey)?.companion_mode === true;
  }

  private shouldInjectCompanionContext(convId: string): boolean {
    if (!this.config.memory) return true;
    const last = this.config.memory.getLastMessages(convId, 1).at(-1);
    if (!last) return true;
    return Date.now() - last.created_at >= 6 * 60 * 60 * 1000;
  }

  private buildCompanionContextBlock(convId: string): string | null {
    const lastSeenAt = this.config.memory?.getLastMessages(convId, 1).at(-1)?.created_at ?? 0;
    const workflowMode = this.config.nyxhiveConfig?.daemon.workflow_mode ?? "direct";

    const pending = this._proposalStore?.listPending().slice(0, 5)
      .map((proposal) => `- #${proposal.proposal_id.replace("proposal-", "")}: ${proposal.title} (${proposal.priority}, ${proposal.effort})`) ?? [];

    const fleet = this.getFleetHealthSummary();

    const recentChanges: string[] = [];
    if (this._proposalStore) {
      for (const proposal of this._proposalStore.list().filter((item) => item.updated_at > lastSeenAt).slice(0, 4)) {
        recentChanges.push(`- Proposal ${proposal.proposal_id.replace("proposal-", "#")} is now ${proposal.status}: ${proposal.title}`);
      }
    }
    if (this.config.knowledge) {
      for (const chunk of this.config.knowledge.getRecentChunks(3)) {
        if ((chunk.category ?? "").toLowerCase().includes("decision")) {
          recentChanges.push(`- Decision note: ${chunk.title}`);
        }
      }
    }
    const escalations: string[] = [];
    for (const [slug, state] of this.remoteMcpHealth) {
      if (state.status === "down") {
        escalations.push(`- ${slug} MCP is down${state.error ? `: ${state.error}` : ""}`);
      }
    }
    for (const [agentKey, failure] of this.consecutiveFailures) {
      if (failure.count >= 2) {
        escalations.push(`- @${agentKey} has ${failure.count} consecutive failures`);
      }
    }
    if (escalations.length > 0) {
      // retained below through the shared companion-context builder
    }
    const proceduralStatus = this.config.proceduralSkills
      ? summarizeProceduralSkillCompanionStatus(this.config.proceduralSkills.list({ limit: 100 }))
      : null;

    return buildCompanionContext({
      workflowMode,
      pendingProposals: pending,
      fleetSummary: fleet,
      recentChanges,
      escalations,
      proceduralSkills: proceduralStatus,
    });
  }

  recordRemoteMcpHealth(slug: string, url: string, status: "up" | "down" | "unknown", error?: string): boolean {
    const previous = this.remoteMcpHealth.get(slug);
    const changed = !previous || previous.status !== status || previous.error !== error || previous.url !== url;
    this.remoteMcpHealth.set(slug, {
      url,
      status,
      lastChecked: Date.now(),
      ...(error ? { error } : {}),
    });
    return changed;
  }

  getFleetHealthSummary(): string {
    const lines: string[] = [];
    const runningAgents = new Set(this.activeProcesses.values().map((entry) => entry.agent));
    for (const [key] of Object.entries(this.getAgents())) {
      lines.push(`- @${key}: ${runningAgents.has(key) ? "busy" : "ready"}`);
    }

    const knownRemotes = Object.entries(this.config.nyxhiveConfig?.remotes ?? {}).map(([name, remote]) => {
      const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || name;
      const state = this.remoteMcpHealth.get(slug);
      const status = state?.status ?? "unknown";
      const error = status === "down" && state?.error ? ` (${state.error})` : "";
      return `- remote ${name}: ${status}${error}`;
    });

    return [...knownRemotes, ...lines].join("\n");
  }

  formatPendingProposals(limit = 5): string {
    const proposals = this._proposalStore?.listPending().slice(0, limit) ?? [];
    if (proposals.length === 0) return "No proposals awaiting review.";
    return proposals
      .map((proposal) => `#${proposal.proposal_id.replace("proposal-", "")} ${proposal.title} (${proposal.priority}, ${proposal.effort})`)
      .join("\n");
  }

  getConversationUsageSummary(channel: string, senderId?: string, sender?: string): ConversationUsageSummary | null {
    if (!this.config.memory) return null;
    const convId = this.conversationMgr.conversationId(channel, senderId, sender);
    const usage = this.config.memory.getConversationUsage(convId);
    return usage.message_count > 0 ? usage : null;
  }

  handleProposalDecision(action: "approve" | "reject", shortId: string, actor: string, reason?: string): { ok: boolean; response: string } {
    if (!this._proposalStore) {
      return { ok: false, response: "Proposal store is not available." };
    }

    const proposalId = shortId.startsWith("proposal-") ? shortId : `proposal-${shortId}`;
    const proposal = this._proposalStore.get(proposalId);
    if (!proposal) {
      return { ok: false, response: `Proposal #${shortId} not found.` };
    }
    if (!["proposed", "reviewing", "reviewed"].includes(proposal.status)) {
      return { ok: false, response: `Proposal #${shortId} is already ${proposal.status}.` };
    }

    if (action === "approve") {
      this._proposalStore.approve(proposalId, actor);
      this.emit("proposal:approved", {
        proposal_id: proposalId,
        title: proposal.title,
        category: proposal.category,
        proposed_by: proposal.proposed_by,
        approved_by: actor,
      });
      if (this._proposalExecutor) {
        this._proposalExecutor.onApproved(proposalId, "approval").catch((err) =>
          logger.error(`[processor] Auto-execute on approval failed: ${err}`)
        );
      }
      return {
        ok: true,
        response: `Proposal #${shortId} approved: "${proposal.title}" — execution starting.`,
      };
    }

    const rejectionReason = reason?.trim() || `Rejected via inline action by ${actor}`;
    const rejected = this._proposalStore.reject(proposalId, rejectionReason);
    if (rejected) {
      this.emit("proposal:rejected", {
        proposal_id: proposalId,
        title: rejected.title,
        category: rejected.category,
        proposed_by: rejected.proposed_by,
        reason: rejectionReason,
      });
    }
    return {
      ok: true,
      response: `Proposal #${shortId} rejected: ${rejectionReason}`,
    };
  }

  getProposalDetails(shortId: string): string {
    const proposalId = shortId.startsWith("proposal-") ? shortId : `proposal-${shortId}`;
    const proposal = this._proposalStore?.get(proposalId);
    if (!proposal) return `Proposal #${shortId} not found.`;
    const files = proposal.files_affected.length > 0 ? proposal.files_affected.join(", ") : "none listed";
    return [
      `Proposal #${shortId}: ${proposal.title}`,
      `Status: ${proposal.status} | Category: ${proposal.category} | Priority: ${proposal.priority} | Effort: ${proposal.effort}`,
      `Proposed by: ${proposal.proposed_by}`,
      `Files: ${files}`,
      "",
      proposal.description,
    ].join("\n");
  }

  /** Set the scheduler reference (needed for workspace docs, added after construction) */
  setScheduler(scheduler: import("../scheduler/index.js").Scheduler): void {
    this._scheduler = scheduler;
  }
  private _scheduler?: import("../scheduler/index.js").Scheduler;

  /** Set the channels array (for outbound alert delivery) */
  setChannels(channels: import("../channels/types.js").Channel[]): void {
    this._channels = channels;
  }
  /** Get the registered channel adapters (Discord, Telegram, Slack, etc.). */
  getChannels(): import("../channels/types.js").Channel[] | undefined {
    return this._channels;
  }
  private _channels?: import("../channels/types.js").Channel[];

  private _batcher?: import("../notifications/batcher.js").NotificationBatcher;

  /** Inject the notification batcher (set post-construction during server bootstrap). */
  setBatcher(batcher: import("../notifications/batcher.js").NotificationBatcher): void {
    this._batcher = batcher;
  }

  /** Get the notification batcher for coalesced delivery. */
  getBatcher(): import("../notifications/batcher.js").NotificationBatcher | undefined {
    return this._batcher;
  }

  private _classifierFeedback?: import("../soul/classifier-feedback.js").ClassifierFeedbackStore;

  setClassifierFeedback(store: import("../soul/classifier-feedback.js").ClassifierFeedbackStore): void {
    this._classifierFeedback = store;
  }

  getClassifierFeedback(): import("../soul/classifier-feedback.js").ClassifierFeedbackStore | undefined {
    return this._classifierFeedback;
  }

  /** Emit an SSE event to all connected gateway/channel listeners. */
  emitEvent(type: string, data: Record<string, unknown>): void {
    this.emit(type, data);
  }
  private _devPlanStore?: DevPlanStore;

  /** Inject the dev plan store (set post-construction during server bootstrap). */
  setDevPlanStore(store: DevPlanStore): void {
    this._devPlanStore = store;
  }

  /** Get the dev plan store for structured multi-step task planning. */
  getDevPlanStore(): DevPlanStore | undefined {
    return this._devPlanStore;
  }

  private _threadDb?: import("../server/db/threads.js").ThreadDB;

  /** Inject the thread DB (set post-construction during server bootstrap). */
  setThreadDb(db: import("../server/db/threads.js").ThreadDB): void {
    this._threadDb = db;
  }

  private _proposalStore?: import("../proposals/store.js").ProposalStore;
  private _proposalExecutor?: import("../proposals/executor.js").ProposalExecutor;

  /** Inject the proposal store for change proposals (set post-construction). */
  setProposalStore(store: import("../proposals/store.js").ProposalStore): void {
    this._proposalStore = store;
  }

  /** Get the proposal store for querying/managing change proposals. */
  getProposalStore(): import("../proposals/store.js").ProposalStore | undefined {
    return this._proposalStore;
  }

  /** Inject the proposal executor for running approved proposals (set post-construction). */
  setProposalExecutor(executor: import("../proposals/executor.js").ProposalExecutor): void {
    this._proposalExecutor = executor;
  }

  /** Get the proposal executor (if configured). */
  getProposalExecutor(): import("../proposals/executor.js").ProposalExecutor | undefined {
    return this._proposalExecutor;
  }

  getPendingClarification(channel: string, senderId?: string, sender?: string): {
    requestId: string;
    originalMessage: string;
    agent: string;
    question: string;
    options: InputRequestOption[];
    threadId?: string;
    timestamp: number;
  } | null {
    const convId = this.conversationMgr.conversationId(channel, senderId, sender);
    const pending = this.pendingClarifications.get(convId);
    if (!pending) return null;
    if (Date.now() - pending.timestamp > 5 * 60 * 1000) {
      this.pendingClarifications.delete(convId);
      return null;
    }
    return { ...pending, options: [...pending.options] };
  }

  /**
   * Resolve the agent to execute an approved proposal.
   * System categories (new_instance, configuration) go to orchestrator.
   * All other categories (code work) go directly to the coder agent.
   * Fallback: first non-orchestrator, then first agent.
   */
  resolveProposalAgent(
    category: string,
    _filesAffected: string[],
  ): string {
    const agents = this.getAgents();
    const registry = this.config.registry;

    // System categories require orchestrator (delegation/coordination work)
    const SYSTEM_CATEGORIES = new Set(["new_instance", "configuration"]);

    // Find orchestrator and coder keys
    let orchestratorKey: string | undefined;
    let coderKey: string | undefined;
    let firstNonOrchestrator: string | undefined;

    // Only consider enabled agents that are in the active agents map
    const activeKeys = new Set(Object.keys(agents));

    if (registry) {
      for (const [key, entry] of registry.getAllEntries()) {
        if (!activeKeys.has(key)) continue;
        if ((entry.role === "orchestrator" || entry.role === "lead") && !orchestratorKey) orchestratorKey = key;
        if (entry.role === "coder" && !coderKey) coderKey = key;
        if (entry.role !== "orchestrator" && entry.role !== "lead" && !firstNonOrchestrator) firstNonOrchestrator = key;
      }
    } else {
      for (const [key, config] of Object.entries(agents)) {
        if ((config.role === "orchestrator" || config.role === "lead") && !orchestratorKey) orchestratorKey = key;
        if (config.role === "coder" && !coderKey) coderKey = key;
        if (config.role !== "orchestrator" && config.role !== "lead" && !firstNonOrchestrator) firstNonOrchestrator = key;
      }
    }

    const fallback = orchestratorKey ?? Object.keys(agents)[0];

    if (SYSTEM_CATEGORIES.has(category)) {
      const resolved = orchestratorKey ?? fallback;
      logger.debug(`[processor] resolveProposalAgent(${category}) → ${resolved} (system category)`);
      return resolved;
    }

    // Code categories: prefer coder, fallback to lead/orchestrator (lead codes directly now)
    const resolved = coderKey ?? fallback;
    logger.debug(`[processor] resolveProposalAgent(${category}) → ${resolved} (coder=${coderKey}, orch=${orchestratorKey})`);
    return resolved;
  }

  /**
   * Resolve the agent to use for proposal review flows.
   * Prefer explicitly requested keys when they exist on the current instance.
   * Fallback order: reviewer -> lead/orchestrator -> expert -> default/first agent.
   */
  resolveReviewAgent(preferredAgents: string[] = []): string {
    const agents = this.getAgents();
    const keys = Object.keys(agents);
    if (keys.length === 0) {
      throw new Error("No agents configured");
    }

    for (const preferred of preferredAgents) {
      const match = keys.find((key) => key.toLowerCase() === preferred.toLowerCase());
      if (match) {
        logger.debug(`[processor] resolveReviewAgent(${preferredAgents.join(",")}) → ${match} (preferred)`);
        return match;
      }
    }

    const byRole = (roles: Array<NonNullable<AgentConfig["role"]>>): string | undefined =>
      keys.find((key) => {
        const role = agents[key]?.role;
        return role ? roles.includes(role) : false;
      });

    const resolved = byRole(["reviewer"])
      ?? byRole(["lead", "orchestrator"])
      ?? byRole(["expert"])
      ?? (this.config.defaultAgent && agents[this.config.defaultAgent] ? this.config.defaultAgent : undefined)
      ?? keys[0];

    logger.debug(`[processor] resolveReviewAgent(${preferredAgents.join(",")}) → ${resolved} (fallback)`);
    return resolved;
  }

  resolveProposalReviewModel(preferredAgents: string[] = [], requestedModel?: string): string {
    const primaryAgentKey = resolvePrimaryAgentKey(this.getAgents(), this.config.nyxhiveConfig?.daemon);
    const reviewAgentKey = this.resolveReviewAgent(preferredAgents);

    return selectProposalReviewModel({
      requestedModel,
      primaryAgent: primaryAgentKey ? this.getAgent(primaryAgentKey) : undefined,
      reviewAgent: reviewAgentKey ? this.getAgent(reviewAgentKey) : undefined,
    });
  }

  /**
   * Resolve the repo path for proposal execution from affected file paths.
   * Uses the instance's allowed_directories to find the most likely repo root.
   * Falls back to the first allowed_directory or the config's base path.
   */
  resolveProposalRepoPath(filesAffected: string[]): string {
    const fs = require("node:fs");
    const projects = (this.config.nyxhiveConfig as any)?.daemon?.projects as Array<{ name: string; repo_path: string; default?: boolean }> | undefined;

    // Sanitize: only allow relative paths without traversal components
    const safePaths = filesAffected.filter(f => {
      if (!f || f.includes("\0")) return false;
      // Reject absolute paths and directory traversal
      if (f.startsWith("/") || f.startsWith("\\") || f.includes("..")) return false;
      return true;
    });

    // Best match: check which project actually contains the affected files
    if (safePaths.length > 0 && projects) {
      for (const proj of projects) {
        const matches = safePaths.filter(f => {
          try { return fs.existsSync(join(proj.repo_path, f)); } catch { return false; }
        });
        if (matches.length > 0) return proj.repo_path;
      }
    }

    // Fallback: default project
    if (projects) {
      const defaultProj = projects.find(p => p.default);
      if (defaultProj) return defaultProj.repo_path;
      return projects[0].repo_path;
    }

    // Check allowed_directories for one with src/
    const allowedDirs = this.config.nyxhiveConfig?.allowed_directories ?? [];
    if (safePaths.some(f => f.startsWith("src/"))) {
      for (const dir of allowedDirs) {
        try {
          if (fs.existsSync(join(dir, "src"))) return dir;
        } catch { /* ignore */ }
      }
    }

    if (allowedDirs.length > 0) return allowedDirs[0];
    return process.cwd();
  }

  /** Subscribe to all SSE events (message responses, progress, errors). Returns unsubscribe function. */
  onEvent(listener: (event: SSEEvent) => void): () => void {
    return this.eventBus.onEvent(listener);
  }

  /** Subscribe to events for a specific thread. Returns unsubscribe function. */
  onThreadEvent(threadId: string, callback: (event: ThreadEvent) => void): () => void {
    return this.eventBus.onThreadEvent(threadId, callback);
  }

  /** Subscribe to ALL thread events globally (for status bars, dashboards). Returns unsubscribe function. */
  onGlobalThreadEvent(callback: (event: ThreadEvent) => void): () => void {
    return this.eventBus.onGlobalThreadEvent(callback);
  }

  /** Emit a thread-scoped event to per-thread subscribers and global listeners. */
  emitThreadEvent(threadId: string, type: string, data: Record<string, unknown>): void {
    this.eventBus.emitThreadEvent(threadId, type, data);
  }

  private emit(type: string, data: Record<string, unknown>): void {
    if (type === "response:delta" && typeof data.text_so_far === "string") {
      const cleanTextSoFar = sanitizeAssistantResponse(data.text_so_far);
      if (!cleanTextSoFar) return;
      this.eventBus.emit(type, {
        ...data,
        text_delta: cleanTextSoFar === data.text_so_far.trim() ? data.text_delta : "",
        text_so_far: cleanTextSoFar,
      });
      return;
    }
    this.eventBus.emit(type, data);
  }

  private buildInvocationTokenReport(params: {
    scope: string;
    model: string;
    systemPromptResult: BuildSystemPromptResult;
    conversationHistory: Array<{ role: "user" | "assistant"; content: string }>;
    ctxMetrics: ContextMetrics;
  }): TokenDisciplineReport {
    const historyChars = params.conversationHistory.reduce((sum, msg) => sum + msg.content.length, 0);
    const report = buildTokenDisciplineReport({
      scope: params.scope,
      contextWindow: getContextWindow(params.model) || undefined,
      contributors: [
        {
          label: "system_prompt",
          charCount: params.systemPromptResult.prompt.length,
          tokenEstimate: params.systemPromptResult.trace.totalTokens,
        },
        {
          label: "history",
          charCount: historyChars,
          tokenEstimate: params.ctxMetrics.tokenCount,
        },
        {
          label: "response_reserve",
          charCount: 0,
          tokenEstimate: 4096,
          source: "reserved",
        },
      ],
    });
    logTokenDisciplineWarnings(report);
    return report;
  }

  private tokenReportEventFields(report: TokenDisciplineReport): Record<string, unknown> {
    return {
      tokenContributors: report.contributors,
      tokenDiscipline: {
        scope: report.scope,
        totalTokens: report.totalTokens,
        contextWindow: report.contextWindow,
        utilizationPct: report.utilizationPct,
      },
      warnings: report.warnings,
    };
  }

  /** Start the message processing poll loop. Idempotent — calling while running is a no-op. */
  start(): void {
    if (this.running) return;
    this.running = true;

    // Reset orphaned messages from previous crash before processing anything.
    // Use minAgeMs=0 to catch all stuck messages, not just stale ones.
    const orphaned = this.queue.resetOrphans(5 * 60 * 1000, 0, { maxWallAgeMs: AGENT_TIMEOUT_MS });
    if (orphaned > 0) {
      logger.info(`[processor] Reset ${orphaned} orphaned processing message(s) to pending`);
    }

    logger.info("[processor] Started");
    this.pollLoop();
  }

  /** Stop the processing loop. In-flight invocations complete but no new messages are dequeued. */
  stop(): void {
    this.running = false;
    logger.info("[processor] Stopped");
  }

  /**
   * Graceful drain — stop accepting new work and wait for in-flight tasks to complete.
   * Returns a promise that resolves when all active work finishes, or rejects on timeout.
   * Used during graceful shutdown to avoid losing work.
   */
  async drain(timeoutMs = 10_000): Promise<{ drained: boolean; inflight: number }> {
    this.running = false;

    const allWork = [
      ...Array.from(this.agentChains.values()),
      ...Array.from(this.threadPool.values()),
    ];

    if (allWork.length === 0) {
      logger.info("[processor] Drain complete — no in-flight work");
      return { drained: true, inflight: 0 };
    }

    logger.info(`[processor] Draining ${allWork.length} in-flight task(s)...`);

    try {
      await Promise.race([
        Promise.allSettled(allWork),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("drain timeout")), timeoutMs),
        ),
      ]);
      logger.info("[processor] Drain complete — all in-flight work finished");
      return { drained: true, inflight: 0 };
    } catch {
      const remaining = this.agentChains.size + this.threadPool.size;
      logger.warn(`[processor] Drain timed out — ${remaining} task(s) still in-flight`);
      return { drained: false, inflight: remaining };
    }
  }

  /**
   * Critical system tasks that always run regardless of budget.
   * These are maintenance tasks that cost nothing (no LLM calls) or are essential for system health.
   */
  private static readonly CRITICAL_AUTONOMOUS_TASKS = new Set([
    "health-check",
    "heartbeat:health-check",
    "reset-stale-reviewing",
    "proposals:reset-stale-reviewing",
    "sync-merged",
    "proposals:sync-merged",
    "execute-approved",
    "dev:execute-approved",
    "memory:maintenance",
  ]);

  /**
   * Check whether an autonomous task should run given current budget usage.
   * Critical tasks (health checks, system maintenance) always run.
   * Non-critical tasks are deferred when daily budget usage exceeds the autonomous ceiling,
   * and halted entirely at 95%.
   */
  shouldRunAutonomousTask(taskName: string, isCritical?: boolean): boolean {
    if (isCritical || QueueProcessor.CRITICAL_AUTONOMOUS_TASKS.has(taskName)) return true;
    if (!this.config.memory) return true;

    const dailyCost = this.config.memory.getTotalCost(24);
    const budgetCfg = getBudgetConfig(this.config.nyxhiveConfig?.budget);
    if (budgetCfg.monthly <= 0 && budgetCfg.dailyLimit <= 0) return true; // no budget configured

    const dailyBudget = budgetCfg.dailyLimit > 0 ? budgetCfg.dailyLimit : budgetCfg.monthly / 30;
    const ceiling = this.config.nyxhiveConfig?.budget?.autonomous_ceiling ?? AUTONOMOUS_BUDGET_CEILING;

    if (dailyCost > dailyBudget * 0.95) {
      logger.warn(`[budget] Autonomous task ${taskName} halted — 95% daily budget spent ($${dailyCost.toFixed(2)} / $${dailyBudget.toFixed(2)})`);
      return false;
    }
    if (dailyCost > dailyBudget * ceiling) {
      logger.info(`[budget] Autonomous task ${taskName} deferred — ${Math.round(ceiling * 100)}% daily budget spent`);
      return false;
    }
    return true;
  }

  /**
   * Throttled budget check. Logs warnings and sends notification alerts
   * when spend approaches or exceeds daily/monthly limits.
   */
  private checkBudget(): void {
    const now = Date.now();
    if (now - this.lastBudgetCheck < BUDGET_CHECK_INTERVAL_MS) return;
    this.lastBudgetCheck = now;

    if (!this.config.memory) return;

    const dailyCost = this.config.memory.getTotalCost(24);
    const monthlyCost = this.config.memory.getTotalCost(24 * 30);

    const budgetCfg = getBudgetConfig(this.config.nyxhiveConfig?.budget);
    if (monthlyCost > budgetCfg.monthlyWarn) {
      logger.warn(`[budget] Monthly spend $${monthlyCost.toFixed(2)} exceeds warning threshold${budgetCfg.monthly > 0 ? ` of $${budgetCfg.monthly} budget` : ""}`);
      this.emit("budget:warning", { period: "monthly", spent: monthlyCost, limit: budgetCfg.monthly });
    }

    // Daily limit enforcement + alerts
    if (budgetCfg.dailyLimit > 0 && dailyCost > budgetCfg.dailyLimit) {
      logger.warn(`[budget] DAILY LIMIT HIT: $${dailyCost.toFixed(2)} / $${budgetCfg.dailyLimit.toFixed(2)}`);
      this.emit("budget:daily-limit", { spent: dailyCost, limit: budgetCfg.dailyLimit });
      this.sendBudgetAlert("daily-limit", dailyCost, budgetCfg.dailyLimit);
    } else if (dailyCost > budgetCfg.dailyWarn) {
      logger.warn(`[budget] Daily spend $${dailyCost.toFixed(2)} approaching limit ($${budgetCfg.dailyLimit > 0 ? budgetCfg.dailyLimit.toFixed(2) : "none"})`);
      this.emit("budget:warning", { period: "daily", spent: dailyCost, limit: budgetCfg.dailyWarn });
      this.sendBudgetAlert("daily-warning", dailyCost, budgetCfg.dailyLimit > 0 ? budgetCfg.dailyLimit : budgetCfg.dailyWarn);
    }
  }

  /** One-shot budget alert tracking to avoid spamming the same alert */
  private budgetAlertsSent = new Set<string>();

  private sendBudgetAlert(type: string, spent: number, limit: number): void {
    // Only send each alert type once per day
    const alertKey = `${type}:${new Date().toISOString().split("T")[0]}`;
    if (this.budgetAlertsSent.has(alertKey)) return;
    this.budgetAlertsSent.add(alertKey);

    const pct = limit > 0 ? Math.round((spent / limit) * 100) : 0;
    const message = `[Budget ${type}] $${spent.toFixed(2)} spent${limit > 0 ? ` (${pct}% of $${limit.toFixed(2)} limit)` : ""}`;

    // Fire-and-forget: resolve targets and send alert to all channels
    import("../notifications/routing.js").then(({ resolveNotificationTargets }) => {
      const targets = resolveNotificationTargets(this.config.nyxhiveConfig!, "alerts");
      for (const target of targets) {
        const batcher = this._batcher;
        if (batcher) {
          batcher.queue(target, { type: "alerts", priority: "critical", content: message, queuedAt: Date.now() }).catch(() => {});
        } else {
          const ch = this._channels?.find(c => c.name.toLowerCase() === target.channel.toLowerCase());
          ch?.sendOutbound?.(target.recipient, message).catch(() => {});
        }
      }
    }).catch(() => {});
  }

  private cleanExpiredState(): void {
    const now = Date.now();
    const TASK_TYPE_TTL_MS = 60 * 60 * 1000; // 1 hour
    const MODEL_OVERRIDE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
    const FAILURE_TTL_MS = 30 * 60 * 1000; // 30 minutes
    const BUDGET_WARN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

    // Expire stale clarifications
    for (const [key, entry] of this.pendingClarifications) {
      const timeoutAt = entry.timeoutAt ?? (entry.timestamp + INPUT_REQUEST_TIMEOUT_MS);
      if (timeoutAt <= now) {
        logger.debug(`[processor] Expiring stale clarification for ${key}`);
        this.pendingClarifications.delete(key);
      }
    }

    const expired = this.queue.expireSuspendedMessages(now);
    for (const suspended of expired) {
      this.enqueueResponse({
        message_id: suspended.message_id,
        channel: suspended.channel,
        sender: suspended.sender,
        sender_id: suspended.sender_id,
        message: suspended.original_message,
        task_id: suspended.task_id,
      } as MessageData, "Timed out waiting for your reply. Start a new message when you're ready to continue.", suspended.agent ?? "system");
      this.emitInputResolved(suspended, "timed_out");
    }

    // Prune lastTaskTypes older than 1 hour
    for (const [key, entry] of this.lastTaskTypes) {
      if (now - entry.setAt > TASK_TYPE_TTL_MS) {
        this.lastTaskTypes.delete(key);
      }
    }

    // Prune modelOverrides older than 24h
    this.modelOverridesMgr.expireOlderThan(MODEL_OVERRIDE_TTL_MS);

    // Prune consecutiveFailures older than 30 min (agent likely recovered)
    for (const [k, v] of this.consecutiveFailures) {
      if (now - v.setAt > FAILURE_TTL_MS) {
        this.consecutiveFailures.delete(k);
      }
    }

    // Prune budget warnings older than 24h
    for (const [k, ts] of this.conversationBudgetWarned) {
      if (now - ts > BUDGET_WARN_TTL_MS) {
        this.conversationBudgetWarned.delete(k);
      }
    }

    // Prune stale delegations older than 2 hours (safety net for crashes/timeouts)
    const DELEGATION_TTL_MS = 2 * 60 * 60 * 1000;
    for (const [k, v] of this.activeDelegations) {
      if (now - v.dispatchedAt > DELEGATION_TTL_MS) {
        logger.warn(`[processor] Expiring stale delegation: ${v.agent} (dispatched ${Math.round((now - v.dispatchedAt) / 60000)}m ago)`);
        this.activeDelegations.delete(k);
      }
    }

    // Prune BTW context cache (60 min max age)
    const prunedBtw = this.btwCache.prune(60 * 60 * 1000);
    if (prunedBtw > 0) logger.info(`[processor] Pruned ${prunedBtw} stale BTW cache entries`);

    // Expire steers past TTL
    if (this.steersDb) {
      const expiredTtl = this.steersDb.expirePastTtl();
      if (expiredTtl > 0) logger.info(`[processor] Expired ${expiredTtl} steers past TTL`);
    }

    // Sweep orphaned 'processing' messages that have been stuck longer than agent timeout.
    // This catches mid-run crashes that startup-only resetOrphans() would miss until next restart.
    // minAge of 5min prevents resetting messages that are actively being processed.
    const ORPHAN_SWEEP_MS = AGENT_TIMEOUT_MS + 5 * 60 * 1000; // agent timeout (30min) + 5min grace
    const ORPHAN_MIN_AGE_MS = 5 * 60 * 1000; // only reset messages processing for at least 5min
    const orphans = this.queue.resetOrphans(ORPHAN_SWEEP_MS, ORPHAN_MIN_AGE_MS, { maxWallAgeMs: AGENT_TIMEOUT_MS });
    if (orphans > 0) {
      logger.warn(`[processor] Runtime sweep: reset ${orphans} orphaned processing message(s)`);
    }

    // Sweep orphaned 'running' delegation runs stuck beyond agent timeout + grace period.
    if (this.config.runs) {
      const runOrphans = this.config.runs.resetOrphans(ORPHAN_SWEEP_MS, "orphaned_sweep");
      if (runOrphans.total > 0) {
        const parts = [
          runOrphans.failed > 0 ? `${runOrphans.failed} failed` : null,
          runOrphans.superseded > 0 ? `${runOrphans.superseded} superseded` : null,
        ].filter(Boolean).join(", ");
        logger.warn(`[processor] Runtime sweep: classified ${runOrphans.total} orphaned delegation run(s): ${parts}`);
      }
    }
  }

  private lastCleanup = 0;

  /**
   * When the queue has been idle for a configurable threshold, auto-trigger
   * a lightweight evolution scan. Respects budget ceiling and cooldown.
   */
  private checkIdleDiscovery(): void {
    if (this.config.nyxhiveConfig?.scheduler?.idle_discovery_enabled !== true) return;

    const now = Date.now();
    const idleThreshold = this.config.nyxhiveConfig?.scheduler?.idle_threshold_minutes
      ? this.config.nyxhiveConfig.scheduler.idle_threshold_minutes * 60 * 1000
      : IDLE_THRESHOLD_MS;
    const cooldown = this.config.nyxhiveConfig?.scheduler?.idle_cooldown_minutes
      ? this.config.nyxhiveConfig.scheduler.idle_cooldown_minutes * 60 * 1000
      : IDLE_COOLDOWN_MS;

    // Not idle enough
    if (now - this.lastActivityAt < idleThreshold) return;
    // Cooldown not elapsed
    if (now - this.lastIdleTriggerAt < cooldown) return;
    // Messages pending — not actually idle (includes both channel and thread messages)
    if (this.queue.getPendingCountAll() > 0) return;

    // Budget check — don't blow the budget on autonomous work
    if (!this.shouldRunAutonomousTask("idle-discovery")) return;

    this.lastIdleTriggerAt = now;

    // Resolve orchestrator/lead agent to run the scan
    const agents = this.getAgents();
    const registry = this.config.registry;
    let orchestratorKey: string | undefined;
    if (registry) {
      for (const [key, entry] of registry.getAllEntries()) {
        if (!Object.keys(agents).includes(key)) continue;
        if (entry.role === "orchestrator" || entry.role === "lead") { orchestratorKey = key; break; }
      }
    } else {
      for (const [key, config] of Object.entries(agents)) {
        if (config.role === "orchestrator" || config.role === "lead") { orchestratorKey = key; break; }
      }
    }
    const targetAgent = orchestratorKey ?? Object.keys(agents)[0];
    if (!targetAgent) return; // no agents configured

    this.queue.enqueueMessage({
      message: "Idle discovery: run a lightweight evolution scan for improvement opportunities.",
      agent: targetAgent,
      sender: "system",
      channel: "system",
    });
    logger.info("[processor] Idle discovery triggered — queued evolution scan");
  }

  private async pollLoop(): Promise<void> {
    // Event-driven: process immediately when a message is enqueued
    this.queue.events.on("message-enqueued", () => {
      if (this.running) this.processNext().catch(err =>
        logger.error(`[processor] Event-driven process error: ${formatError(err)}`)
      );
    });

    // Fallback polling for crash recovery (2s interval)
    while (this.running) {
      try {
        await this.processNext();
        // Periodic cleanup of expired state (every 5 minutes)
        const now = Date.now();
        if (now - this.lastCleanup > 5 * 60 * 1000) {
          this.cleanExpiredState();
          this.checkIdleDiscovery();
          this.lastCleanup = now;
        }
      } catch (err) {
        logger.error(`[processor] Poll error: ${err}`);
      }
      await Bun.sleep(POLL_INTERVAL_MS);
    }
  }

  private async processNext(): Promise<void> {
    // Thread pool: claim and process thread messages concurrently (bypass agentChains)
    if (this.activeThreadCount < this.maxConcurrentThreads) {
      const activeThreadIds = Array.from(this.threadPool.keys());
      const threadMsg = this.queue.claimThreadMessage(activeThreadIds);
      if (threadMsg) {
        const threadId = threadMsg.thread_id!;
        this.activeThreadCount++;
        const threadPromise = this.processThreadMessage(threadMsg)
          .finally(() => {
            this.activeThreadCount--;
            this.threadPool.delete(threadId);
          });
        this.threadPool.set(threadId, threadPromise);
        threadPromise.catch((err) => {
          logger.error(`[processor] Thread pool error for ${threadId}: ${err}`);
        });
      }
    }

    // Non-thread messages: existing agent chain logic (unchanged)
    const agents = this.getAgents();
    for (const [agentKey, agentConfig] of Object.entries(agents)) {
      const isLead = this.canOrchestrate(agentKey);
      if (this.queue.getPendingCount(agentKey, { explicitOnly: !isLead }) === 0) continue;

      const existingChain = this.agentChains.get(agentKey) ?? Promise.resolve();
      const newChain = existingChain.then(() => this.processForAgent(agentKey, agentConfig));
      this.agentChains.set(agentKey, newChain);

      newChain.catch((err) => {
        logger.error(`[processor] Chain error for ${agentKey}: ${err}. Resetting chain.`);
        this.agentChains.delete(agentKey);
      });
    }
  }


  /** Extract task context from user message for graph memory briefing. Zero LLM cost. */
  private extractTaskContext(message: string): { filePaths?: string[]; taskType?: string; keywords?: string[] } | undefined {
    // Extract file paths (src/foo.ts, ./bar.js, etc.)
    const pathPattern = /(?:^|[\s"'`(])([.\w/-]+\.(?:ts|js|tsx|jsx|py|rs|swift|sql|yaml|yml|toml|json|md|css|html))\b/g;
    const filePaths: string[] = [];
    let match = pathPattern.exec(message);
    while (match !== null) {
      filePaths.push(match[1]);
      match = pathPattern.exec(message);
    }

    // Detect task type from keywords
    let taskType: string | undefined;
    const msgLower = message.toLowerCase();
    if (/\b(debug|fix|bug|error|crash|broken|failing)\b/.test(msgLower)) {
      taskType = "debug";
    } else if (/\b(implement|build|create|add|feature|new)\b/.test(msgLower)) {
      taskType = "code";
    } else if (/\b(review|audit|check|verify|inspect)\b/.test(msgLower)) {
      taskType = "review";
    } else if (/\b(refactor|clean|simplify|extract|move|rename)\b/.test(msgLower)) {
      taskType = "code";
    }

    // Extract significant keywords (4+ chars, not common words)
    const stopWords = new Set(["this", "that", "with", "from", "have", "been", "will", "would", "could", "should", "about", "their", "there", "which", "when", "what", "your", "some", "than", "them", "then", "these", "other", "into", "more", "also", "just", "only", "very", "like", "make"]);
    const words = message.split(/\s+/)
      .map(w => w.toLowerCase().replace(/[^a-z0-9-_]/g, ""))
      .filter(w => w.length >= 4 && !stopWords.has(w));
    const keywords = [...new Set(words)].slice(0, 10);

    if (filePaths.length === 0 && !taskType && keywords.length === 0) return undefined;
    return { filePaths: filePaths.length > 0 ? filePaths : undefined, taskType, keywords: keywords.length > 0 ? keywords : undefined };
  }

  private buildRuntimeTaskContext(
    message: string,
    extractedTaskContext: { filePaths?: string[]; taskType?: string; keywords?: string[] } | undefined,
    taskTypeHint: string | undefined,
    lastTaskType?: string,
    hasFiles = false,
  ): SystemPromptTaskContext | undefined {
    const taskType = extractedTaskContext?.taskType ?? taskTypeHint;
    const lastRuntimeMode = lastTaskType
      ? resolveRuntimeMode({ taskType: lastTaskType })
      : undefined;
    const runtimeMode = resolveRuntimeMode({
      message,
      taskType,
      filePaths: extractedTaskContext?.filePaths,
      hasFiles,
      lastRuntimeMode,
    });
    const productRuntimeMode = resolveProductRuntimeMode({
      message,
      taskType,
      filePaths: extractedTaskContext?.filePaths,
      hasFiles,
      lastRuntimeMode,
    });
    const promptProfile = resolvePromptProfile(runtimeMode, taskType);

    if (!taskType && !extractedTaskContext && runtimeMode === "agentic" && !hasFiles) return undefined;
    return {
      ...(extractedTaskContext ?? {}),
      ...(taskType ? { taskType } : {}),
      runtimeMode,
      productRuntimeMode,
      promptProfile,
    };
  }

  private applyConversationModeTaskContext(
    taskContext: SystemPromptTaskContext | undefined,
    mode: ConversationMode | undefined,
  ): SystemPromptTaskContext | undefined {
    if (!mode) return taskContext;

    if (mode === "quick") {
      return {
        ...(taskContext ?? {}),
        taskType: "conversation",
        runtimeMode: "conversation",
        productRuntimeMode: "conversation",
        promptProfile: "conversation_light",
        conversationMode: mode,
        suppressStrictAgentic: true,
      };
    }

    if (mode === "task") {
      return {
        ...(taskContext ?? {}),
        taskType: taskContext?.taskType ?? "analysis",
        runtimeMode:
          taskContext?.runtimeMode === "agentic"
            ? "agentic"
            : "hybrid",
        productRuntimeMode:
          taskContext?.productRuntimeMode === "execution"
            ? "execution"
            : "investigation",
        promptProfile: "agentic_standard",
        conversationMode: mode,
        suppressStrictAgentic: true,
      };
    }

    if (mode === "build") {
      return {
        ...(taskContext ?? {}),
        taskType: taskContext?.taskType ?? "coding",
        runtimeMode: "agentic",
        productRuntimeMode: "execution",
        promptProfile: "agentic_heavy",
        conversationMode: mode,
      };
    }

    if (mode === "deep") {
      const taskType = taskContext?.taskType ?? "expert";
      const investigation =
        taskType === "coding"
        || taskType === "code_review"
        || taskType === "research"
        || taskType === "analysis";
      return {
        ...(taskContext ?? {}),
        taskType,
        runtimeMode: investigation ? "agentic" : "hybrid",
        productRuntimeMode: investigation ? "investigation" : "reflection",
        promptProfile: "agentic_standard",
        conversationMode: mode,
      };
    }

    return {
      ...(taskContext ?? {}),
      conversationMode: mode,
    };
  }

  private buildSystemPromptLocal(
    agentKey: string,
    basePrompt: string | undefined,
    knowledgeContext: string | null,
    channel?: string,
    taskContext?: SystemPromptTaskContext,
    mode: "sdk" | "cli" = "cli",
    sender?: { name: string; id?: string; channel?: string; channelName?: string; role?: string },
    knowledgeTrace?: RetrievalTrace,
    contextPressureSignal?: string | null,
  ): BuildSystemPromptResult {
    return buildSystemPrompt(
      {
        nyxhiveConfig: this.config.nyxhiveConfig,
        registry: this.config.registry,
        graphMemory: this.config.graphMemory,
        memory: this.config.memory,
        instanceSoulsDir: this.config.instanceSoulsDir,
        patterns: this.config.patterns,
        routing: this.config.routing,
        canOrchestrate: (key) => this.canOrchestrate(key),
        activeDelegations: this.activeDelegations,
      },
      agentKey, basePrompt, knowledgeContext, channel, taskContext, mode, sender, knowledgeTrace, contextPressureSignal,
    );
  }

  private async extractAndPersistMemoriesLocal(
    convId: string,
    agentKey: string,
    userMessage: string,
    assistantResponse: string,
    channel: string,
    sender: string,
  ): Promise<void> {
    return extractAndPersistMemories(
      { graphMemory: this.config.graphMemory, knowledge: this.config.knowledge, embedder: this.config.embedder, router: this.config.router, lastExtractionAt: this.lastExtractionAt },
      convId, agentKey, userMessage, assistantResponse, channel, sender,
    );
  }

  private recordProceduralSkillDraftLocal(
    convId: string,
    agentKey: string,
    userMessage: string,
    assistantResponse: string,
    channel: string,
    sender: string,
    traceId?: string | null,
  ): void {
    const store = this.config.proceduralSkills;
    if (!store) return;

    try {
      recordProceduralSkillDraftIfQualified(store, {
        agentKey,
        channel,
        sender,
        conversationId: convId,
        traceId,
        userMessage,
        assistantResponse,
      }, {
        compiledKnowledge: this.config.compiledKnowledge,
      });
    } catch (err) {
      logger.warn(`[processor] Procedural skill draft extraction failed: ${formatError(err)}`);
    }
  }

  /**
   * Auto-generate a short, descriptive title for a thread after the first assistant response.
   * Only runs once (when thread has exactly 2 messages: user + assistant).
   * Fire-and-forget — errors are logged but don't affect the main flow.
   */
  private async autoGenerateTitle(threadId: string, userMessage: string, assistantResponse: string): Promise<void> {
    const router = this.config.router;
    if (!router || !this._threadDb) return;

    // Only auto-title if the thread has exactly 2 messages (the initial pair)
    const messages = this._threadDb.getThreadMessages(threadId);
    if (messages.length !== 2) return;

    // Don't override manually set titles — check if current title differs from auto-generated
    const thread = this._threadDb.getThread(threadId);
    if (!thread) return;

    try {
      const response = await router.complete(
        {
          messages: [
            {
              role: "user",
              content: `Generate a short title (max 6 words) for this conversation. Return ONLY the title, nothing else.\n\nUser: ${userMessage.slice(0, 300)}\nAssistant: ${assistantResponse.slice(0, 300)}`,
            },
          ],
          maxTokens: 30,
          temperature: 0.3,
        },
        "openrouter",
        "deepseek/deepseek-v3.2",
      );

      const title = response.content.trim().replace(/^["']|["']$/g, "").slice(0, 80);
      if (title.length >= 3) {
        this._threadDb.updateThread(threadId, { title });
        logger.info(`[processor] Auto-titled thread ${threadId}: "${title}"`);
        // Notify gateway clients so the sidebar updates
        this.emitThreadEvent(threadId, "thread:update", { title });
      }
    } catch (err) {
      logger.warn(`[processor] Auto-title failed for ${threadId}: ${err}`);
    }
  }

  private persistImmediateThreadResponse(opts: {
    threadId?: string;
    messageId: string;
    response: string;
    agent: string;
    traceId?: string | null;
    cost?: number;
    tokensIn?: number;
    tokensOut?: number;
    durationMs?: number;
    userMessage: string;
  }): void {
    if (!opts.threadId || !this._threadDb) return;
    if (!this._threadDb.getThread(opts.threadId)) return;
    if (this._threadDb.getThreadMessageByMessageId(opts.threadId, opts.messageId)) return;

    const costCents = Math.round((opts.cost ?? 0) * 100);
    const totalTokens = (opts.tokensIn ?? 0) + (opts.tokensOut ?? 0);
    this._threadDb.addThreadMessage(opts.threadId, {
      role: "assistant",
      content: opts.response,
      agent: opts.agent,
      message_id: opts.messageId,
      trace_id: opts.traceId ?? undefined,
      cost_cents: costCents,
      tokens: totalTokens,
    });
    this._threadDb.updateThread(opts.threadId, {
      status: "completed",
      response: opts.response,
      trace_id: opts.traceId ?? null,
      cost_cents: costCents,
      total_tokens: totalTokens,
      duration_ms: opts.durationMs ?? null,
      completed_at: Date.now(),
    });
    this.autoGenerateTitle(opts.threadId, opts.userMessage, opts.response).catch(() => {});
  }

  private shouldPersistThreadHistory(channel: string): boolean {
    return channel === "gateway" || channel.startsWith("session:");
  }

  private threadIdFromImmediateOpts(opts: { channel: string; thread_id?: string }): string | undefined {
    return opts.thread_id ?? (opts.channel.startsWith("session:") ? opts.channel.slice("session:".length) : undefined);
  }

  private async processForAgent(agentKey: string, agentConfig: AgentConfig, preClaimed?: MessageData): Promise<void> {
    const isLead = this.canOrchestrate(agentKey);
    const msg = preClaimed ?? this.queue.claimMessage(agentKey, { explicitOnly: !isLead });
    if (!msg) return;
    const relayContext = withRelaySenderMetadata(
      msg.relay_callback_token && msg.relay_callback_url
        ? {
          originInstance: msg.relay_origin_instance ?? "unknown",
          callbackUrl: msg.relay_callback_url,
          callbackToken: msg.relay_callback_token,
        } satisfies RelayOriginContext
        : undefined,
      msg.sender,
      msg.sender_id,
    );

    logger.info(`[processor] Claimed ${msg.message_id} for ${agentKey} — "${msg.message.slice(0, 60)}…"`);
    this.emit("message:processing", { message_id: msg.message_id, agent: agentKey });

    // Command dispatch — check before LLM classification
    if (this.config.commands?.length) {
      const cmdMatch = matchCommand(msg.message, this.config.commands);
      if (cmdMatch) {
        try {
          const result = await cmdMatch.command.handler({
            message: msg,
            args: cmdMatch.args,
            processor: this.getPublicAPI(),
            config: this.config.nyxhiveConfig!,
            stores: this._stores!,
          });
          if (result.handled) {
            if (result.response) {
              this.enqueueResponse(msg, result.response, cmdMatch.command.name);
            }
            return;
          }
        } catch (err) {
          logger.error(`[processor] Command ${cmdMatch.command.name} failed: ${err}`);
          // Fall through to normal routing
        }
      }
    }

    // Start trace
    let traceId: string | null = null;
    if (this.config.traces) {
      traceId = `trace-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      this.config.traces.startTrace({
        id: traceId,
        originMessageId: msg.message_id,
        channel: msg.channel,
        sender: msg.sender,
        senderId: msg.sender_id,
        inputMessage: msg.message,
      });
    }

    let run: DelegationRun | null = null;
    const runFilesTouched: DelegationRunFileTouch[] = [];

    try {
      const suspendedRun = this.queue.getSuspendedMessage(msg.message_id);
      const promptMessage = suspendedRun?.reply ?? msg.message;
      const promptFiles = msg.files ? parseQueuedFiles(msg.files) : undefined;

      // Conversation history
      const convId = this.conversationMgr.conversationId(msg.channel, msg.sender_id, msg.sender);
      const senderId = msg.sender_id ?? msg.sender;

      // Apply runtime model override if set (per-sender)
      const overrideKey = `${senderId}:${agentKey}`;
      const baseConfig = this.modelOverridesMgr.applyOverride(senderId, agentKey, agentConfig);

      // Search knowledge for context (skip for orchestrators — they delegate, not answer)
      // For short follow-up messages, enrich with last assistant response for better retrieval
      let lastAssistantText: string | undefined;
      if (promptMessage.length < 80 && this.config.memory) {
        const recent = this.config.memory.getLastMessages(convId, 2);
        const assistantMsg = recent.find(m => m.role === "assistant");
        if (assistantMsg) lastAssistantText = assistantMsg.content.slice(0, 300);
      }
      const extractedTaskContext = this.extractTaskContext(promptMessage);
      const localTaskType = this.config.router?.classifyLocal(promptMessage);
      const taskContext = this.applyConversationModeTaskContext(
        this.buildRuntimeTaskContext(
          promptMessage,
          extractedTaskContext,
          localTaskType,
          this.lastTaskTypes.get(convId)?.type,
          (promptFiles?.length ?? 0) > 0,
        ),
        undefined,
      );
      const skipAmbientKnowledge = !taskContext?.filePaths?.length
        && (taskContext?.productRuntimeMode === "conversation" || taskContext?.productRuntimeMode === "reflection");
      const knowledgeResult = this.isOrchestratorAgent(agentKey) || skipAmbientKnowledge
        ? { context: null, chunkIds: [], chunkSnippets: new Map<number, string>(), trace: undefined }
        : await this.searchKnowledgeDetailed(promptMessage, lastAssistantText, taskContext);
      const knowledgeContext = knowledgeResult.context;
      if (knowledgeContext) {
        logger.info(`[processor] ${msg.message_id} — knowledge context: hit (${knowledgeContext.length} chars, ${knowledgeResult.chunkIds.length} chunks)`);
      } else {
        logger.info(`[processor] ${msg.message_id} — knowledge context: miss`);
      }

      const senderRole = (msg.sender_id && this._stores?.pairing)
        ? this._stores.pairing.getRole(msg.channel, msg.sender_id) ?? undefined
        : undefined;
      const effectiveConfig = applySenderRolePolicy(baseConfig, senderRole);
      const companionMode = this.isCompanionAgent(agentKey);
      const promptMode = effectiveConfig.always_cli ? "cli" as const : "sdk" as const;
      const senderCtx = msg.sender ? { name: msg.sender, id: msg.sender_id, channel: msg.channel, role: senderRole } : undefined;
      // Assess context pressure for headroom signal
      const pressureSignal = (this.config.memory && effectiveConfig.model)
        ? this.conversationMgr.getCompactionManager().formatPressureSignal(
            this.conversationMgr.getCompactionManager().assessPressure(convId, effectiveConfig.model, this.config.memory),
          )
        : null;
      const systemPromptResult = this.buildSystemPromptLocal(agentKey, effectiveConfig.system_prompt, knowledgeContext, msg.channel, taskContext, promptMode, senderCtx, knowledgeResult.trace, pressureSignal);
      const companionContext = companionMode && this.shouldInjectCompanionContext(convId)
        ? this.buildCompanionContextBlock(convId)
        : null;
      if (companionContext) {
        systemPromptResult.prompt = `${systemPromptResult.prompt}\n\n${companionContext}`;
      }
      this.config.memory?.saveContextTrace(convId, agentKey, systemPromptResult.trace);
      logger.info(`[processor] ${msg.message_id} — system prompt: ${systemPromptResult.prompt.length} chars (${promptMode}/${systemPromptResult.trace.runtimeMode ?? "unknown"}/${systemPromptResult.trace.promptProfile ?? "unknown"})`);

      const convCtx = this.buildConversationContext();
      const { messages: conversationHistory, metrics: ctxMetrics } = this.conversationMgr.getConversationHistory(convId, effectiveConfig.model, systemPromptResult.prompt.length, agentKey, convCtx);

      // Cache context for BTW side queries
      this.btwCache.set(msg.message_id, {
        systemPrompt: systemPromptResult.prompt,
        conversationHistory: conversationHistory.slice(),
        agentKey,
        conversationId: convId,
      });

      logger.info(`[processor] ${msg.message_id} — context: ${ctxMetrics.messageCount} msgs, ${ctxMetrics.tokenCount}/${ctxMetrics.budgetTokens} tokens (${ctxMetrics.utilizationPct}%)`);
      const estimatedCtxWindow = getContextWindow(effectiveConfig.model);
      const estimatedPct = estimatedCtxWindow > 0
        ? Math.round((ctxMetrics.totalTokens / estimatedCtxWindow) * 100)
        : 0;
      const tokenReport = this.buildInvocationTokenReport({
        scope: `message ${msg.message_id}/${agentKey}`,
        model: effectiveConfig.model,
        systemPromptResult,
        conversationHistory,
        ctxMetrics,
      });
      this.emit("context:metrics", {
        convId,
        model: effectiveConfig.model,
        utilizationPct: estimatedPct,
        tokenCount: ctxMetrics.totalTokens,
        budgetTokens: estimatedCtxWindow,
        estimated: true,
        ...this.tokenReportEventFields(tokenReport),
      });

      run = this.config.runs?.createRun({
        task_id: msg.task_id ?? null,
        message_id: msg.message_id,
        trace_id: traceId,
        task_description: promptMessage,
        agent: agentKey,
        brain: resolveRunBrain(effectiveConfig),
        status: "running",
        environment: this.buildRunEnvironment(effectiveConfig),
      }) ?? null;
      const invokeMessage = run
        ? `${buildRunContextNote(run.run_id, run.scratchpad_dir)}${promptMessage}`
        : promptMessage;
      recordInboundFileArtifacts(this.config.runs, promptFiles, {
        run_id: run?.run_id ?? null,
        message_id: msg.message_id,
        trace_id: traceId,
        channel: msg.channel,
      });

      // Start trace event for primary agent
      let primaryEventId: number | null = null;
      if (this.config.traces && traceId) {
        primaryEventId = this.config.traces.startEvent(traceId, agentKey, promptMessage);
      }

      // Invoke agent (with streaming SSE events)
      this.config.registry?.markRunning(agentKey, { taskDescription: promptMessage.slice(0, 100) });
      this.emitEvent("agent:status", { agent: agentKey, status: "running", task: promptMessage.slice(0, 100) });
      logger.info(`[processor] ${msg.message_id} — invoking ${agentKey} (${effectiveConfig.provider}/${effectiveConfig.model})`);
      this.emit("response:start", {
        message_id: msg.message_id,
        agent: agentKey,
        channel: msg.channel,
      });

      // Abort controller for interrupt steers
      const steerAbort = new AbortController();
      let progressCallCount = 0;

      let lastProgressActivity = "";
      let lastProgressText = "";
      const onProgress = (info: CLIProgress) => {
        progressCallCount++;

        // Check for interrupt steers (every 5 progress updates to avoid DB spam)
        if (this.steersDb && progressCallCount % 5 === 0) {
          try {
            const pending = this.steersDb.getPending(msg.message_id);
            const hasInterrupt = pending.some((s) => s.priority === "interrupt");
            if (hasInterrupt && !steerAbort.signal.aborted) {
              logger.info(`[processor] Interrupt steer detected for ${msg.message_id}, aborting current invocation`);
              steerAbort.abort();
            }
          } catch (err) {
            logger.warn(`[processor] Steer check failed for ${msg.message_id}, skipping: ${err}`);
          }
        }
        // Add agent context
        info.agent = agentKey;
        info.delegationDepth = 0;

        const nextActivity = info.activity?.trim() ?? "";
        const nextText = info.textSoFar?.trim() ?? "";
        if (nextActivity !== lastProgressActivity || nextText !== lastProgressText) {
          this.queue.updateMessageProgress(msg.message_id, {
            activity: nextActivity || undefined,
            text: nextText || undefined,
          });
          lastProgressActivity = nextActivity;
          lastProgressText = nextText;
        }
        if (run) {
          this.config.runs?.updateProgress(run.run_id, {
            status: "running",
            usage: {
              tokens_in: info.tokensIn,
              tokens_out: info.tokensOut,
              duration_ms: Math.round(info.elapsed * 1000),
            },
          });
        }

        if (info.phase === "responding" && info.textDelta && info.streamingSafe !== false) {
          const rawTextSoFar = info.textSoFar || "";
          const cleanTextSoFar = sanitizeAssistantResponse(rawTextSoFar);
          if (!cleanTextSoFar) return;
          this.emit("response:delta", {
            message_id: msg.message_id,
            text_delta: cleanTextSoFar === rawTextSoFar.trim() ? info.textDelta : "",
            text_so_far: cleanTextSoFar,
            agent: agentKey,
            channel: msg.channel,
          });
          if (cleanTextSoFar === rawTextSoFar.trim()) {
            this.emit("token", {
              message_id: msg.message_id,
              text: info.textDelta,
              agent: agentKey,
              channel: msg.channel,
            });
          }
          // Stream text deltas to thread SSE subscribers
          if (msg.thread_id) {
            this.emitThreadEvent(msg.thread_id, "thread:delta", { content: info.textDelta });
          }
        }

        if (info.executionEvent) {
          this.emit("execution:event", {
            message_id: msg.message_id,
            agent: agentKey,
            channel: msg.channel,
            sender_id: msg.sender_id,
            ...info.executionEvent,
          });
          if (info.executionEvent.phase === "started") {
            this.emit("tool:start", {
              message_id: msg.message_id,
              agent: agentKey,
              channel: msg.channel,
              tool: info.executionEvent.title,
              input: info.executionEvent.subtitle ?? info.executionEvent.command ?? null,
            });
          }
        }

        // Emit working progress for channels to consume
        if (info.phase === "working") {
          this.emit("agent:progress", {
            message_id: msg.message_id,
            agent: agentKey,
            channel: msg.channel,
            turns: info.turns,
            tokensIn: info.tokensIn,
            tokensOut: info.tokensOut,
            elapsed: info.elapsed,
            activity: info.activity,
            delegationDepth: 0,
          });
          // Stream progress to thread SSE subscribers (tool use, activity descriptions)
          if (msg.thread_id && info.activity) {
            this.emitThreadEvent(msg.thread_id, "thread:progress", { description: info.activity });
          }
        }
      };

      const timeoutMs = effectiveConfig.timeout_ms ?? AGENT_TIMEOUT_MS;
      const sessionKey = `${convId}:${agentKey}`;
      const resumeProcessHandle = suspendedRun?.process_handle;
      this.seedCliSessionFromHandle(sessionKey, resumeProcessHandle);
      const toolMode = "auto" as const;
      const onRemoteDown = (info: { slug: string; url: string; reason: string; availableTools?: string[] }) => {
        const changed = this.recordRemoteMcpHealth(info.slug, info.url, "down", info.reason);
        this.emit("remote:mcp_down", {
          message_id: msg.message_id,
          agent: agentKey,
          channel: msg.channel,
          slug: info.slug,
          url: info.url,
          reason: info.reason,
          available_tools: info.availableTools ?? [],
        });
        if (!changed || !this.config.nyxhiveConfig) return;
        const alert = `Remote MCP down: ${info.slug} at ${info.url}. Operating without it.`;
        for (const target of resolveNotificationTargets(this.config.nyxhiveConfig, "alerts")) {
          const batcher = this._batcher;
          if (batcher) {
            batcher.queue(target, { type: "alerts", priority: "critical", content: alert, queuedAt: Date.now() }).catch(() => {});
            continue;
          }
          const ch = this._channels?.find((channel) => channel.name.toLowerCase() === target.channel.toLowerCase());
          ch?.sendOutbound?.(target.recipient, alert).catch(() => {});
        }
      };
      // Inject per-model context at invocation time (not cached)
      const { injectModelContext } = await import("../soul/compiler.js");
      const modelAwarePrompt = injectModelContext(systemPromptResult.prompt, effectiveConfig.model);
      const recordFileChange = (change: { filePath: string; operation: string; linesAdded: number; linesRemoved: number; diffSummary?: string }) => {
        this.recordScratchpadChange(run, agentKey, runFilesTouched, change);
        if (msg.thread_id && this._threadDb && msg.channel === "gateway") {
          const id = randomUUID();
          this._threadDb.recordFileChange({
            id,
            threadId: msg.thread_id,
            filePath: change.filePath,
            operation: change.operation as "write" | "edit" | "create" | "delete",
            linesAdded: change.linesAdded,
            linesRemoved: change.linesRemoved,
            diffSummary: change.diffSummary,
          });
          this.emitThreadEvent(msg.thread_id, "thread:file_change", {
            file_path: change.filePath,
            operation: change.operation,
            lines_added: change.linesAdded,
            lines_removed: change.linesRemoved,
          });
        }
      };

      const result = await Promise.race([
        invokeAgent(effectiveConfig, invokeMessage, {
          baseDir: this.config.baseDir,
          messageId: msg.message_id,
          channel: msg.channel,
          systemPrompt: modelAwarePrompt,
          knowledgeContext: knowledgeContext ?? undefined,
          conversationHistory,
          sessionId: resumeProcessHandle?.session_id ?? this.resolveCliSessionIdForTurn(sessionKey, effectiveConfig, {
            message: promptMessage,
            runtimeMode: systemPromptResult.trace.runtimeMode,
          }),
          senderName: msg.sender,
          router: this.config.router,
          config: this.config.nyxhiveConfig,
          agentKey,
          cliEscalationTasks: this.config.cliEscalationTasks,
          modelOverride: this.modelOverridesMgr.has(overrideKey),
          toolMode,
          runtimeMode: systemPromptResult.trace.runtimeMode,
          dualBrain: this.config.dualBrain,
          lastTaskType: this.lastTaskTypes.get(convId)?.type,
          files: promptFiles,
          onProgress,
          onRemoteDown,
          signal: steerAbort.signal,
          sandbox: this.config.sandbox,
          registry: this.config.registry,
          scheduler: this._scheduler,
          memory: this.config.memory,
          knowledge: this.config.knowledge,
          compiledKnowledge: this.config.compiledKnowledge,
          embedder: this.config.embedder,
          proceduralSkills: this.config.proceduralSkills,
          vault: this.config.vault,
          instanceSoulsDir: this.config.instanceSoulsDir,
          onHeartbeat: () => this.config.registry?.recordHeartbeat(agentKey),
          onFileChange: recordFileChange,
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Agent ${agentKey} timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs),
        ),
      ]);

      this.config.registry?.markIdle(agentKey);
      this.config.registry?.resetConsecutiveStuck(agentKey);
      this.emitEvent("agent:status", { agent: agentKey, status: "idle", task: null });
      emitActivity({
        type: "completion",
        agent: agentKey,
        action: "completed",
        subject: msg.message?.slice(0, 80) ?? "task",
      });

      // Track task type for follow-up detection
      if (result.task_type) {
        this.lastTaskTypes.set(convId, { type: result.task_type, setAt: Date.now() });
      }

      // Track resumable runtime session for conversation continuity on the next message.
      this.rememberInvocationSession(sessionKey, effectiveConfig, result);

      // Complete primary trace event with model routing data
      if (this.config.traces && primaryEventId) {
        this.config.traces.completeEvent(primaryEventId, {
          responseExcerpt: result.response.slice(0, 500),
          tokensIn: result.tokens_in,
          tokensOut: result.tokens_out,
          cost: result.cost,
          durationMs: result.duration_ms,
          model: result.model ?? effectiveConfig.model,
          taskType: result.task_type,
          billingType: getBillingType(result.method, result.model ?? effectiveConfig.model),
          metadata: {
            runtimeEvents: result.runtime_events ?? [],
            authority: result.runtime_events?.find((event) => event.kind === "authority.resolved")?.payload ?? null,
          },
        });
      }

      // Emit post-turn context metrics.
      // For Codex SDK, last_turn_tokens_in reflects Codex's internal thread/session usage,
      // which can be far larger than the compact prompt window NyxHive actually built.
      // Use NyxHive's own context accounting for the user-facing badge on that path.
      const contextTokenCount =
        effectiveConfig.cli_fallback === "codex"
          ? ctxMetrics.totalTokens
          : result.last_turn_tokens_in;
      if (contextTokenCount) {
        const ctxWindow = getContextWindow(result.model ?? effectiveConfig.model);
        const realPct = Math.round((contextTokenCount / ctxWindow) * 100);
        this.emit("context:metrics", {
          convId,
          model: result.model ?? effectiveConfig.model,
          utilizationPct: realPct,
          tokenCount: contextTokenCount,
          budgetTokens: ctxWindow,
          estimated: false,
          ...this.tokenReportEventFields(tokenReport),
        });
      }

      // Budget check (usage data comes from trace_events)
      this.checkBudget();

      // Record invocation stats in registry
      this.config.registry?.recordInvocation(agentKey, {
        tokensIn: result.tokens_in ?? 0,
        tokensOut: result.tokens_out ?? 0,
        success: true,
        costCents: Math.round((result.cost ?? 0) * 100),
      });

      // Reset consecutive failures on success
      this.consecutiveFailures.delete(agentKey);

      const inputRequest = inputRequestFromResult(result);
      if (inputRequest) {
        const responseText = formatInputRequestForDisplay(inputRequest);
        this.conversationMgr.saveToHistory(
          convId, msg.channel, msg.sender_id ?? msg.sender,
          promptMessage, responseText,
          result.model ?? effectiveConfig.model, effectiveConfig.provider,
          result.tokens_in ?? 0, result.tokens_out ?? 0, result.cost ?? 0,
          agentKey, convCtx,
        );
        const suspended = this.suspendMessageRun({
          messageId: msg.message_id,
          convId,
          channel: msg.channel,
          sender: msg.sender,
          senderId: msg.sender_id,
          taskId: msg.task_id,
          agentKey,
          threadId: msg.channel === "gateway" ? msg.sender_id : undefined,
          originalMessage: msg.message,
          responseText,
          request: inputRequest,
          result,
        });
        this.enqueueResponse(msg, responseText, agentKey);
        if (run) {
          this.config.runs?.updateProgress(run.run_id, {
            status: "running",
            result: deriveRunResult({
              response: responseText,
              status: "completed",
              scratchpadDir: run.scratchpad_dir,
              scratchpadFiles: this.config.runs?.getScratchpadFiles(run.run_id),
              filesTouched: runFilesTouched,
              invocation: result,
            }),
          });
        }
        this.btwCache.evict(msg.message_id);
        if (msg.thread_id && this._threadDb && msg.channel === "gateway") {
          this._threadDb.updateThread(msg.thread_id, { status: "waiting_input", response: responseText });
        }
        void suspended;
        return;
      }

      // Validate orchestrator delegation before actor model processing
      const delegationCtx = this.buildDelegationContext(relayContext, run, msg.task_id ?? null);
      this.delegation.validateOrchestratorDelegation(result, agentKey, msg.message, delegationCtx);

      // Actor model: process mentions recursively
      let finalResponse = await this.delegation.processWithActorModel(
        result, traceId, primaryEventId, convId, msg.channel, msg.sender_id ?? msg.sender,
        0, { value: 1 }, delegationCtx, msg.message_id, onProgress, msg.message,
      );
      finalResponse = assertDeliverableResponse(this.sanitizeResponse(finalResponse), msg.message_id);
      let steerReinvokeCount = 0;

      // Save to conversation history (use processed message to avoid raw URLs leaking into future context)
      this.conversationMgr.saveToHistory(
        convId, msg.channel, msg.sender_id ?? msg.sender,
        promptMessage, finalResponse,
        result.model ?? effectiveConfig.model, effectiveConfig.provider,
        result.tokens_in ?? 0, result.tokens_out ?? 0, result.cost ?? 0,
        agentKey, convCtx,
      );

      // Deliver pending steers — if any were queued during this turn,
      // re-invoke the agent so it can actually respond to the steer.
      // Max 2 steer re-invocations to prevent runaway loops.
      if (this.steersDb) {
        const pendingCount = this.steersDb.pendingCount(msg.message_id);
        if (pendingCount > 0) {
          const batch = this.steersDb.formatBatch(msg.message_id);
          if (batch) {
            this.conversationMgr.saveSteerToHistory(convId, batch, convCtx);
            const pending = this.steersDb.getPending(msg.message_id);
            for (const s of pending) {
              this.steersDb.markDelivered(s.steer_id);
              this.emit("steer:delivered", {
                steer_id: s.steer_id,
                agent: agentKey,
                message_id: msg.message_id,
              });
            }
            logger.info(`[processor] Delivered ${pendingCount} steers for ${msg.message_id}`);

            // Re-invoke agent to address the steer (up to 2 times)
            if (steerReinvokeCount < 2) {
              steerReinvokeCount++;
              logger.info(`[processor] Re-invoking ${agentKey} for steer (attempt ${steerReinvokeCount})`);

              // Rebuild conversation with the steer now in history
              const steerHistoryResult = this.conversationMgr.getConversationHistory(
                convId, effectiveConfig.model, systemPromptResult.prompt.length, agentKey, convCtx,
              );
              const steerHistory = steerHistoryResult.messages;
              const steerAbort2 = new AbortController();
              const steerResult = await Promise.race([
                invokeAgent(effectiveConfig, "[steer follow-up]", {
                  baseDir: this.config.baseDir,
                  messageId: msg.message_id,
                  channel: msg.channel,
                  systemPrompt: systemPromptResult.prompt,
                  conversationHistory: steerHistory,
                  sessionId: this.resolveCliSessionId(sessionKey, effectiveConfig),
                  senderName: msg.sender,
                  router: this.config.router,
                  config: this.config.nyxhiveConfig,
                  agentKey,
                  dualBrain: this.config.dualBrain,
                  onProgress,
                  signal: steerAbort2.signal,
                  sandbox: this.config.sandbox,
                  registry: this.config.registry,
                  memory: this.config.memory,
                  knowledge: this.config.knowledge,
                  compiledKnowledge: this.config.compiledKnowledge,
                  embedder: this.config.embedder,
                  vault: this.config.vault,
                  instanceSoulsDir: this.config.instanceSoulsDir,
                  onHeartbeat: () => this.config.registry?.recordHeartbeat(agentKey),
                  onFileChange: recordFileChange,
                }),
                new Promise<never>((_, reject) =>
                  setTimeout(() => reject(new Error("Steer re-invoke timed out")), 120_000),
                ),
              ]);

              // Save steer response to history and update finalResponse
              const steerResponse = steerResult.response;
              this.conversationMgr.saveToHistory(
                convId, msg.channel, msg.sender_id ?? msg.sender,
                "[steer follow-up]", steerResponse,
                steerResult.model ?? effectiveConfig.model, effectiveConfig.provider,
                steerResult.tokens_in ?? 0, steerResult.tokens_out ?? 0, steerResult.cost ?? 0,
                agentKey, convCtx,
              );

              // Append steer response to the main response
              finalResponse = `${finalResponse}\n\n---\n**[steer response]**\n${steerResponse}`;

              // Update resumable runtime session if steer produced one.
              this.rememberInvocationSession(sessionKey, effectiveConfig, steerResult);
            }
          }
        }
      }

      // Memory extraction (fire-and-forget, don't block response delivery)
      this.extractAndPersistMemoriesLocal(
        convId, agentKey, msg.message, finalResponse, msg.channel, msg.sender,
      ).catch(() => {}); // Errors already logged inside
      this.recordProceduralSkillDraftLocal(
        convId, agentKey, msg.message, finalResponse, msg.channel, msg.sender, traceId,
      );

      // Knowledge retrieval feedback — adjust confidence based on actual usage
      if (this.config.knowledge && knowledgeResult.chunkSnippets.size > 0) {
        try {
          applyRetrievalFeedback(this.config.knowledge, knowledgeResult.chunkSnippets, finalResponse);
        } catch { /* don't block response delivery */ }
      }

      // Enqueue response (secrets redacted)
      this.enqueueResponse(msg, finalResponse, agentKey);
      this.queue.clearSuspendedMessage(msg.message_id);
      this.queue.completeMessage(msg.message_id);
      if (run) {
        this.config.runs?.completeRun(run.run_id, {
          status: "completed",
          result: deriveRunResult({
            response: finalResponse,
            status: "completed",
            scratchpadDir: run.scratchpad_dir,
            scratchpadFiles: this.config.runs?.getScratchpadFiles(run.run_id),
            filesTouched: runFilesTouched,
            invocation: result,
          }),
          usage: this.buildRunUsage(result),
          trace_id: traceId,
        });
      }
      this.btwCache.evict(msg.message_id);
      // Expire undelivered steers for completed message
      if (this.steersDb) {
        const expired = this.steersDb.expireForMessage(msg.message_id);
        if (expired > 0) logger.info(`[processor] Expired ${expired} undelivered steers for ${msg.message_id}`);
      }

      // Update thread record if this was a thread message
      if (msg.thread_id && this._threadDb && this.shouldPersistThreadHistory(msg.channel)) {
        const costCents = (result.cost ?? 0) * 100;
        this._threadDb.addThreadMessage(msg.thread_id, {
          role: "assistant",
          content: finalResponse,
          agent: agentKey,
          message_id: msg.message_id,
          trace_id: traceId ?? undefined,
          cost_cents: costCents,
          tokens: (result.tokens_in ?? 0) + (result.tokens_out ?? 0),
        });
        this._threadDb.updateThread(msg.thread_id, {
          status: "completed",
          response: finalResponse,
          trace_id: traceId ?? null,
          cost_cents: costCents,
          total_tokens: (result.tokens_in ?? 0) + (result.tokens_out ?? 0),
          duration_ms: result.duration_ms ?? null,
          completed_at: Date.now(),
        });
        this.emitThreadEvent(msg.thread_id, "thread:complete", {
          response: finalResponse,
          cost_cents: costCents,
          total_tokens: (result.tokens_in ?? 0) + (result.tokens_out ?? 0),
          duration_ms: result.duration_ms ?? 0,
        });

        // Auto-generate a short title after the first assistant response
        this.autoGenerateTitle(msg.thread_id, msg.message, finalResponse).catch(() => {});
      }

      // Complete trace
      if (this.config.traces && traceId) {
        this.config.traces.completeTrace(traceId, finalResponse);
      }

      this.lastActivityAt = Date.now();
      this.emit("message:completed", {
        message_id: msg.message_id,
        agent: agentKey,
        method: result.method,
        duration_ms: result.duration_ms,
        trace_id: traceId,
      });

      this.emit("response:complete", {
        message_id: msg.message_id,
        agent: agentKey,
        channel: msg.channel,
        trace_id: traceId,
        tokens_in: result.tokens_in,
        tokens_out: result.tokens_out,
        cost: result.cost,
        duration_ms: result.duration_ms,
        text_so_far: finalResponse,
      });

      logger.info(`[processor] Completed ${msg.message_id} — ${result.method}, ${result.duration_ms}ms, ${result.tokens_in ?? 0}+${result.tokens_out ?? 0} tokens, $${(result.cost ?? 0).toFixed(4)}`);
      if (run) this.fireWebhook("completed", msg.message, finalResponse);
    } catch (err) {
      this.config.registry?.markIdle(agentKey);
      this.emitEvent("agent:status", { agent: agentKey, status: "idle", task: null });
      const errorMsg = formatError(err);
      if (this.config.traces && traceId) {
        this.config.traces.failTrace(traceId, errorMsg);
      }
      // Record failure in registry
      this.config.registry?.recordInvocation(agentKey, {
        tokensIn: 0, tokensOut: 0, success: false, costCents: 0,
      });
      this.queue.clearSuspendedMessage(msg.message_id);
      this.queue.failMessage(msg.message_id, errorMsg, QueueDB.isTransientError(errorMsg) ? 3 : 0);
      if (run) {
        const status: DelegationRunStatus = err instanceof Error && err.name === "AbortError" ? "killed" : "failed";
        this.config.runs?.completeRun(run.run_id, {
          status,
          result: deriveRunResult({
            response: "",
            status,
            scratchpadDir: run.scratchpad_dir,
            scratchpadFiles: this.config.runs?.getScratchpadFiles(run.run_id),
            filesTouched: runFilesTouched,
            error: errorMsg,
          }),
          usage: {
            tokens_in: 0,
            tokens_out: 0,
            tool_uses: [],
            duration_ms: 0,
            cost_usd: 0,
          },
          trace_id: traceId,
        });
      }
      this.btwCache.evict(msg.message_id);
      if (this.steersDb) this.steersDb.expireForMessage(msg.message_id);

      // Update thread record if this was a thread message
      if (msg.thread_id && this._threadDb && this.shouldPersistThreadHistory(msg.channel)) {
        this._threadDb.updateThread(msg.thread_id, { status: "failed" });
        this.emitThreadEvent(msg.thread_id, "thread:error", { error: errorMsg, recoverable: false });
      }

      this.emit("message:failed", { message_id: msg.message_id, agent: agentKey, error: errorMsg });
      logger.error(`[processor] Failed ${msg.message_id} for ${agentKey}: ${errorMsg}`);
      if (run) this.fireWebhook("failed", msg.message, errorMsg);

      // Send error feedback to user so they don't get silence
      const userFacingError = `I wasn't able to process your request. Error: ${errorMsg.slice(0, 200)}`;
      this.enqueueResponse(msg, userFacingError, agentKey);

      // Circuit breaker: escalate after 3 consecutive failures
      const failures = (this.consecutiveFailures.get(agentKey)?.count ?? 0) + 1;
      this.consecutiveFailures.set(agentKey, { count: failures, setAt: Date.now() });
      const CIRCUIT_THRESHOLD = 3;
      if (failures >= CIRCUIT_THRESHOLD) {
        logger.warn(`[processor] Circuit breaker: ${agentKey} has failed ${failures} times consecutively`);
        const alertMsg = `⚠️ Agent @${agentKey} has failed ${failures} consecutive times. Last error: ${errorMsg.slice(0, 200)}`;
        const alertTargets = this.config.nyxhiveConfig
          ? resolveNotificationTargets(this.config.nyxhiveConfig, "alerts")
          : [];
        for (const alertTarget of alertTargets) {
          const ch = this._channels?.find(c => c.name.toLowerCase() === alertTarget.channel.toLowerCase());
          if (ch?.sendOutbound) {
            ch.sendOutbound(alertTarget.recipient, alertMsg).catch((err) => {
              logger.warn(`[processor] Failed to send circuit breaker alert via ${alertTarget.channel}: ${err}`);
            });
          }
        }
      }
      this.lastActivityAt = Date.now();
    }
  }

  /**
   * Process a thread message independently of agent chains.
   * Each thread gets its own concurrent slot in the thread pool.
   * Uses processForAgent with the pre-claimed message to reuse the full invocation pipeline.
   */
  private async processThreadMessage(msg: MessageData): Promise<void> {
    const threadId = msg.thread_id!;
    const agentKey = msg.agent
      ?? this.config.defaultAgent
      ?? resolvePrimaryAgentKey(this.getAgents(), this.config.nyxhiveConfig?.daemon)
      ?? Object.keys(this.getAgents())[0];
    const agentConfig = this.getAgent(agentKey);

    if (!agentConfig) {
      logger.error(`[processor] Thread ${threadId}: no agent config for ${agentKey}`);
      this.queue.failMessage(msg.message_id, `Unknown agent: ${agentKey}`);
      if (this._threadDb) {
        this._threadDb.updateThread(threadId, { status: "failed" });
        this.emitThreadEvent(threadId, "thread:error", { error: `Unknown agent: ${agentKey}`, recoverable: false });
      }
      return;
    }

    logger.info(`[processor] Thread ${threadId}: processing via ${agentKey} (pool: ${this.activeThreadCount}/${this.maxConcurrentThreads})`);

    // Update thread status to processing
    if (this._threadDb) {
      this._threadDb.updateThread(threadId, { status: "processing" });
      this.emitThreadEvent(threadId, "thread:status", { status: "processing", agent: agentKey });
    }

    // Reuse full agent invocation pipeline with the pre-claimed message
    await this.processForAgent(agentKey, agentConfig, msg);
  }

  /** Get active thread IDs (for external status queries) */
  getActiveThreadIds(): string[] {
    return Array.from(this.threadPool.keys());
  }

  /** Get thread pool stats */
  getThreadPoolStats(): { active: number; max: number } {
    return { active: this.activeThreadCount, max: this.maxConcurrentThreads };
  }

  /** Find the configured coder agent for delegation enforcement */
  private get coderAgent(): string | undefined {
    const agents = this.config.agents;
    return Object.keys(agents).find(key => agents[key].role === "coder");
  }

  /**
   * Clear conversation history for a sender on a channel.
   */
  clearConversation(channel: string, senderId: string): void {
    const convId = this.conversationMgr.conversationId(channel, senderId);
    if (this.config.memory) {
      this.config.memory.clearConversation(convId);
    }
    this.lastTaskTypes.delete(convId);
    this.pendingClarifications.delete(convId);
    // Clear delegation tracking for this conversation
    for (const [key, entry] of this.activeDelegations) {
      if (entry.convId === convId) this.activeDelegations.delete(key);
    }
    this.clearCliSessionsForConv(convId);
    logger.info(`[processor] Cleared conversation ${convId} (including CLI sessions)`);
  }

  /**
   * Clear only CLI sessions for a given conversation ID.
   * Used by the scheduler to prune sessions after one-shot task completion
   * without wiping conversation history.
   */
  clearCliSessionsByConvId(channel: string, senderId: string): void {
    const convId = this.conversationMgr.conversationId(channel, senderId);
    this.clearCliSessionsForConv(convId);
  }

  private clearCliSessionsForConv(convId: string): void {
    for (const key of this.cliSessions.keys()) {
      if (key.startsWith(`${convId}:`)) {
        this.cliSessions.delete(key);
        this.deleteCliSession(key);
      }
    }
  }

  /**
   * Save a steer message to conversation history (for idle steers).
   * The agent will see this on its next invocation.
   */
  saveSteerToConversation(channel: string, senderId: string, steerContent: string): void {
    const convId = this.conversationMgr.conversationId(channel, senderId);
    const convCtx = this.buildConversationContext();
    this.conversationMgr.saveSteerToHistory(convId, steerContent, convCtx);
    logger.info(`[processor] Saved idle steer to ${convId}`);
  }

  /**
   * Persist a completed, failed, or aborted turn into conversation history when
   * the normal success path was not reached.
   */
  recordConversationTurn(
    channel: string,
    senderId: string,
    userMessage: string,
    assistantResponse: string,
    opts: {
      agent?: string;
      model?: string | null;
      provider?: string | null;
      tokensIn?: number;
      tokensOut?: number;
      cost?: number;
    } = {},
  ): void {
    const convId = this.conversationMgr.conversationId(channel, senderId);
    const convCtx = this.buildConversationContext();
    this.conversationMgr.saveToHistory(
      convId,
      channel,
      senderId,
      userMessage,
      assistantResponse,
      opts.model ?? null,
      opts.provider ?? null,
      opts.tokensIn ?? 0,
      opts.tokensOut ?? 0,
      opts.cost ?? 0,
      opts.agent,
      convCtx,
    );
    logger.info(`[processor] Recorded turn in ${convId}`);
  }

  /**
   * Check if there's an active invocation for a channel+sender.
   */
  isActive(channel: string, senderId: string): { active: boolean; agent?: string; elapsed?: number } {
    const convId = this.conversationMgr.conversationId(channel, senderId);
    const proc = this.activeProcesses.get(convId);
    if (!proc) return { active: false };
    return {
      active: true,
      agent: proc.agent,
      elapsed: Math.round((Date.now() - proc.startedAt) / 1000),
    };
  }

  /**
   * Remove the last user+assistant exchange from history.
   */
  undoLastExchange(channel: string, senderId: string): { removed: number } {
    const convId = this.conversationMgr.conversationId(channel, senderId);
    if (!this.config.memory) return { removed: 0 };

    // Grab up to 2 most recent messages (expecting user+assistant pair)
    const last = this.config.memory.getLastMessages(convId, 2);
    if (last.length === 0) return { removed: 0 };

    // Remove the most recent 1-2 messages (whatever exists)
    const removed = this.config.memory.deleteLastMessages(convId, last.length);
    logger.info(`[processor] Undo: removed ${removed} messages from ${convId}`);
    return { removed };
  }

  /**
   * Remove last N exchanges (each exchange = user+assistant pair).
   */
  forgetMessages(channel: string, senderId: string, exchanges: number): { removed: number } {
    const convId = this.conversationMgr.conversationId(channel, senderId);
    if (!this.config.memory) return { removed: 0 };

    const count = Math.max(1, exchanges) * 2;
    const removed = this.config.memory.deleteLastMessages(convId, count);
    logger.info(`[processor] Forget: removed ${removed} messages from ${convId}`);
    return { removed };
  }

  /**
   * Keep only the last N messages in conversation history.
   */
  trimConversation(channel: string, senderId: string, keepRecent: number): { removed: number } {
    const convId = this.conversationMgr.conversationId(channel, senderId);
    if (!this.config.memory) return { removed: 0 };

    const removed = this.config.memory.trimToRecent(convId, keepRecent);
    logger.info(`[processor] Trim: removed ${removed} messages from ${convId}`);
    return { removed };
  }

  /**
   * Return message count and summary status for a conversation.
   */
  getContextInfo(channel: string, senderId: string): { messageCount: number; hasSummary: boolean } {
    const convId = this.conversationMgr.conversationId(channel, senderId);
    if (!this.config.memory) return { messageCount: 0, hasSummary: false };

    const messageCount = this.config.memory.getMessageCount(convId);
    const summary = this.config.memory.getConversationSummary(convId);
    return { messageCount, hasSummary: summary !== null };
  }

  /**
   * Return compact diagnostics for channel adapters that need to prove
   * conversation continuity against the exact bucket they are about to use.
   */
  getContextDiagnostics(channel: string, senderId: string): {
    conversationId: string;
    messageCount: number;
    hasSummary: boolean;
    conversationMemoryCount: number;
    latestInjectedChars: number;
    latestMemoryLaneCount: number;
  } {
    const convId = this.conversationMgr.conversationId(channel, senderId);
    const messageCount = this.config.memory?.getMessageCount(convId) ?? 0;
    const summary = this.config.memory?.getConversationSummary(convId);
    const hasSummary = summary !== null && summary !== undefined;
    const conversationMemoryCount = this.config.graphMemory?.getByConversation(convId, 1000).length ?? 0;
    const latestTrace = this.config.memory?.getContextTraces(convId, 1).at(0);
    let latestInjectedChars = 0;
    let latestMemoryLaneCount = 0;
    if (latestTrace) {
      try {
        const trace = JSON.parse(latestTrace.trace_json) as AssemblyTrace;
        latestInjectedChars = trace.parts
          ?.filter((part) => part.injected)
          .reduce((sum, part) => sum + part.charCount, 0) ?? 0;
        latestMemoryLaneCount = trace.diagnostics?.memoryLaneCount ?? trace.memoryLanesInjected?.length ?? 0;
      } catch (err) {
        logger.debug(`[processor] Failed to parse context trace for ${convId}: ${err}`);
      }
    }
    return {
      conversationId: convId,
      messageCount,
      hasSummary,
      conversationMemoryCount,
      latestInjectedChars,
      latestMemoryLaneCount,
    };
  }

  /**
   * Cancel a running task for a sender on a channel.
   */
  cancelTask(channel: string, senderId: string): { cancelled: boolean; agent?: string; elapsed?: number } {
    const convId = this.conversationMgr.conversationId(channel, senderId);
    const active = this.activeProcesses.get(convId);
    if (!active) return { cancelled: false };

    active.controller.abort();
    const elapsed = Math.round((Date.now() - active.startedAt) / 1000);
    logger.info(`[processor] Task cancelled: ${active.agent} for ${convId} after ${elapsed}s`);
    this.activeProcesses.delete(convId);
    return { cancelled: true, agent: active.agent, elapsed };
  }

  cancelMessage(messageId: string): { cancelled: boolean; error?: string } {
    const msg = this.queue.getMessageByMessageId(messageId);
    if (!msg) return { cancelled: false, error: "not found" };
    const convId = this.conversationMgr.conversationId(msg.channel, msg.sender_id, msg.sender);
    const active = this.activeProcesses.get(convId);
    if (!active) return { cancelled: false, error: "not found" };
    active.controller.abort();
    const elapsed = Math.round((Date.now() - active.startedAt) / 1000);
    logger.info(`[processor] Message cancelled: ${active.agent} for ${messageId} after ${elapsed}s`);
    this.activeProcesses.delete(convId);
    return { cancelled: true };
  }

  /**
   * Build a ConversationManagerContext that threads processor state to the ConversationManager.
   */
  private buildConversationContext(): ConversationManagerContext {
    return {
      memory: this.config.memory,
      router: this.config.router,
      nyxhiveConfig: this.config.nyxhiveConfig,
      instanceSoulsDir: this.config.instanceSoulsDir,
      graphMemory: this.config.graphMemory,
      getAgent: (key) => this.getAgent(key),
    };
  }

  /**
   * Strip hallucinated tool call XML from responses before saving to history.
   * Delegates to ConversationManager.
   */
  sanitizeResponse(response: string): string {
    return this.conversationMgr.sanitizeResponse(response);
  }

  private async searchKnowledgeDetailed(message: string, conversationContext?: string, taskContext?: import("../memory/knowledge.js").KnowledgeTaskContext & { runtimeMode?: import("../runtime/mode.js").RuntimeMode }): Promise<KnowledgeSearchResult> {
    const runtimeMode = taskContext?.runtimeMode ?? "agentic";
    const rawResult = await searchKnowledgeWithChunksFn({
      knowledge: this.config.knowledge,
      embedder: this.config.embedder,
      graph: this.config.graphMemory,
      memory: this.config.memory,
    }, message, conversationContext, taskContext);
    const result: KnowledgeSearchResult = {
      ...rawResult,
      trace: filterRetrievalTraceForRuntime(rawResult.trace, runtimeMode),
    };
    const compiledHits = this.config.compiledKnowledge?.search(message, taskContext, 2) ?? [];
    const compiledContext = formatCompiledKnowledgeContext(compiledHits.map((hit) => hit.page));
    if (!compiledContext) return result;
    const memoryLanesInjected = filterMemoryLanesForRuntime([
      ...(result.trace.memoryLanesInjected ?? []),
      "compiled_digest",
    ], runtimeMode);
    return {
      ...result,
      context: mergeKnowledgeContextFn(compiledContext, result.context),
      trace: {
        ...result.trace,
        memoryLanesInjected,
      },
    };
  }

  private async searchKnowledge(message: string, conversationContext?: string): Promise<string | null> {
    const result = await this.searchKnowledgeDetailed(message, conversationContext);
    return result.context;
  }

  private mergeKnowledgeContext(parent: string | null, task: string | null): string | null {
    return mergeKnowledgeContextFn(parent, task);
  }

  /**
   * Build a DelegationContext that threads processor state to the DelegationEngine.
   */
  private buildDelegationContext(
    currentRelay?: RelayOriginContext,
    currentRun?: DelegationRun | null,
    taskId?: string | null,
  ): DelegationContext {
    return {
      isOrchestratorAgent: (key) => this.isOrchestratorAgent(key),
      canOrchestrate: (key) => this.canOrchestrate(key),
      getAgent: (key) => this.getAgent(key),
      getKnownAgentKeys: () => this.getKnownAgentKeys(),
      emit: (type, data) => this.emit(type, data),
      searchKnowledge: (msg, conversationContext, taskContext) => this.searchKnowledgeDetailed(msg, conversationContext, taskContext),
      mergeKnowledgeContext: (parent, task) => this.mergeKnowledgeContext(parent, task),
      getConversationHistory: (convId, model?, systemPromptLength?, agentKey?) =>
        this.conversationMgr.getConversationHistory(convId, model, systemPromptLength, agentKey, this.buildConversationContext()),
      buildParentContext: (convId, maxChars?) => this.conversationMgr.buildParentContext(convId, maxChars, this.buildConversationContext()),
      buildSystemPrompt: (agentKey, basePrompt, knowledgeContext, channel?, taskContext?, mode?, knowledgeTrace?) =>
        this.buildSystemPromptLocal(agentKey, basePrompt, knowledgeContext, channel, taskContext, mode, undefined, knowledgeTrace),
      executeManagementActions: (actions, agentKey, origin) => this.executeManagementActions(actions, agentKey, origin),
      queueFollowup: (task, targetAgent, senderAgent, _priority) => {
        this.queue.enqueueMessage({
          message: task,
          agent: targetAgent,
          sender: senderAgent,
          task_id: taskId ?? currentRun?.task_id ?? undefined,
          from_agent: senderAgent,
          channel: "system",
        });
      },
      handleBtw: async (targetAgent, question, sourceAgent) => {
        const target = this.resolveActiveTaskTarget(targetAgent);
        if ("error" in target) {
          if (target.error === "agent_idle") {
            logger.debug(`[processor] BTW to @${targetAgent} skipped — agent idle`);
            return;
          }
          throw new Error(this.formatActiveTaskResolutionError(targetAgent, target, { action: "btw" }));
        }
        const result = await this.handleBtw(targetAgent, target.message_id, question, sourceAgent);
        if (result) {
          logger.info(`[processor] BTW answer for @${targetAgent} from @${sourceAgent}: ${result.answer.slice(0, 100)}`);
        }
      },
      handleSteer: async (targetAgent, message, sourceAgent) => {
        const target = this.resolveActiveTaskTarget(targetAgent);
        if ("error" in target) {
          if (target.error === "agent_idle") {
            logger.debug(`[processor] Steer to @${targetAgent} skipped — agent idle`);
            return;
          }
          throw new Error(this.formatActiveTaskResolutionError(targetAgent, target, { action: "steer" }));
        }
        await this.handleSteer(targetAgent, target.message_id, target.conversation_id, {
          message,
          priority: "normal",
          source: sourceAgent,
        });
      },
      config: this.config,
      modelOverrides: this.modelOverridesMgr.getRawMap(),
      conversationBudgetWarned: this.conversationBudgetWarned,
      activeDelegations: this.activeDelegations,
      currentRelay,
      currentRun,
      taskId: taskId ?? currentRun?.task_id ?? null,
      _scheduler: this._scheduler,
      coderAgent: this.coderAgent,
    };
  }

  private fireWebhook(outcome: "completed" | "failed", taskDescription: string, summary: string): void {
    const webhookUrl = this.config.nyxhiveConfig?.daemon?.webhook_url;
    if (!webhookUrl) return;
    const webhookError = validateOutboundHttpUrl(webhookUrl);
    if (webhookError) {
      logger.warn(`[processor] Skipping webhook: ${webhookError}`);
      return;
    }
    const payload = JSON.stringify({
      task_name: taskDescription.substring(0, 200),
      outcome,
      summary: summary.substring(0, 500),
      completed_at: new Date().toISOString(),
    });
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const secret = this.config.nyxhiveConfig?.daemon?.webhook_secret;
    if (secret) headers.Authorization = `Bearer ${secret}`;
    fetch(webhookUrl, { method: "POST", headers, body: payload })
      .then(() => logger.info(`[processor] Webhook delivered for ${taskDescription.substring(0, 60)}`))
      .catch(err => logger.warn(`[processor] Webhook failed: ${err}`));
  }

  private buildRunUsage(result: InvocationResult): DelegationRunUsage {
    return {
      tokens_in: result.tokens_in ?? 0,
      tokens_out: result.tokens_out ?? 0,
      tool_uses: result.toolsUsed ?? [],
      duration_ms: result.duration_ms ?? 0,
      cost_usd: result.cost ?? 0,
    };
  }

  private buildRunEnvironment(agent: AgentConfig, cwdOverride?: string | null): DelegationRunEnvironment {
    return {
      provider: agent.provider,
      model: agent.model,
      effort: agent.effort,
      working_directory: agent.working_directory ?? null,
      cwd_override: cwdOverride ?? null,
      sandbox: agent.sandbox,
      agentic_mode: agent.agentic_mode,
      allowed_tools: agent.allowed_tools ? [...agent.allowed_tools] : undefined,
      disallowed_tools: agent.disallowed_tools ? [...agent.disallowed_tools] : undefined,
      mcp_tools: agent.mcp_tools ? [...agent.mcp_tools] : undefined,
      approved_commands: agent.approved_commands ? [...agent.approved_commands] : undefined,
    };
  }

  private recordScratchpadChange(
    run: DelegationRun | null | undefined,
    agent: string,
    filesTouched: DelegationRunFileTouch[],
    change: { filePath: string; operation: string },
  ): void {
    if (!run) return;
    const normalizedPath = change.filePath.trim();
    if (!normalizedPath) return;
    filesTouched.push({ path: normalizedPath, action: change.operation || "edit" });
    this.config.runs?.recordScratchpadFile(
      run.run_id,
      normalizedPath,
      agent,
      `Recorded via ${change.operation || "edit"}`,
    );
  }


  /**
   * Execute management actions from the orchestrator's response.
   * Delegates to ManagementActionExecutor (extracted module).
   */
  private async executeManagementActions(
    actions: AgentAction[],
    agentKey: string,
    origin?: { channel: string; senderId: string; messageId?: string },
  ): Promise<string[]> {
    const ctx: ManagementContext = {
      registry: this.config.registry,
      knowledge: this.config.knowledge,
      embedder: this.config.embedder,
      nyxhiveConfig: this.config.nyxhiveConfig,
      teams: this.config.teams,
      getAgent: (key) => this.getAgent(key),
      emit: (type, data) => this.emit(type, data),
      resolveProposalAgent: (cat, files) => this.resolveProposalAgent(cat, files),
      resolveReviewAgent: (preferredAgents) => this.resolveReviewAgent(preferredAgents),
      resolveProposalReviewModel: (preferredAgents, requestedModel) => this.resolveProposalReviewModel(preferredAgents, requestedModel),
      resolveProposalRepoPath: (files) => this.resolveProposalRepoPath(files),
      processImmediate: (opts) => this.processImmediate(opts),
      scheduler: this._scheduler,
      channels: this._channels,
      devPlanStore: this._devPlanStore,
      proposalStore: this._proposalStore,
      queue: this.queue,
      memory: this.config.memory,
    };
    return this.management.execute(actions, agentKey, ctx, origin);
  }

  private enqueueResponse(msg: MessageData, response: string, agent: string): void {
    this.queue.enqueueResponse({
      message_id: msg.message_id,
      channel: msg.channel,
      sender: msg.sender,
      sender_id: msg.sender_id,
      message: redactSecrets(response),
      original_message: msg.message,
      agent,
    });
  }

  /**
   * Process a message synchronously (for API use).
   */
  async processImmediate(opts: ProcessImmediateOpts): Promise<ProcessImmediateResult>;
  async processImmediate(opts: ProcessImmediateInternalOpts): Promise<ProcessImmediateResult>;
  async processImmediate(opts: ProcessImmediateInternalOpts): Promise<ProcessImmediateResult> {
    const benchmarkMode = !!opts.benchmark;
    const publicDiscordViewer = opts.channel === "discord" && opts.sender_role === "viewer";
    const ingressModeResolution = opts.conversationMode
      ? null
      : resolveIngressConversationMode({
          channel: opts.channel,
          senderRole: opts.sender_role,
          message: opts.message,
          attachmentCount: opts.files?.length ?? 0,
        });
    const effectiveConversationMode = opts.conversationMode ?? ingressModeResolution?.mode;
    const effectiveReasoningEffort = opts.reasoningEffort ?? ingressModeResolution?.reasoning;
    const relayContext = withRelaySenderMetadata(opts.relay, opts.sender, opts.sender_id);
    let resumeMessageId = opts._resumeMessageId;
    let resumeProcessHandle = opts._resumeProcessHandle;
    let resumeAlreadyApplied = false;
    // Check for pending clarification before routing (so agent override applies)
    let convId = this.conversationMgr.conversationId(opts.channel, opts.sender_id, opts.sender);
    const emitImmediateEvent = (type: string, data: Record<string, unknown>) => {
      const event = { type, data, timestamp: Date.now() };
      opts.onEvent?.(event);
      if (benchmarkMode) return;
      this.emit(type, data);
    };
    if (!benchmarkMode && !resumeMessageId) {
      const pending = this.findSuspendedRunForReply(opts.channel, opts.sender, opts.sender_id);
      if (pending) {
        if (pending.suspended.timeout_at <= Date.now()) {
          this.pendingClarifications.delete(pending.convId);
          logger.info(`[processor] Input request timed out for ${pending.convId}, processing reply as a new message`);
        } else {
          const resumed = this.queue.resumeSuspendedMessage(pending.suspended.message_id, opts.message, "processing");
          if (resumed) {
            resumeMessageId = resumed.message_id;
            resumeProcessHandle = resumed.process_handle;
            resumeAlreadyApplied = true;
            convId = pending.convId;
            this.pendingClarifications.delete(convId);
            if (!opts.agent && resumed.agent) opts.agent = resumed.agent;
            emitImmediateEvent("request.resolved", {
              requestId: resumed.request_id,
              kind: "user_input",
              resolution: "responded",
              resolvedAt: Date.now(),
              channel: opts.channel,
              sender_id: opts.sender_id,
              threadId: resumed.thread_id,
            });
            logger.info(`[processor] Resuming suspended input request for ${convId}`);
          }
        }
      }
    }

    // --- Input sanitization (trust-aware) ---
    const SYSTEM_CHANNELS = new Set(["system", "mcp", "scheduler", "background"]);
    const trust: TrustOrigin = opts.trust ?? (SYSTEM_CHANNELS.has(opts.channel) ? "system" : "user");
    const sanitizeResult = sanitizeInput(opts.message, trust);
    if (sanitizeResult.verdict === "block") {
      logger.warn(`[processor] BLOCKED message from ${opts.sender} (${opts.sender_id ?? "?"}), channel=${opts.channel}: ${sanitizeResult.reason}`);
      return {
        message_id: randomUUID(),
        response: "I can't process that message.",
        agent: "system",
      };
    }
    if (sanitizeResult.verdict === "warn") {
      logger.info(`[processor] WARN message from ${opts.sender} (${opts.sender_id ?? "?"}), channel=${opts.channel}: ${sanitizeResult.reason}`);
    }

    // Benchmark runs must stay read-only: skip command/proposal mutation hooks
    // and exercise only the routing/inference path.
    if (!benchmarkMode && !publicDiscordViewer && this.config.commands?.length) {
      const cmdMatch = matchCommand(opts.message, this.config.commands);
      if (cmdMatch) {
        try {
          const result = await cmdMatch.command.handler({
            message: { message_id: randomUUID(), message: opts.message, channel: opts.channel, sender: opts.sender, sender_id: opts.sender_id } as any,
            args: cmdMatch.args,
            processor: this.getPublicAPI(),
            config: this.config.nyxhiveConfig!,
            stores: this._stores!,
          });
          if (result.handled) {
            return {
              message_id: randomUUID(),
              response: result.response ?? "",
              agent: cmdMatch.command.name,
            };
          }
        } catch (err) {
          logger.error(`[processor] Command ${cmdMatch.command.name} failed: ${err}`);
        }
      }
    }

    // Check for proposal approval/rejection commands
    if (!benchmarkMode && !publicDiscordViewer && this._proposalStore) {
      const cmd = parseProposalCommand(opts.message);
      if (cmd) {
        const proposalId = `proposal-${cmd.id}`;
        const proposal = this._proposalStore.get(proposalId);
        if (!proposal) {
          return { message_id: randomUUID(), response: `Proposal #${cmd.id} not found.`, agent: "system" };
        }
        if (proposal.status !== "proposed") {
          return { message_id: randomUUID(), response: `Proposal #${cmd.id} is already ${proposal.status}.`, agent: "system" };
        }

        if (cmd.action === "approve") {
          this._proposalStore.approve(proposalId, opts.sender);
          logger.info(`[processor] Proposal ${proposalId} approved by ${opts.sender}`);

          this.emit("proposal:approved", {
            proposal_id: proposalId,
            title: proposal.title,
            category: proposal.category,
            proposed_by: proposal.proposed_by,
            approved_by: opts.sender,
          });

          // Auto-trigger execution via the executor
          if (this._proposalExecutor) {
            this._proposalExecutor.onApproved(proposalId, "approval").catch(err =>
              logger.error(`[processor] Auto-execute on approval failed: ${err}`)
            );
          }

          return { message_id: randomUUID(), response: `Proposal #${cmd.id} approved: "${proposal.title}" — execution starting.`, agent: "system" };
        }
          const rejectedProposal = this._proposalStore.reject(proposalId, cmd.reason);
          logger.info(`[processor] Proposal ${proposalId} rejected: ${cmd.reason}`);
          if (rejectedProposal) {
            this.emit("proposal:rejected", {
              proposal_id: proposalId,
              title: rejectedProposal.title,
              category: rejectedProposal.category,
              proposed_by: rejectedProposal.proposed_by,
              reason: cmd.reason,
            });
          }
          return { message_id: randomUUID(), response: `Proposal #${cmd.id} rejected: ${cmd.reason}`, agent: "system" };
      }
    }

    // Cheap local classification for routing hints (no LLM cost)
    const taskTypeHint =
      publicDiscordViewer || effectiveConversationMode === "quick"
        ? "conversation"
        : this.config.router?.classifyLocal(opts.message);
    const route = routeMessage(
      opts.message,
      this.getAgents(),
      this.config.teams ?? {},
      opts.agent
        ?? this.config.defaultAgent
        ?? resolvePrimaryAgentKey(this.getAgents(), this.config.nyxhiveConfig?.daemon),
      this.config.routing && taskTypeHint
        ? { routingStore: this.config.routing, taskType: taskTypeHint }
        : undefined,
    );
    if (route.suggestedAgent) {
      logger.info(`[processor] Skill matrix suggests @${route.suggestedAgent} for ${taskTypeHint}`);
    }

    if (route.type === "team") {
      if (benchmarkMode) {
        throw new Error("Benchmark mode does not support team routing");
      }
      return this.processTeamImmediate(opts, route.team!);
    }

    const agentKey = route.name;
    const agentConfig = route.agent!;
    const companionMode = this.isCompanionAgent(agentKey);

    // Conversation history (convId already computed above)
    const senderId = opts.sender_id ?? opts.sender;

    // Apply runtime model override (per-sender, or explicit from caller)
    const overrideKey = `${senderId}:${agentKey}`;
    let effectiveConfig = this.modelOverridesMgr.applyOverride(senderId, agentKey, agentConfig);
    const hasExplicitModelOverride = !!opts.modelOverride;
    let modelHintApplied = false;
    if (opts.modelOverride) {
      const inferred = inferProviderForModel(opts.modelOverride);
      effectiveConfig = {
        ...effectiveConfig,
        model: opts.modelOverride,
        ...(inferred ? { provider: inferred.provider, cli_fallback: inferred.cli_fallback } : {}),
      };
    }
    if (effectiveReasoningEffort) {
      effectiveConfig = { ...effectiveConfig, effort: effectiveReasoningEffort };
    }
    if (
      !hasExplicitModelOverride &&
      !this.modelOverridesMgr.has(overrideKey) &&
      opts.modelHint &&
      effectiveConfig.role === "orchestrator" &&
      !companionMode
    ) {
      const soul = loadAndCompileSoul(agentKey, undefined, this.config.instanceSoulsDir);
      const hintedModel = soul
        ? resolveModel(soul, opts.modelHint)
        : opts.modelHint === "min"
          ? effectiveConfig.min_model ?? effectiveConfig.model
          : opts.modelHint === "max"
            ? effectiveConfig.max_model ?? effectiveConfig.model
            : effectiveConfig.model;
      if (hintedModel && hintedModel !== effectiveConfig.model) {
        effectiveConfig = { ...effectiveConfig, model: hintedModel };
        modelHintApplied = true;
        logger.info(`[processor] Immediate ${agentKey} — telegram model hint ${opts.modelHint} → ${effectiveConfig.provider}/${hintedModel}`);
      }
    }
    effectiveConfig = applySenderRolePolicy(effectiveConfig, opts.sender_role);

    // Knowledge context (skip for orchestrators and scheduler-triggered tasks — they should always run fresh)
    const isSchedulerTask = opts.sender.startsWith("scheduler:");
    const extractedTaskContext = publicDiscordViewer ? undefined : this.extractTaskContext(route.strippedMessage);
    const taskContext = this.applyConversationModeTaskContext(publicDiscordViewer
      ? { taskType: "conversation", runtimeMode: "conversation", promptProfile: "conversation_light" } satisfies SystemPromptTaskContext
      : this.buildRuntimeTaskContext(
        route.strippedMessage,
        extractedTaskContext,
        taskTypeHint,
        this.lastTaskTypes.get(convId)?.type,
        (opts.files?.length ?? 0) > 0,
      ), effectiveConversationMode);
      const skipAmbientKnowledge = !taskContext?.filePaths?.length
        && (taskContext?.productRuntimeMode === "conversation" || taskContext?.productRuntimeMode === "reflection");
    const knowledgeResult = (this.isOrchestratorAgent(agentKey) || isSchedulerTask || skipAmbientKnowledge)
      ? { context: null, chunkIds: [], chunkSnippets: new Map<number, string>(), trace: undefined }
      : await this.searchKnowledgeDetailed(route.strippedMessage, undefined, taskContext);
    const knowledgeContext = knowledgeResult.context;
    if (knowledgeContext) {
      logger.info(`[processor] Immediate ${agentKey} — knowledge context: hit (${knowledgeContext.length} chars)`);
    } else {
      logger.info(`[processor] Immediate ${agentKey} — knowledge context: ${isSchedulerTask ? "skip (scheduler)" : "miss"}`);
    }

    const promptMode = effectiveConfig.always_cli ? "cli" as const : "sdk" as const;
    const senderCtx = opts.sender ? { name: opts.sender, id: opts.sender_id, channel: opts.channel, channelName: opts.channel_name, role: opts.sender_role } : undefined;
    const systemPromptResult = this.buildSystemPromptLocal(agentKey, effectiveConfig.system_prompt, knowledgeContext, opts.channel_name ?? opts.channel, taskContext, promptMode, senderCtx, knowledgeResult.trace);
    const companionContext = companionMode && this.shouldInjectCompanionContext(convId)
      ? this.buildCompanionContextBlock(convId)
      : null;
    if (companionContext) {
      systemPromptResult.prompt = `${systemPromptResult.prompt}\n\n${companionContext}`;
    }
    if (!benchmarkMode) {
      this.config.memory?.saveContextTrace(convId, agentKey, systemPromptResult.trace);
    }
    logger.info(`[processor] Immediate ${agentKey} — system prompt: ${systemPromptResult.prompt.length} chars (${promptMode}/${systemPromptResult.trace.runtimeMode ?? "unknown"}/${systemPromptResult.trace.promptProfile ?? "unknown"})`);

    const convCtx = this.buildConversationContext();
    const { messages: conversationHistory, metrics: ctxMetrics } = this.conversationMgr.getConversationHistory(convId, effectiveConfig.model, systemPromptResult.prompt.length, agentKey, convCtx);
    logger.info(`[processor] Immediate ${agentKey} — context: ${ctxMetrics.messageCount} msgs, ${ctxMetrics.tokenCount}/${ctxMetrics.budgetTokens} tokens (${ctxMetrics.utilizationPct}%)`);
    const estimatedCtxWindow = getContextWindow(effectiveConfig.model);
    const estimatedPct = estimatedCtxWindow > 0
      ? Math.round((ctxMetrics.totalTokens / estimatedCtxWindow) * 100)
      : 0;
    const tokenReport = this.buildInvocationTokenReport({
      scope: `immediate ${agentKey}`,
      model: effectiveConfig.model,
      systemPromptResult,
      conversationHistory,
      ctxMetrics,
    });
    emitImmediateEvent("context:metrics", {
      convId,
      model: effectiveConfig.model,
      utilizationPct: estimatedPct,
      tokenCount: ctxMetrics.totalTokens,
      budgetTokens: estimatedCtxWindow,
      estimated: true,
      ...this.tokenReportEventFields(tokenReport),
    });

    // Enqueue as 'processing' so poll loop doesn't double-pick it
    // Store file metadata (without base64) in DB for audit; full data threads through in-memory
    const { files: _files, onProgress: _onProgress, onEvent: _onEvent, relay: _relay, ...enqueueOpts } = opts;
    const filesMetadata = opts.files?.length
      ? JSON.stringify(opts.files.map((f) => ({ name: f.name, mimeType: f.mimeType, size: f.size })))
      : undefined;
    const messageId = benchmarkMode
      ? randomUUID()
      : resumeMessageId
        ? (resumeAlreadyApplied
          ? resumeMessageId
          : (() => {
              const resumed = this.queue.resumeSuspendedMessage(resumeMessageId!, opts.message, "processing");
              if (!resumed) {
                throw new Error(`Suspended message ${resumeMessageId} not found`);
              }
              return resumed.message_id;
            })())
        : this.queue.enqueueMessage({
          ...enqueueOpts,
          task_id: opts.task_id,
          agent: agentKey,
          status: "processing",
          files: filesMetadata,
          relay: relayContext,
        });

    // NOTE: Do NOT register opts.onEvent as a per-message EventBus listener here.
    // emitImmediateEvent() already calls opts.onEvent directly — registering it
    // on EventBus too would cause every event (especially token/delta) to fire
    // twice, duplicating streamed response text in the CLI.

    // Emit routing event (after messageId so per-message listener captures it)
    emitImmediateEvent("routing", {
      message_id: messageId,
      agent: agentKey,
      channel: opts.channel,
      route_type: route.type,
    });

    // Start trace
    let traceId: string | null = null;
    if (this.config.traces && !benchmarkMode) {
      traceId = `trace-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      this.config.traces.startTrace({
        id: traceId,
        originMessageId: messageId,
        channel: opts.channel,
        sender: opts.sender,
        senderId: opts.sender_id,
        inputMessage: opts.message,
      });
    }

    // Emit trace event for knowledge search (after traceId exists)
    if (traceId) {
      this.emit("trace:knowledge_search", {
        message_id: messageId,
        trace_id: traceId,
        channel: opts.channel,
        agent: agentKey,
        runtime_mode: systemPromptResult.trace.runtimeMode,
        prompt_profile: systemPromptResult.trace.promptProfile,
        memory_lanes: systemPromptResult.trace.memoryLanesInjected,
        results: knowledgeContext ? 1 : 0,
        threshold: 0.55,
      });
    }

    const run = benchmarkMode ? null : this.config.runs?.createRun({
      task_id: opts.task_id ?? null,
      message_id: messageId,
      trace_id: traceId,
      task_description: route.strippedMessage,
      agent: agentKey,
      brain: resolveRunBrain(effectiveConfig),
      status: "running",
      environment: this.buildRunEnvironment(effectiveConfig, opts.cwdOverride ?? null),
    }) ?? null;
    const invokeMessage = run
      ? `${buildRunContextNote(run.run_id, run.scratchpad_dir)}${route.strippedMessage}`
      : route.strippedMessage;
    recordInboundFileArtifacts(this.config.runs, opts.files, {
      run_id: run?.run_id ?? null,
      message_id: messageId,
      trace_id: traceId,
      channel: opts.channel,
    });
    const runFilesTouched: DelegationRunFileTouch[] = [];

    // Cancellation support
    const abortController = new AbortController();
    if (!benchmarkMode) {
      this.activeProcesses.set(convId, {
        controller: abortController,
        agent: agentKey,
        startedAt: Date.now(),
        messageExcerpt: opts.message.slice(0, 60),
      });
    }

    try {
      // Start trace event for primary agent
      let primaryEventId: number | null = null;
      if (this.config.traces && traceId) {
        primaryEventId = this.config.traces.startEvent(traceId, agentKey, route.strippedMessage);
      }

      // Emit streaming SSE events (wraps caller's onProgress if provided)
      emitImmediateEvent("response:start", {
        message_id: messageId,
        agent: agentKey,
        channel: opts.channel,
        sender_id: opts.sender_id,
      });

      let lastProgressActivity = "";
      let lastProgressText = "";
      const sseProgress = (info: CLIProgress) => {
        const nextActivity = info.activity?.trim() ?? "";
        const nextText = info.textSoFar?.trim() ?? "";
        if (!benchmarkMode && (nextActivity !== lastProgressActivity || nextText !== lastProgressText)) {
          this.queue.updateMessageProgress(messageId, {
            activity: nextActivity || undefined,
            text: nextText || undefined,
          });
          lastProgressActivity = nextActivity;
          lastProgressText = nextText;
        }
        if (run) {
          this.config.runs?.updateProgress(run.run_id, {
            status: "running",
            usage: {
              tokens_in: info.tokensIn,
              tokens_out: info.tokensOut,
              duration_ms: Math.round(info.elapsed * 1000),
            },
          });
        }

        if (info.phase === "responding" && info.textDelta && info.streamingSafe !== false) {
          const rawTextSoFar = info.textSoFar || "";
          const cleanTextSoFar = sanitizeAssistantResponse(rawTextSoFar);
          if (!cleanTextSoFar) return;
          emitImmediateEvent("response:delta", {
            message_id: messageId,
            text_delta: cleanTextSoFar === rawTextSoFar.trim() ? info.textDelta : "",
            text_so_far: cleanTextSoFar,
            agent: agentKey,
            channel: opts.channel,
            sender_id: opts.sender_id,
          });
          if (cleanTextSoFar === rawTextSoFar.trim()) {
            emitImmediateEvent("token", {
              message_id: messageId,
              text: info.textDelta,
              agent: agentKey,
              channel: opts.channel,
              sender_id: opts.sender_id,
            });
          }
        }
        if (info.executionEvent) {
          emitImmediateEvent("execution:event", {
            message_id: messageId,
            agent: info.agent ?? agentKey,
            channel: opts.channel,
            sender_id: opts.sender_id,
            ...info.executionEvent,
          });
          if (info.executionEvent.phase === "started") {
            emitImmediateEvent("tool:start", {
              message_id: messageId,
              agent: info.agent ?? agentKey,
              channel: opts.channel,
              tool: info.executionEvent.title,
              input: info.executionEvent.subtitle ?? info.executionEvent.command ?? null,
            });
          }
        }
        if (info.phase === "working" && info.activity && traceId) {
          emitImmediateEvent("trace:tool_use", {
            message_id: messageId,
            trace_id: traceId,
            channel: opts.channel,
            agent: agentKey,
            tool: info.activity,
          });
        }
        // Emit agent:progress for SSE consumers (iOS)
        if (info.phase === "working") {
          emitImmediateEvent("agent:progress", {
            message_id: messageId,
            agent: info.agent ?? agentKey,
            channel: opts.channel,
            sender_id: opts.sender_id,
            turns: info.turns,
            tokensIn: info.tokensIn,
            tokensOut: info.tokensOut,
            elapsed: info.elapsed,
            activity: info.activity,
            delegationDepth: info.delegationDepth ?? 0,
          });
        }
        opts.onProgress?.(info);
      };
      const toolMode = "auto" as const;
      const onRemoteDown = (info: { slug: string; url: string; reason: string; availableTools?: string[] }) => {
        const changed = this.recordRemoteMcpHealth(info.slug, info.url, "down", info.reason);
        emitImmediateEvent("remote:mcp_down", {
          message_id: messageId,
          agent: agentKey,
          channel: opts.channel,
          slug: info.slug,
          url: info.url,
          reason: info.reason,
          available_tools: info.availableTools ?? [],
        });
        emitImmediateEvent("agent:progress", {
          message_id: messageId,
          agent: agentKey,
          channel: opts.channel,
          sender_id: opts.sender_id,
          turns: 0,
          tokensIn: 0,
          tokensOut: 0,
          elapsed: 0,
          activity: `${info.slug} MCP is down, operating without it`,
          delegationDepth: 0,
        });
        if (!changed || !this.config.nyxhiveConfig) return;
        const alert = `Remote MCP down: ${info.slug} at ${info.url}. Operating without it.`;
        for (const target of resolveNotificationTargets(this.config.nyxhiveConfig, "alerts")) {
          const batcher = this._batcher;
          if (batcher) {
            batcher.queue(target, { type: "alerts", priority: "critical", content: alert, queuedAt: Date.now() }).catch(() => {});
            continue;
          }
          const ch = this._channels?.find((channel) => channel.name.toLowerCase() === target.channel.toLowerCase());
          ch?.sendOutbound?.(target.recipient, alert).catch(() => {});
        }
      };

      const threadSessionKey = `${convId}:${agentKey}`;
      this.seedCliSessionFromHandle(threadSessionKey, resumeProcessHandle);
      const invokeOpts = {
        baseDir: this.config.baseDir,
        messageId,
        runId: run?.run_id ?? null,
        traceId,
        channel: opts.channel,
        cwdOverride: opts.cwdOverride,
        systemPrompt: systemPromptResult.prompt,
        knowledgeContext: knowledgeContext ?? undefined,
        conversationHistory,
        sessionId: resumeProcessHandle?.session_id ?? this.resolveCliSessionIdForTurn(threadSessionKey, effectiveConfig, {
          message: route.strippedMessage,
          runtimeMode: systemPromptResult.trace.runtimeMode,
        }),
        senderName: opts.sender,
        router: this.config.router,
        config: this.config.nyxhiveConfig,
        agentKey,
        classificationOverride: publicDiscordViewer || effectiveConversationMode === "quick" ? "conversation" as TaskType : undefined,
        cliEscalationTasks: this.config.cliEscalationTasks,
        modelOverride: hasExplicitModelOverride || this.modelOverridesMgr.has(overrideKey) || modelHintApplied,
        toolMode,
        runtimeMode: systemPromptResult.trace.runtimeMode,
        dualBrain: this.config.dualBrain,
        lastTaskType: this.lastTaskTypes.get(convId)?.type,
        onProgress: sseProgress,
        onRemoteDown,
        files: opts.files,
        runs: this.config.runs,
        signal: abortController.signal,
        sandbox: this.config.sandbox,
        registry: this.config.registry,
        scheduler: this._scheduler,
        memory: this.config.memory,
        knowledge: this.config.knowledge,
        compiledKnowledge: this.config.compiledKnowledge,
        embedder: this.config.embedder,
        vault: this.config.vault,
        instanceSoulsDir: this.config.instanceSoulsDir,
        onFileChange: (change: any) => this.recordScratchpadChange(run, agentKey, runFilesTouched, change),
      };

      const agentTimeoutMs = effectiveConfig.timeout_ms ?? AGENT_TIMEOUT_MS;

      // Ralph mode: autonomous iteration loop
      const useRalphMode = opts.mode === "ralph";
      const useKernelRuntime = this.shouldUseKernelPrimaryPath({
        agentKey,
        message: opts.message,
        useRalphMode,
        resumeProcessHandle,
      });
      if (useRalphMode) {
        // Inject ralph instructions into system prompt
        invokeOpts.systemPrompt = `${invokeOpts.systemPrompt}\n\n${buildRalphInstructions(RALPH_MAX_ROUNDS)}`;
        logger.info(`[processor] Ralph mode enabled for ${agentKey}, max ${RALPH_MAX_ROUNDS} rounds`);
      }

      const result = useRalphMode
        ? await executeRalphLoop({
            agentConfig: effectiveConfig,
            task: invokeMessage,
            invokeOpts,
            timeoutMs: agentTimeoutMs,
            onProgress: sseProgress,
            onIteration: (iteration) => {
              emitImmediateEvent("ralph:iteration", {
                message_id: messageId,
                agent: agentKey,
                round: iteration.round,
                verification_result: iteration.verification_result,
                error: iteration.error,
              });
            },
          }).then((r) => r.finalResult)
        : await Promise.race([
            useKernelRuntime
              ? this.invokeKernelRuntimeForImmediate({
                  agentKey,
                  agentConfig: effectiveConfig,
                  message: invokeMessage,
                  messageId,
                  channel: opts.channel,
                  sender: opts.sender,
                  senderId: opts.sender_id,
                  threadId: opts.thread_id,
                  conversationId: convId,
                  files: opts.files,
                  invokeOpts,
                  emitImmediateEvent,
                })
              : invokeAgent(effectiveConfig, invokeMessage, invokeOpts),
            new Promise<never>((_, reject) => {
              setTimeout(() => reject(new Error(`Agent ${agentKey} timed out after ${Math.round(agentTimeoutMs / 1000)}s`)), agentTimeoutMs);
            }),
          ]);

      // Track task type for follow-up detection
      if (!benchmarkMode && result.task_type) {
        this.lastTaskTypes.set(convId, { type: result.task_type, setAt: Date.now() });
      }

      // Track resumable runtime session for conversation continuity on the next message.
      if (!benchmarkMode) {
        this.rememberInvocationSession(threadSessionKey, effectiveConfig, result);
      }

      // Complete primary trace event with model routing data
      if (this.config.traces && primaryEventId) {
        this.config.traces.completeEvent(primaryEventId, {
          responseExcerpt: result.response.slice(0, 500),
          tokensIn: result.tokens_in,
          tokensOut: result.tokens_out,
          cost: result.cost,
          durationMs: result.duration_ms,
          model: result.model ?? effectiveConfig.model,
          taskType: result.task_type,
          billingType: getBillingType(result.method, result.model ?? effectiveConfig.model),
          metadata: {
            runtimeEvents: result.runtime_events ?? [],
            authority: result.runtime_events?.find((event) => event.kind === "authority.resolved")?.payload ?? null,
          },
        });
      }

      // Emit post-turn context metrics.
      // For Codex SDK, last_turn_tokens_in reflects Codex's internal thread/session usage,
      // which can be far larger than the compact prompt window NyxHive actually built.
      // Use NyxHive's own context accounting for the user-facing badge on that path.
      const contextTokenCount =
        effectiveConfig.cli_fallback === "codex"
          ? ctxMetrics.totalTokens
          : result.last_turn_tokens_in;
      if (contextTokenCount) {
        const ctxWindow = getContextWindow(result.model ?? effectiveConfig.model);
        const realPct = Math.round((contextTokenCount / ctxWindow) * 100);
        emitImmediateEvent("context:metrics", {
          convId,
          model: result.model ?? effectiveConfig.model,
          utilizationPct: realPct,
          tokenCount: contextTokenCount,
          budgetTokens: ctxWindow,
          estimated: false,
          ...this.tokenReportEventFields(tokenReport),
        });
      }

      // Budget check (usage data comes from trace_events)
      if (!benchmarkMode) {
        this.checkBudget();
      }

      // Record invocation stats in registry
      if (!benchmarkMode) {
        this.config.registry?.recordInvocation(agentKey, {
          tokensIn: result.tokens_in ?? 0,
          tokensOut: result.tokens_out ?? 0,
          success: true,
          costCents: Math.round((result.cost ?? 0) * 100),
        });
      }

      const inputRequest = inputRequestFromResult(result);
      if (!benchmarkMode && inputRequest) {
        const responseText = formatInputRequestForDisplay(inputRequest);
        this.conversationMgr.saveToHistory(
          convId, opts.channel, opts.sender_id ?? opts.sender,
          route.strippedMessage, responseText,
          result.model ?? effectiveConfig.model, effectiveConfig.provider,
          result.tokens_in ?? 0, result.tokens_out ?? 0, result.cost ?? 0,
          agentKey, convCtx,
        );
        this.suspendMessageRun({
          messageId,
          convId,
          channel: opts.channel,
          sender: opts.sender,
          senderId: opts.sender_id,
          taskId: opts.task_id,
          agentKey,
          threadId: opts.channel === "gateway" ? opts.sender_id : this.threadIdFromImmediateOpts(opts),
          originalMessage: route.strippedMessage,
          responseText,
          request: inputRequest,
          result,
        });
        this.enqueueResponse(
          { message_id: messageId, task_id: opts.task_id, channel: opts.channel, sender: opts.sender, sender_id: opts.sender_id, message: route.strippedMessage } as MessageData,
          responseText,
          agentKey,
        );
        this.persistImmediateThreadResponse({
          threadId: this.threadIdFromImmediateOpts(opts),
          messageId,
          response: responseText,
          agent: agentKey,
          traceId,
          cost: result.cost,
          tokensIn: result.tokens_in,
          tokensOut: result.tokens_out,
          durationMs: result.duration_ms,
          userMessage: route.strippedMessage,
        });
        if (run) {
          this.config.runs?.updateProgress(run.run_id, {
            status: "running",
            result: deriveRunResult({
              response: responseText,
              status: "completed",
              scratchpadDir: run.scratchpad_dir,
              scratchpadFiles: this.config.runs?.getScratchpadFiles(run.run_id),
              filesTouched: runFilesTouched,
              invocation: result,
            }),
          });
        }
        emitImmediateEvent("response:complete", {
          message_id: messageId,
          agent: agentKey,
          channel: opts.channel,
          sender_id: opts.sender_id,
          trace_id: traceId,
          tokens_in: result.tokens_in,
          tokens_out: result.tokens_out,
          cost: result.cost,
          duration_ms: result.duration_ms,
          text_so_far: responseText,
        });
        return { message_id: messageId, response: responseText, agent: agentKey, trace_id: traceId ?? undefined, tokens_in: result.tokens_in, tokens_out: result.tokens_out, cost: result.cost, duration_ms: result.duration_ms };
      }

      // Validate orchestrator delegation before actor model processing
      const delegationCtx = this.buildDelegationContext(relayContext, run, opts.task_id ?? null);
      this.delegation.validateOrchestratorDelegation(result, agentKey, route.strippedMessage, delegationCtx);

      // Actor model: process mentions recursively
      let finalResponse = await this.delegation.processWithActorModel(
        result, traceId, primaryEventId, convId, opts.channel, opts.sender_id ?? opts.sender,
        0, { value: 1 }, delegationCtx, messageId, sseProgress, opts.message,
      );
      finalResponse = assertDeliverableResponse(this.sanitizeResponse(finalResponse), messageId);

      // Save to conversation history
      if (!benchmarkMode) {
        this.conversationMgr.saveToHistory(
          convId, opts.channel, opts.sender_id ?? opts.sender,
          route.strippedMessage, finalResponse,
          result.model ?? effectiveConfig.model, effectiveConfig.provider,
          result.tokens_in ?? 0, result.tokens_out ?? 0, result.cost ?? 0,
          agentKey, convCtx,
        );
      }

      // Memory extraction (fire-and-forget, don't block response delivery)
      if (!benchmarkMode) {
        this.extractAndPersistMemoriesLocal(
          convId, agentKey, route.strippedMessage, finalResponse, opts.channel, opts.sender,
        ).catch(() => {}); // Errors already logged inside
        this.recordProceduralSkillDraftLocal(
          convId, agentKey, route.strippedMessage, finalResponse, opts.channel, opts.sender, traceId,
        );
      }

      if (!benchmarkMode && this.config.knowledge && knowledgeResult.chunkSnippets.size > 0) {
        try {
          applyRetrievalFeedback(this.config.knowledge, knowledgeResult.chunkSnippets, finalResponse);
        } catch { /* non-critical */ }
      }

      // Redact outbound: secrets always, internal details in group context
      const redactedResponse = opts.is_group ? redactForGroup(finalResponse) : redactSecrets(finalResponse);

      if (!benchmarkMode) {
        this.queue.clearSuspendedMessage(messageId);
        this.queue.completeMessage(messageId);
        this.enqueueResponse(
          { message_id: messageId, task_id: opts.task_id, channel: opts.channel, sender: opts.sender, sender_id: opts.sender_id, message: opts.message } as MessageData,
          redactedResponse,
          agentKey,
        );
        this.persistImmediateThreadResponse({
          threadId: opts.thread_id,
          messageId,
          response: redactedResponse,
          agent: agentKey,
          traceId,
          cost: result.cost,
          tokensIn: result.tokens_in,
          tokensOut: result.tokens_out,
          durationMs: result.duration_ms,
          userMessage: route.strippedMessage,
        });
      }

      if (run) {
        this.config.runs?.completeRun(run.run_id, {
          status: "completed",
          result: deriveRunResult({
            response: finalResponse,
            status: "completed",
            scratchpadDir: run.scratchpad_dir,
            scratchpadFiles: this.config.runs?.getScratchpadFiles(run.run_id),
            filesTouched: runFilesTouched,
            invocation: result,
          }),
          usage: this.buildRunUsage(result),
          trace_id: traceId,
        });
      }

      // Complete trace
      if (this.config.traces && traceId) {
        this.config.traces.completeTrace(traceId, finalResponse);
      }

      emitImmediateEvent("response:complete", {
        message_id: messageId,
        agent: agentKey,
        channel: opts.channel,
        sender_id: opts.sender_id,
        trace_id: traceId,
        tokens_in: result.tokens_in,
        tokens_out: result.tokens_out,
        cost: result.cost,
        duration_ms: result.duration_ms,
        text_so_far: redactedResponse,
      });

      return { message_id: messageId, response: redactedResponse, agent: agentKey, trace_id: traceId ?? undefined, tokens_in: result.tokens_in, tokens_out: result.tokens_out, cost: result.cost, duration_ms: result.duration_ms };
    } catch (err) {
      const errorMsg = formatError(err);
      if (this.config.traces && traceId) {
        this.config.traces.failTrace(traceId, errorMsg);
      }
      // Immediate processing — don't retry via poll loop, mark as dead letter
      if (!benchmarkMode) {
        this.queue.clearSuspendedMessage(messageId);
        this.queue.failMessage(messageId, errorMsg, QueueDB.isTransientError(errorMsg) ? 2 : 0);
      }
      if (run) {
        const status: DelegationRunStatus = err instanceof Error && err.name === "AbortError" ? "killed" : "failed";
        this.config.runs?.completeRun(run.run_id, {
          status,
          result: deriveRunResult({
            response: "",
            status,
            scratchpadDir: run.scratchpad_dir,
            scratchpadFiles: this.config.runs?.getScratchpadFiles(run.run_id),
            filesTouched: runFilesTouched,
            error: errorMsg,
          }),
          usage: {
            tokens_in: 0,
            tokens_out: 0,
            tool_uses: [],
            duration_ms: 0,
            cost_usd: 0,
          },
          trace_id: traceId,
        });
      }
      if (!benchmarkMode) {
        const userFacingError = `I wasn't able to process your request. Error: ${errorMsg.slice(0, 200)}`;
        this.enqueueResponse(
          { message_id: messageId, task_id: opts.task_id, channel: opts.channel, sender: opts.sender, sender_id: opts.sender_id, message: opts.message } as MessageData,
          userFacingError,
          agentKey,
        );
        this.persistImmediateThreadResponse({
          threadId: this.threadIdFromImmediateOpts(opts),
          messageId,
          response: userFacingError,
          agent: agentKey,
          traceId,
          userMessage: opts.message,
        });
        emitImmediateEvent("response:complete", {
          message_id: messageId,
          agent: agentKey,
          channel: opts.channel,
          sender_id: opts.sender_id,
          trace_id: traceId,
          text_so_far: userFacingError,
        });
        return { message_id: messageId, response: userFacingError, agent: agentKey, trace_id: traceId ?? undefined };
      }
      throw err;
    } finally {
      this.activeProcesses.delete(convId);
    }
  }

  private async processTeamImmediate(
    opts: { channel: string; sender: string; sender_id?: string; message: string },
    team: TeamConfig,
  ): Promise<{ message_id: string; response: string; agent: string }> {
    const conversationId = `team:${Date.now()}`;
    this.conversations.startConversation(conversationId, team);

    const messageId = this.queue.enqueueMessage({ ...opts, agent: team.agents[0], status: "processing" });

    while (!this.conversations.isComplete(conversationId)) {
      const nextAgent = this.conversations.getNextAgent(conversationId);
      if (!nextAgent) break;

      const agentConfig = this.getAgent(nextAgent);
      if (!agentConfig) {
        logger.error(`[processor] Team agent ${nextAgent} not found`);
        break;
      }

      const context = this.conversations.getConversationContext(conversationId);
      const teamPromptMode = agentConfig.always_cli ? "cli" as const : "sdk" as const;
      const teamSystemPrompt = this.buildSystemPromptLocal(nextAgent, agentConfig.system_prompt, null, opts.channel, undefined, teamPromptMode);
      this.config.memory?.saveContextTrace(conversationId, nextAgent, teamSystemPrompt.trace);
      const result = await invokeAgent(agentConfig, opts.message, {
        baseDir: this.config.baseDir,
        channel: opts.channel,
        conversationContext: context || undefined,
        systemPrompt: teamSystemPrompt.prompt,
        router: this.config.router,
        config: this.config.nyxhiveConfig,
        agentKey: nextAgent,
        senderName: opts.sender,
        cliEscalationTasks: this.config.cliEscalationTasks,
        sandbox: this.config.sandbox,
        registry: this.config.registry,
        scheduler: this._scheduler,
        memory: this.config.memory,
        knowledge: this.config.knowledge,
        compiledKnowledge: this.config.compiledKnowledge,
        embedder: this.config.embedder,
        vault: this.config.vault,
        instanceSoulsDir: this.config.instanceSoulsDir,
      });

      this.conversations.addAgentResponse(conversationId, nextAgent, result.response);
    }

    const aggregated = this.conversations.getAggregatedResponse(conversationId);
    this.conversations.endConversation(conversationId);
    this.queue.completeMessage(messageId);

    return { message_id: messageId, response: aggregated, agent: team.name };
  }
}

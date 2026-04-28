import { existsSync, rmSync, realpathSync } from "node:fs";
import { normalize, resolve } from "node:path";
import { logger } from "../utils/logger.js";
import type { AgentConfig, NyxHiveConfig, InvocationResult } from "../types.js";
import type { CredentialVault } from "../security/vault.js";
import type { ProviderRouter } from "../providers/router.js";
import { DEFAULT_CLI_ESCALATION_TASKS } from "../defaults.js";
import type { TaskType, ProviderName, FileAttachment, ClassificationResult } from "../providers/types.js";
import type { Sandbox } from "../sandbox/index.js";
import { getModelTier } from "../defaults.js";
import type { ProceduralSkillDraftStore } from "../memory/procedural-skills.js";
import { hasExplicitActionIntent, hasFileReferenceIntent, isSocialConversationalTurn, resolvePromptProfile, resolveRuntimeMode, type PromptProfile, type RuntimeMode } from "../runtime/mode.js";
import type { DelegationRunStore } from "../runs/store.js";

// ── Re-exports from split modules ──
export { invokeClientSDK } from "./invoke-sdk.js";
export { invokeCLI } from "./invoke-cli.js";
export { invokeCodexSdk } from "./invoke-codex-sdk.js";
export { invokeNativeAPI } from "./invoke-native-api.js";
export { createOpenAIAgentsOrchestrator, isAgentsSdkOrchestrationEnabled } from "./orchestration/openai-agents.js";
export { parseClaudeJsonOutput } from "./output-parsers.js";
export type { CLIParseResult } from "./output-parsers.js";

// ── Local imports from split modules (used by invokeAgent routing) ──
import { invokeClientSDK } from "./invoke-sdk.js";
import { invokeCLI, shouldUseNativeEvidenceReview } from "./invoke-cli.js";
import { invokeCodexSdk } from "./invoke-codex-sdk.js";
import { invokeNativeAPI } from "./invoke-native-api.js";
import { resolveBrainForTask } from "./primary.js";
import { createOpenAIAgentsOrchestrator, isAgentsSdkOrchestrationEnabled } from "./orchestration/openai-agents.js";

// ── Shared state ──

/** Temp directories created during agent invocations, cleaned up on shutdown via {@link cleanupTempFiles}. */
export const pendingTempDirs = new Set<string>();

/** Regex to detect Anthropic model IDs. Used as a safety guard to prevent routing Claude models through native API. */
export const ANTHROPIC_MODEL_PATTERN = /^(anthropic\/)?claude-/i;

const STRICT_CODEX_DIRECT_TASK_TYPE = "nyx_direct" as const;
const LOW_ACTION_TASK_TYPES = new Set<TaskType>(["trivial", "simple_qa", "conversation", "summarization"]);

// MCP tools are declared per-agent in soul YAML (capabilities.mcp_tools).
// No role-based defaults — souls are the single source of truth for tool access.

const BLOCKED_DIRS = ["/etc", "/root", "/boot", "/sys", "/proc", "/dev", "/run", "/usr/bin", "/usr/sbin", "/bin", "/sbin"];

function isBlockedPath(path: string): boolean {
  return BLOCKED_DIRS.some((blocked) => path === blocked || path.startsWith(`${blocked}/`));
}

/**
 * Validate and resolve a directory path, blocking access to sensitive system directories.
 * Rejects null bytes, resolves symlinks, and checks against BLOCKED_DIRS.
 * Checks both the normalized input AND the resolved realpath to catch symlink bypasses
 * (e.g. macOS where /etc → /private/etc).
 * @returns The resolved real path.
 * @throws If the path contains null bytes or points to a blocked system directory.
 */
export function validateAllowedDirectory(dir: string): string {
  // Reject null bytes — can truncate paths in C-based syscalls
  if (dir.includes("\0")) {
    throw new Error(`Invalid directory path (null byte): ${dir.replace(/\0/g, "\\0")}`);
  }
  const normalized = normalize(dir);
  // Check the normalized input path BEFORE resolving symlinks —
  // catches /etc even when realpath would resolve to /private/etc
  if (isBlockedPath(normalized)) {
    throw new Error(`Blocked system directory: ${dir}`);
  }
  let real: string;
  try {
    real = realpathSync(normalized);
  } catch {
    // Path doesn't exist yet — resolve to absolute and strip any remaining ".." segments
    // that could bypass BLOCKED_DIRS when the directory is later created.
    real = resolve(normalized);
  }
  // Also check the resolved path — catches symlink targets that land in blocked dirs
  if (isBlockedPath(real)) {
    throw new Error(`Blocked system directory: ${dir}`);
  }
  return real;
}

/** Remove all temp directories tracked in {@link pendingTempDirs}. Called on graceful shutdown. */
export function cleanupTempFiles(): void {
  for (const dir of pendingTempDirs) {
    try {
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true });
      }
    } catch {}
  }
  pendingTempDirs.clear();
}

// ── Shared types ──

/** A single message in a conversation history, used for context injection into agent invocations. */
export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ExecutionEvent {
  id: string;
  kind: "command" | "file_change" | "mcp_tool" | "web_search" | "status";
  phase: "started" | "updated" | "completed" | "failed";
  turn?: number;
  title: string;
  subtitle?: string;
  details?: string;
  command?: string;
  outputPreview?: string;
  exitCode?: number | null;
  changes?: Array<{ path: string; kind: "add" | "delete" | "update" }>;
  timestamp: number;
}

/** Real-time progress info emitted by CLI/SDK agent invocations via the `onProgress` callback. */
export interface CLIProgress {
  turns: number;
  tokensIn: number;
  tokensOut: number;
  elapsed: number; // seconds
  activity?: string; // last tool/action, e.g. "Reading invoke.ts", "Running tests"
  textDelta?: string;    // new text since last callback
  textSoFar?: string;    // accumulated text of current response
  streamingSafe?: boolean; // safe to surface directly in chat without CLI narration noise
  phase: "working" | "responding"; // "working" while using tools, "responding" when generating final text
  executionEvent?: ExecutionEvent;
  // Delegation context
  agent?: string;           // which agent is active
  delegationDepth?: number; // 0 = root, 1 = first delegation, etc.
}

export interface RemoteMcpDownEvent {
  slug: string;
  url: string;
  reason: string;
  availableTools?: string[];
}

/** Options bag for {@link invokeAgent}. Carries runtime context, subsystem refs, and progress callbacks. */
export interface InvokeOpts {
  baseDir: string;
  cwdOverride?: string;
  conversationContext?: string;
  conversationHistory?: ConversationMessage[];
  messageId?: string;
  runId?: string | null;
  traceId?: string | null;
  channel?: string;
  systemPrompt?: string;
  knowledgeContext?: string;
  router?: ProviderRouter;
  config?: NyxHiveConfig;
  agentKey?: string;
  cliEscalationTasks?: string[];
  modelOverride?: boolean; // true when user explicitly overrode the model
  toolMode?: "auto" | "off"; // companion fast path can suppress tool exposure for obvious chat turns
  runtimeMode?: RuntimeMode; // prompt-time mode selected before invocation, if already known
  classificationOverride?: TaskType; // caller-enforced classification for constrained surfaces
  lastTaskType?: string;   // previous message's task type for follow-up detection
  onProgress?: (info: CLIProgress) => void; // called on each CLI turn for live progress
  onRemoteDown?: (info: RemoteMcpDownEvent) => void;
  sessionId?: string; // Runtime-specific resume token for conversation continuity
  senderName?: string; // Human-readable name of current speaker (for identity injection on --resume)
  files?: FileAttachment[]; // image attachments from Discord/Telegram
  runs?: Pick<DelegationRunStore, "recordBlockedPath">;
  signal?: AbortSignal; // for task cancellation
  freshRuntimeConnection?: boolean; // bypass pooled app-server reuse for fragile interactive turns
  codexRuntime?: "cli" | "app_server"; // per-invocation override for Codex transport; app_server also requires NYXHIVE_CODEX_APP_SERVER=1
  streamCodexProgress?: boolean; // disable for short workspace chat turns where buffered stdout is more reliable
  sandbox?: Sandbox; // CLI sandboxing wrapper
  registry?: import("./registry.js").AgentRegistry;
  scheduler?: import("../scheduler/index.js").Scheduler;
  memory?: import("../memory/store.js").MemoryStore;
  knowledge?: import("../memory/knowledge.js").KnowledgeStore;
  compiledKnowledge?: import("../memory/compiled-knowledge.js").CompiledKnowledgeStore;
  embedder?: import("../memory/embeddings.js").EmbeddingProvider;
  proceduralSkills?: ProceduralSkillDraftStore;
  vault?: CredentialVault;
  /** Callback for file change tracking (write_file/edit_file) */
  onFileChange?: (change: { filePath: string; operation: string; linesAdded: number; linesRemoved: number; diffSummary?: string }) => void;
  /** Called every 30s during subprocess invocation so the registry can record a heartbeat */
  onHeartbeat?: () => void;
  /** Internal flag — prevents infinite retry on empty responses */
  _emptyRetried?: boolean;
  dualBrain?: import("./primary.js").DualBrainConfig;
  /** Override directory for instance.yaml lookup — points to the instance's own souls dir */
  instanceSoulsDir?: string;
}

function createAbortError(reason: unknown, fallbackMessage: string): Error {
  if (reason instanceof Error) {
    reason.name = "AbortError";
    return reason;
  }
  const message = typeof reason === "string" && reason.trim() ? reason : fallbackMessage;
  const err = new Error(message);
  err.name = "AbortError";
  return err;
}

function isRateLimitError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { status?: number }).status === 429;
}

function shouldFailWithoutFallback(agent: AgentConfig, config: NyxHiveConfig | undefined): boolean {
  if (agent.agentic_mode !== "strict" || agent.cli_fallback !== "codex") return false;
  const providerConfig = config?.providers?.[agent.provider];
  return providerConfig?.fallback === "none" || providerConfig?.auth_mode === "codex" || agent.provider === "openai";
}

function shouldBypassConversationalRouting(agent: AgentConfig): boolean {
  return agent.agentic_mode === "strict"
    && agent.always_cli === true
    && agent.cli_fallback === "codex"
    && agent.capabilities?.includes("tool_use") === true;
}

export function isLowActionTaskType(taskType: string | undefined): boolean {
  return !!taskType && LOW_ACTION_TASK_TYPES.has(taskType as TaskType);
}

function compactLogValue(value: string | undefined, maxLen = 32): string | undefined {
  const compact = value?.trim().replace(/\s+/g, "_");
  if (!compact) return undefined;
  return compact.length > maxLen ? `${compact.slice(0, maxLen - 1)}~` : compact;
}

function shortLogId(value: string | undefined, maxLen = 8): string | undefined {
  const compact = value?.trim();
  if (!compact) return undefined;
  return compact.slice(0, maxLen);
}

export function formatInvocationLogLabel(
  agentName: string,
  opts: Pick<InvokeOpts, "messageId" | "channel" | "senderName">,
  extras?: Record<string, string | number | boolean | undefined>,
): string {
  const pairs: Array<[string, string | number | boolean | undefined]> = [
    ["msg", shortLogId(opts.messageId)],
    ["ch", compactLogValue(opts.channel)],
    ["from", compactLogValue(opts.senderName, 24)],
    ["agent", compactLogValue(agentName, 24)],
  ];
  if (extras) {
    for (const [key, value] of Object.entries(extras)) {
      pairs.push([key, typeof value === "string" ? compactLogValue(value, 24) ?? value : value]);
    }
  }
  const rendered = pairs
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([key, value]) => `${key}=${String(value)}`);
  return rendered.length > 0 ? `[${rendered.join(" ")}]` : "";
}

export function buildClassificationLogPayload(
  message: string,
  agentName: string,
  opts: Pick<InvokeOpts, "messageId" | "channel" | "senderName">,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...payload,
    agent: agentName,
    ...(opts.messageId ? { message_id: opts.messageId } : {}),
    ...(opts.channel ? { channel: opts.channel } : {}),
    ...(opts.senderName ? { sender: opts.senderName } : {}),
    message: message.slice(0, 80),
  };
}

type InvocationClassificationMethod =
  | "local"
  | "override"
  | "orchestrator_fast"
  | "follow-up"
  | "llm"
  | "llm_context";

interface InvocationClassification {
  taskType: TaskType;
  runtimeMode: RuntimeMode;
  promptProfile: PromptProfile;
  classifyMethod: InvocationClassificationMethod;
  confidence: number;
  classifiedTier?: number;
  isOrchestrator: boolean;
}

const RUN_CONTEXT_NOTE_PATTERN = /^\[Run Context\]\nRun ID: .*\nScratchpad: .*\nUse the scratchpad for temporary notes, intermediate artifacts, and machine-readable outputs you want preserved with this run\.\n\n?/;
const ACTION_FOLLOW_UP_PATTERN = /^(do it|go ahead|continue|ship it|apply it|make it so|same(?: for .+)?|yes,? do that|yep,? do that|ok,? do that|run it|send it|commit it|push it|fix it|implement it)$/i;

export function stripRunContextNote(message: string): string {
  const stripped = message.replace(RUN_CONTEXT_NOTE_PATTERN, "").trimStart();
  return stripped.length > 0 ? stripped : message;
}

export function isActionFollowUp(message: string): boolean {
  return ACTION_FOLLOW_UP_PATTERN.test(message.trim());
}

export async function classifyInvocationTask(
  message: string,
  opts: Pick<InvokeOpts, "router" | "registry" | "agentKey" | "lastTaskType" | "conversationHistory" | "runtimeMode" | "classificationOverride" | "files"> & {
    agentRole?: AgentConfig["role"];
    companionMode?: boolean;
  },
): Promise<InvocationClassification> {
  if (!opts.router) {
    throw new Error("Router is required for task classification");
  }

  const classificationMessage = stripRunContextNote(message);
  const hasClassificationOverride = !!opts.classificationOverride;
  let taskType = opts.classificationOverride ?? opts.router.classifyLocal(classificationMessage);
  let classifyMethod: InvocationClassificationMethod = hasClassificationOverride ? "override" : "local";

  const agentRole = opts.agentRole ?? opts.registry?.getEntry(opts.agentKey ?? "")?.role;
  const isOrchestrator = agentRole === "orchestrator";
  let originalTaskType: string | undefined;
  if (!hasClassificationOverride && isOrchestrator && !opts.companionMode && taskType !== "orchestrator") {
    originalTaskType = taskType;
    logger.info(`[invoke] Orchestrator fast path: overriding ${taskType} → orchestrator`);
    taskType = "orchestrator";
    classifyMethod = "orchestrator_fast";
  }

  const HEAVYWEIGHT_TASKS = ["orchestrator", "coding", "code_review", "expert", "analysis"];
  const LIGHTWEIGHT_TYPES = ["simple_qa", "trivial", "conversation"];
  const STATUS_PATTERN = /\b(are you done|you done|done yet|finished|status|update|progress|how('?s| is) it going|where are (we|you)|what('?s| is) (the )?status|still (working|running)|eta|how (long|far)|almost done|ready yet)\b/i;
  const isStatusQuestion = STATUS_PATTERN.test(classificationMessage.trim());
  if (
    !hasClassificationOverride &&
    LIGHTWEIGHT_TYPES.includes(taskType) &&
    classificationMessage.trim().length < 80 &&
    opts.lastTaskType &&
    HEAVYWEIGHT_TASKS.includes(opts.lastTaskType) &&
    !isStatusQuestion &&
    isActionFollowUp(classificationMessage)
  ) {
    logger.info(`[invoke] Follow-up detected: "${classificationMessage.slice(0, 40)}" (${taskType}) after ${opts.lastTaskType} — carrying forward`);
    taskType = opts.lastTaskType as TaskType;
    classifyMethod = "follow-up";
  }
  if (!hasClassificationOverride && isStatusQuestion && opts.lastTaskType) {
    logger.info(`[invoke] Status question detected: "${classificationMessage.slice(0, 40)}" — not escalating from ${taskType} (previous: ${opts.lastTaskType})`);
  }

  let classifierContext: string | undefined;
  const isShortMessage = classificationMessage.trim().length < 80;
  if (isShortMessage && opts.conversationHistory?.length) {
    for (let i = opts.conversationHistory.length - 1; i >= 0; i--) {
      if (opts.conversationHistory[i].role === "assistant") {
        classifierContext = opts.conversationHistory[i].content.slice(0, 500);
        logger.info(`[invoke] Context-aware classification: injecting ${classifierContext.length} chars of assistant context for short message`);
        break;
      }
    }
  }

  let classifiedTier: number | undefined;

  // When pure orchestrator fast path overrode the task type, derive the tier from the
  // original classification so cost routing can flex. "Welcome back" → simple_qa → T1,
  // not forced to orchestrator's default T4.
  if (originalTaskType && opts.router) {
    const originalRoute = opts.router.route(originalTaskType as TaskType);
    classifiedTier = getModelTier(originalRoute.model);
    logger.info(`[invoke] Orchestrator tier from original ${originalTaskType}: T${classifiedTier}`);
  }

  const shouldKeepConversational =
    taskType === "conversation"
    && !hasExplicitActionIntent(classificationMessage)
    && !hasFileReferenceIntent(classificationMessage)
    && (isSocialConversationalTurn(classificationMessage) || classificationMessage.trim().length < 240);

  if (!hasClassificationOverride && !isOrchestrator && taskType === "conversation" && classificationMessage.trim().length > 60 && !shouldKeepConversational) {
    let llmResult: { taskType: TaskType; tier: number };
    try {
      llmResult = await opts.router.classifyWithLLM(classificationMessage, classifierContext);
    } catch (err) {
      logger.warn(`[invoke] Classification failed, defaulting to conversation: ${err}`);
      llmResult = { taskType: "conversation", tier: 2 };
    }
    if (llmResult.taskType !== "conversation") {
      logger.info(`[invoke] LLM reclassified "${classificationMessage.slice(0, 40)}…" from conversation → ${llmResult.taskType} T${llmResult.tier}`);
      taskType = llmResult.taskType;
      classifyMethod = "llm";
      classifiedTier = llmResult.tier;
    }
  }

  if (!hasClassificationOverride && !isOrchestrator && isShortMessage && classifierContext && classifyMethod === "local" && LIGHTWEIGHT_TYPES.includes(taskType)) {
    let llmResult: { taskType: TaskType; tier: number };
    try {
      llmResult = await opts.router.classifyWithLLM(classificationMessage, classifierContext);
    } catch (err) {
      logger.warn(`[invoke] Context-aware classification failed, keeping local: ${err}`);
      llmResult = { taskType, tier: 2 };
    }
    if (llmResult.taskType !== taskType) {
      logger.info(`[invoke] Context-aware LLM reclassified "${classificationMessage.slice(0, 40)}…" from ${taskType} → ${llmResult.taskType} T${llmResult.tier}`);
      taskType = llmResult.taskType;
      classifyMethod = "llm_context";
      classifiedTier = llmResult.tier;
    }
  }

  const confidence = classifyMethod === "orchestrator_fast" ? 1.0
    : classifyMethod === "override" ? 1.0
    : classifyMethod === "local" && taskType !== "conversation" ? 0.9
    : classifyMethod === "llm" ? 0.8
    : classifyMethod === "follow-up" ? 0.7
    : 0.5;

  const runtimeMode = opts.runtimeMode ?? resolveRuntimeMode({
    message: classificationMessage,
    taskType,
    hasFiles: (opts.files?.length ?? 0) > 0,
    lastRuntimeMode: opts.lastTaskType ? resolveRuntimeMode({ taskType: opts.lastTaskType }) : undefined,
  });
  const promptProfile = resolvePromptProfile(runtimeMode, taskType);

  return { taskType, runtimeMode, promptProfile, classifyMethod, confidence, classifiedTier, isOrchestrator };
}

// ── Entry point: invokeAgent with routing decision ──

/**
 * Invoke an agent.
 *
 * Dynamic routing based on message classification:
 * - Classify message → get task type (trivial, simple_qa, conversation, coding, etc.)
 * - CLI escalation tasks → Claude Code subprocess with full tool access
 * - Everything else → Client SDK with optimal provider/model from routing table
 *   e.g. simple_qa → openrouter/deepseek-v3.2, conversation → anthropic/haiku
 */
export async function invokeAgent(
  agent: AgentConfig,
  message: string,
  opts: InvokeOpts,
): Promise<InvocationResult> {
  const startTime = Date.now();
  const logLabel = formatInvocationLogLabel(agent.name, opts);

  if (shouldBypassConversationalRouting(agent)) {
    opts.onProgress?.({
      turns: 0,
      tokensIn: 0,
      tokensOut: 0,
      elapsed: 0,
      activity: "Starting full-capability runtime",
      phase: "working",
      agent: agent.name,
    });
    if (shouldUseNativeEvidenceReview(message)) {
      logger.info(`[invoke] ${logLabel} route=full_capability backend=native_evidence_review model=${agent.provider}/${agent.model}`);
      return invokeCLI(agent, message, opts, startTime, STRICT_CODEX_DIRECT_TASK_TYPE);
    }
    if (isAgentsSdkOrchestrationEnabled(opts.config)) {
      logger.info(`[invoke] ${logLabel} route=full_capability backend=agents_sdk model=${agent.provider}/${agent.model}`);
      return createOpenAIAgentsOrchestrator().run({
        agent,
        message,
        opts,
        startTime,
        taskType: STRICT_CODEX_DIRECT_TASK_TYPE,
      });
    }
    const providerRuntime = opts.config?.providers?.[agent.provider]?.runtime;
    if (agent.cli_fallback === "codex" && (providerRuntime === "codex_app_server" || providerRuntime === "cli" || opts.codexRuntime)) {
      logger.info(`[invoke] ${logLabel} route=full_capability backend=codex_configured_runtime model=${agent.provider}/${agent.model}`);
      return invokeCLI(agent, message, opts, startTime, STRICT_CODEX_DIRECT_TASK_TYPE);
    }
    logger.info(`[invoke] ${logLabel} route=full_capability backend=codex_sdk model=${agent.provider}/${agent.model}`);
    return invokeCodexSdk(agent, message, opts, startTime, STRICT_CODEX_DIRECT_TASK_TYPE);
  }

  opts.onProgress?.({
    turns: 0,
    tokensIn: 0,
    tokensOut: 0,
    elapsed: 0,
    activity: "Classifying request",
    phase: "working",
    agent: agent.name,
  });

  if (!opts.router) {
    // No router available → fall back to the agent's direct runtime.
    return invokeCLI(agent, message, opts, startTime);
  }

  const classification = await classifyInvocationTask(message, {
    ...opts,
    agentRole: agent.role,
    companionMode: agent.companion_mode,
  });
  opts.onProgress?.({
    turns: 0,
    tokensIn: 0,
    tokensOut: 0,
    elapsed: Math.round((Date.now() - startTime) / 1000),
    activity: `Classified as ${classification.isOrchestrator ? "orchestrator" : classification.taskType} (${classification.runtimeMode}/${classification.promptProfile})`,
    phase: "working",
    agent: agent.name,
  });

  // Agent configured to always use CLI
  if (agent.always_cli && agent.cli_fallback) {
    // Dual-brain mode: classify first, then pick the right brain
    if (opts.dualBrain && !opts.modelOverride) {
      const { taskType, classifyMethod, confidence, classifiedTier } = classification;
      const brainSpec = resolveBrainForTask(taskType, opts.dualBrain, classifiedTier);
      const swapped = brainSpec.provider !== agent.provider || brainSpec.model !== agent.model;
      const finalAgent: AgentConfig = swapped
        ? { ...agent, provider: brainSpec.provider, model: brainSpec.model, cli_fallback: brainSpec.cli_fallback }
        : agent;

      logger.debug(`[classify] ${JSON.stringify(buildClassificationLogPayload(message, agent.name, opts, { type: taskType, method: `dual_brain:${classifyMethod}`, confidence, model: finalAgent.model, provider: finalAgent.provider, invocation: "cli", swapped }))}`);
      logger.info(`[invoke] ${logLabel} route=dual_brain(${taskType}) backend=cli model=${finalAgent.provider}/${finalAgent.model}${swapped ? " swapped=1" : ""}`);

      try {
        return await invokeCLI(finalAgent, message, opts, startTime, taskType);
      } catch (cliErr) {
        if (shouldFailWithoutFallback(finalAgent, opts.config)) {
          logger.error(`[invoke] ${logLabel} strict_cli_failed no_fallback=1 error=${cliErr}`);
          throw cliErr;
        }
        logger.warn(`[invoke] ${logLabel} always_cli dual_brain failed error=${cliErr} attempting openrouter fallback`);
        logger.info(`[invoke] ${logLabel} always_cli_fallback source=openrouter model=google/gemini-2.5-flash`);
        try {
          return await invokeClientSDK(finalAgent, message, opts, startTime, {
            provider: "openrouter",
            model: "google/gemini-2.5-flash",
            maxTokens: 16384,
            taskType,
          });
        } catch (fbErr) {
          logger.warn(`[invoke] ${logLabel} always_cli_fallback source=openrouter failed error=${fbErr}`);
          throw cliErr;
        }
      }
    }

    const cliTaskType = classification.isOrchestrator ? "orchestrator" : classification.taskType;
    logger.debug(`[classify] ${JSON.stringify(buildClassificationLogPayload(message, agent.name, opts, { type: cliTaskType, method: `always_cli:${classification.classifyMethod}`, confidence: classification.confidence, model: agent.model, provider: agent.provider, invocation: "cli" }))}`);
    logger.info(`[invoke] ${logLabel} route=always_cli(${cliTaskType}) backend=cli model=${agent.provider}/${agent.model}`);
    try {
      return await invokeCLI(agent, message, opts, startTime, cliTaskType);
    } catch (cliErr) {
      if (shouldFailWithoutFallback(agent, opts.config)) {
        logger.error(`[invoke] ${logLabel} strict_cli_failed no_fallback=1 error=${cliErr}`);
        throw cliErr;
      }
      logger.warn(`[invoke] ${logLabel} always_cli failed error=${cliErr} attempting openrouter fallback`);
      logger.info(`[invoke] ${logLabel} always_cli_fallback source=openrouter model=google/gemini-2.5-flash`);
      try {
        return await invokeClientSDK(agent, message, opts, startTime, {
          provider: "openrouter",
          model: "google/gemini-2.5-flash",
          maxTokens: 16384,
          taskType: cliTaskType,
        });
      } catch (fbErr) {
        logger.warn(`[invoke] ${logLabel} always_cli_fallback source=openrouter failed error=${fbErr}`);
        throw cliErr;
      }
    }
  }

  const { taskType, classifyMethod, confidence, classifiedTier, isOrchestrator } = classification;

  const escalationTasks = opts.cliEscalationTasks ?? DEFAULT_CLI_ESCALATION_TASKS;

  if (agent.companion_mode && isOrchestrator && agent.provider !== "anthropic") {
    logger.debug(`[classify] ${JSON.stringify(buildClassificationLogPayload(message, agent.name, opts, { type: taskType, method: classifyMethod, confidence, model: agent.model, provider: agent.provider, invocation: "api", companion_mode: true, tool_mode: opts.toolMode ?? "auto" }))}`);
    logger.info(`[invoke] ${logLabel} route=companion(${classifyMethod}) task=${taskType} backend=native-api model=${agent.provider}/${agent.model} tools=${opts.toolMode ?? "auto"}`);
    return invokeNativeAPI(
      agent,
      message,
      opts,
      startTime,
      taskType,
      { provider: agent.provider, model: agent.model },
    );
  }

  // CLI escalation for complex tasks (only if agent has tool_use)
  // Orchestrators never get CLI — they stay on SDK and delegate via [@agent: task] tags.
  // validateOrchestratorDelegation() auto-injects if they handle work directly.
  // Provider guard: CLI spawns `claude` binary which requires Anthropic auth —
  // non-Anthropic providers route to native API loop for full agentic tool access.
  if (
    agent.capabilities?.includes("tool_use") &&
    escalationTasks.includes(taskType as TaskType) &&
    !isOrchestrator &&
    agent.provider === "anthropic"
  ) {
    logger.debug(`[classify] ${JSON.stringify(buildClassificationLogPayload(message, agent.name, opts, { type: taskType, method: classifyMethod, confidence, model: agent.model, provider: agent.provider, invocation: "cli" }))}`);
    logger.info(`[invoke] ${logLabel} route=classify(${classifyMethod}) task=${taskType} backend=cli${opts.modelOverride ? " override_ignored=1" : ""}`);
    return invokeCLI(agent, message, opts, startTime, taskType);
  }

  // Native API escalation for non-Anthropic agents that need tool access.
  // This is the non-Anthropic equivalent of CLI escalation — gives full agentic power
  // via direct API calls with local tool execution (no external CLI binary needed).
  if (
    agent.capabilities?.includes("tool_use") &&
    escalationTasks.includes(taskType as TaskType) &&
    !isOrchestrator &&
    agent.provider !== "anthropic"
  ) {
    const model = agent.model;
    logger.debug(`[classify] ${JSON.stringify(buildClassificationLogPayload(message, agent.name, opts, { type: taskType, method: classifyMethod, confidence, model, provider: agent.provider, invocation: "api" }))}`);
    logger.info(`[invoke] ${logLabel} route=classify(${classifyMethod}) task=${taskType} backend=native-api model=${agent.provider}/${model}`);
    return invokeNativeAPI(agent, message, opts, startTime, taskType);
  }

  // Dynamic routing: use tier-aware routing with soul guardrails
  const defaultRoute = opts.router.route(taskType);
  let route: import("../providers/types.js").RouteDecision;

  if (opts.modelOverride) {
    route = { provider: agent.provider as ProviderName, model: agent.model, taskType, maxTokens: defaultRoute.maxTokens, fallback: defaultRoute.fallback };
    logger.info(`[invoke] ${logLabel} route=classify(${classifyMethod}) task=${taskType} backend=sdk override=${route.provider}/${route.model}`);
  } else {
    const classification: ClassificationResult = {
      taskType,
      tier: classifiedTier ?? getModelTier(defaultRoute.model),
    };
    const guardrails = (agent.min_model || agent.max_model)
      ? { minModel: agent.min_model, maxModel: agent.max_model, preferredProvider: agent.provider as ProviderName }
      : undefined;
    route = opts.router.routeWithTier(classification, guardrails);
  }

  // Structured classification log for routing tuning
  logger.debug(`[classify] ${JSON.stringify(buildClassificationLogPayload(message, agent.name, opts, { type: taskType, method: classifyMethod, confidence, model: route.model, provider: route.provider, invocation: "sdk" }))}`);

  // When user explicitly overrode the model, don't silently fall back to a different model.
  // Either the requested model works, or we fail loudly so the user knows.
  if (opts.modelOverride) {
    try {
      return await invokeClientSDK(agent, message, opts, startTime, route);
    } catch (err) {
      logger.error(`[invoke] ${logLabel} override=${route.provider}/${route.model} failed no_fallback=1 error=${err}`);
      throw new Error(`Model override failed: ${route.provider}/${route.model} is unavailable. Use /model reset to revert.`);
    }
  }

  // Count total fallback steps for numbered logging
  const fallbackSteps: string[] = [];
  if (route.fallback) fallbackSteps.push(`${route.fallback.provider}/${route.fallback.model}`);
  if (route.provider !== agent.provider || route.model !== agent.model) fallbackSteps.push(`${agent.provider}/${agent.model}`);
  if (agent.cli_fallback) {
    fallbackSteps.push("CLI");
  }
  const totalFallbacks = fallbackSteps.length;

  try {
    return await invokeClientSDK(agent, message, opts, startTime, route);
  } catch (err) {
    logger.warn(`[invoke] ${logLabel} backend=sdk model=${route.provider}/${route.model} failed error=${err}`);
    let fallbackIdx = 0;
    const primaryRateLimited = isRateLimitError(err) ? route.provider : null;

    // Fallback 1: per-route fallback from routing table
    if (route.fallback) {
      const fb = route.fallback;
      if (primaryRateLimited && fb.provider === primaryRateLimited) {
        logger.info(`[invoke] ${logLabel} route_fallback_skipped provider=${fb.provider} reason=rate_limited`);
      } else {
        fallbackIdx++;
        logger.info(`[invoke] ${logLabel} fallback=${fallbackIdx}/${totalFallbacks} target=${fb.provider}/${fb.model} source=route`);
        try {
          return await invokeClientSDK(agent, message, opts, startTime, {
            provider: fb.provider,
            model: fb.model,
            maxTokens: route.maxTokens,
            taskType: route.taskType,
          });
        } catch (fb1Err) {
          logger.warn(`[invoke] ${logLabel} fallback=${fallbackIdx}/${totalFallbacks} target=${fb.provider}/${fb.model} failed error=${fb1Err}`);
        }
      }
    }

    // Fallback 2: agent's default provider/model
    if (route.provider !== agent.provider || route.model !== agent.model) {
      if (primaryRateLimited && agent.provider === primaryRateLimited) {
        logger.info(`[invoke] ${logLabel} agent_fallback_skipped provider=${agent.provider} reason=rate_limited`);
      } else {
        fallbackIdx++;
        logger.info(`[invoke] ${logLabel} fallback=${fallbackIdx}/${totalFallbacks} target=${agent.provider}/${agent.model} source=agent_default`);
        try {
          return await invokeClientSDK(agent, message, opts, startTime);
        } catch (fallbackErr) {
          logger.warn(`[invoke] ${logLabel} fallback=${fallbackIdx}/${totalFallbacks} target=${agent.provider}/${agent.model} failed error=${fallbackErr}`);
        }
      }
    }

    // Fallback 3: Native API for non-Anthropic agents with tool needs
    if (
      agent.capabilities?.includes("tool_use") &&
      agent.provider !== "anthropic"
    ) {
      if (primaryRateLimited && agent.provider === primaryRateLimited) {
        logger.info(`[invoke] ${logLabel} native_api_fallback_skipped provider=${agent.provider} reason=rate_limited`);
      } else {
        fallbackIdx++;
        logger.info(`[invoke] ${logLabel} fallback=${fallbackIdx}/${totalFallbacks} target=${agent.provider}/${agent.model} source=native-api`);
        try {
          return await invokeNativeAPI(agent, message, opts, startTime, taskType);
        } catch (apiErr) {
          logger.warn(`[invoke] ${logLabel} fallback=${fallbackIdx}/${totalFallbacks} source=native-api failed error=${apiErr}`);
        }
      }
    }

    // Last resort: CLI if available (Anthropic agents only)
    if (agent.cli_fallback && agent.cli_fallback === "claude") {
      if (primaryRateLimited && agent.provider === primaryRateLimited) {
        logger.info(`[invoke] ${logLabel} cli_fallback_skipped provider=${agent.provider} reason=rate_limited`);
      } else {
        fallbackIdx++;
        logger.info(`[invoke] ${logLabel} fallback=${fallbackIdx}/${totalFallbacks} source=cli_last_resort`);
        return invokeCLI(agent, message, opts, startTime, taskType);
      }
    }

    throw err;
  }
}

export async function invokeCliRuntime(
  agent: AgentConfig,
  message: string,
  opts: InvokeOpts,
  startTime: number,
  taskType?: string,
): Promise<InvocationResult> {
  return invokeCLI(agent, message, opts, startTime, taskType);
}

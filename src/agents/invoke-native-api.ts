/**
 * Native API tool-execution loop for non-Claude models (OpenAI, OpenRouter, etc.).
 * Replaces the opencode subprocess path with direct API calls + local tool execution.
 *
 * Uses the OpenAI-compatible chat completions API with function calling:
 * 1. Send prompt with tool definitions
 * 2. If response has tool_calls -> execute locally (parallel) -> send results as role:"tool"
 * 3. Repeat until no more tool calls or max turns reached
 *
 * Session continuity: conversation turns (user/assistant/tool messages) are persisted
 * per convId:agentKey and reloaded on subsequent invocations, mirroring Claude CLI's
 * --resume mechanism. The processor passes opts.sessionId; we use it to load/save state.
 */

import { logger } from "../utils/logger.js";
import type { AgentConfig, InvocationResult } from "../types.js";
import { applyAgenticModePrompt } from "./agentic-mode.js";
import { ensureWorkspace } from "./workspace.js";
import { DEFAULT_COST_RATES } from "../defaults.js";
import { executeTool, type ToolContext } from "./tools.js";
import { getSoulSystemPrompt } from "../soul/index.js";
import type { InvokeOpts } from "./invoke.js";
import { resolveAgentRuntimePaths } from "./paths.js";
import { resolveAgentSkills } from "./skill-loader.js";
import type { TaskType } from "../providers/types.js";
import { extractClaudeInputRequest, stripClaudeInputRequest } from "./output-parsers.js";
import { appendCurrentSpeakerPrompt } from "./invoke-cli.js";
import { loadNativeSession, saveNativeSession, newNativeSessionId, type SessionMessage } from "./native-session.js";
import { createMultiMcpBridge, type McpBridgeEndpoint } from "./native-mcp-client.js";
import { resolveConfiguredRemoteMcpEndpoints, resolveMcpEndpointUrl, toMcpSlug } from "../server/urls.js";
import { loadAndCompileSoul } from "../soul/runtime.js";
import { buildLocalToolDefinitions } from "./tool-permissions.js";
import { resolveMcpToolProfile, type McpToolProfileDecision } from "./mcp-tool-profiles.js";
import { buildPostToolReplyGuidance } from "./post-tool-reply-guidance.js";
import { recordProviderFileBlockers } from "../providers/file-blockers.js";

// ── API endpoint URLs ──

const API_URLS: Record<string, string> = {
  openai: "https://api.openai.com/v1/chat/completions",
  openrouter: "https://openrouter.ai/api/v1/chat/completions",
};

// ── Limits ──

const MAX_READ_TURNS = 10;
const MAX_WRITE_TURNS = 30;
const REQUEST_TIMEOUT_MS = 120_000; // 2 min per API call
const HEARTBEAT_INTERVAL_MS = 30_000;
/** Stall threshold: stop heartbeating (let watchdog fire) if no tool activity in this window. */
const ACTIVITY_STALL_MS = 20 * 60 * 1000; // 20 min, matches stall-timeout.ts default
/**
 * ForgeCode principle: after this many consecutive tool failures, stop the loop.
 * Prevents infinite retry spirals when a tool is broken or misconfigured.
 */
const MAX_CONSECUTIVE_TOOL_FAILURES = 3;

/**
 * Per-tool execution timeout. If a single tool call hangs beyond this (e.g.
 * reading a huge file, hanging bash command), it fails fast rather than
 * blocking the entire turn until the 2-minute API timeout fires.
 */
const TOOL_TIMEOUT_MS = 60_000;

/**
 * Max parallel tool executions per turn. Promise.all() with no cap can spawn
 * dozens of concurrent I/O ops if the model issues many tool calls in one turn.
 * This limits the fan-out to prevent resource exhaustion.
 */
const TOOL_CONCURRENCY_LIMIT = 5;
/**
 * ForgeCode principle: tiered reasoning budget.
 * First N message-pairs get high reasoning (planning + orientation).
 * After that, switch to low reasoning (mechanical execution).
 * Only applies to o-series models that support reasoning_effort.
 */
const REASONING_HIGH_TURNS = 10;

// ── OpenAI-compatible message types ──

interface APIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: APIToolCall[];
  tool_call_id?: string;
}

interface APIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface APITool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface APIResponse {
  id: string;
  choices: Array<{
    message: {
      role: string;
      content: string | null;
      tool_calls?: APIToolCall[];
    };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
  };
  model: string;
}

// ── Helpers ──

/**
 * ForgeCode principle: tiered reasoning effort.
 * Planning phase (turns 0-9) → "high"; execution phase (10+) → "low".
 * Only o-series models support this parameter — all others return undefined.
 */
function resolveReasoningEffort(model: string, turnIndex: number): string | undefined {
  if (!/^o[1-9]/i.test(model)) return undefined;
  return turnIndex < REASONING_HIGH_TURNS ? "high" : "low";
}

/**
 * ForgeCode principle: tool-call correction layer.
 * Before raising a JSON parse error, attempt to repair common malformations:
 * 1. Extract embedded JSON object from surrounding noise
 * 2. Replace single quotes with double quotes
 * Returns the parsed args or null if all repair attempts fail.
 */
function correctToolArgs(raw: string): Record<string, unknown> | null {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch { /* fall through to repair */ }

  // Attempt 1: extract the first {...} block from noise around it
  const braceMatch = raw.match(/\{[\s\S]*\}/);
  if (braceMatch) {
    try {
      return JSON.parse(braceMatch[0]) as Record<string, unknown>;
    } catch { /* fall through */ }
  }

  // Attempt 2: replace single quotes with double quotes
  try {
    return JSON.parse(raw.replace(/'/g, '"')) as Record<string, unknown>;
  } catch { /* fall through */ }

  return null;
}

/**
 * Streaming API call using OpenAI SSE format (stream: true).
 * Emits text deltas in real-time via onTextDelta callback.
 * Accumulates tool_call argument fragments across chunks.
 * Returns a fully assembled APIResponse on completion.
 */
async function callAPIStream(
  apiUrl: string,
  apiKey: string,
  model: string,
  messages: APIMessage[],
  tools?: APITool[],
  provider?: string,
  signal?: AbortSignal,
  temperature?: number,
  reasoningEffort?: string,
  onTextDelta?: (delta: string) => void,
): Promise<APIResponse> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
  };

  if (provider === "openrouter") {
    headers["HTTP-Referer"] = "https://nyxhive.dev";
    headers["X-Title"] = "NyxHive";
  }

  const body: Record<string, unknown> = {
    model,
    messages: messages.map((m) => {
      const msg: Record<string, unknown> = { role: m.role, content: m.content };
      if (m.tool_calls) msg.tool_calls = m.tool_calls;
      if (m.tool_call_id) msg.tool_call_id = m.tool_call_id;
      return msg;
    }),
    max_tokens: 16384,
    stream: true,
    stream_options: { include_usage: true },
    ...(temperature !== undefined ? { temperature } : {}),
    ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
  };

  if (tools?.length) {
    body.tools = tools;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const onParentAbort = () => controller.abort();
  signal?.addEventListener("abort", onParentAbort, { once: true });

  try {
    const response = await fetch(apiUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      const err = new Error(`${provider} API error ${response.status}: ${text.slice(0, 500)}`);
      (err as any).status = response.status;
      throw err;
    }

    // Parse SSE stream
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let accText = "";
    // tool_calls are streamed as incremental fragments keyed by index
    const accToolCalls = new Map<number, { id: string; name: string; arguments: string }>();
    let usage = { prompt_tokens: 0, completion_tokens: 0 };
    let finishReason = "stop";
    let responseId = "";
    let responseModel = model;

    outer: while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") break outer;

        let chunk: Record<string, unknown>;
        try {
          chunk = JSON.parse(data) as Record<string, unknown>;
        } catch {
          continue; // skip malformed SSE chunks
        }

        if (typeof chunk.id === "string") responseId = chunk.id;
        if (typeof chunk.model === "string") responseModel = chunk.model;

        // Usage arrives in the final stream chunk (stream_options.include_usage)
        if (chunk.usage && typeof chunk.usage === "object") {
          const u = chunk.usage as Record<string, number>;
          usage = {
            prompt_tokens: u.prompt_tokens ?? 0,
            completion_tokens: u.completion_tokens ?? 0,
          };
        }

        const choices = chunk.choices as Array<Record<string, unknown>> | undefined;
        const delta = choices?.[0]?.delta as Record<string, unknown> | undefined;
        if (!delta) continue;

        // Text delta
        if (typeof delta.content === "string" && delta.content) {
          accText += delta.content;
          onTextDelta?.(delta.content);
        }

        // Tool call fragments: each chunk may advance one or more call indices
        const tcDeltas = delta.tool_calls as Array<Record<string, unknown>> | undefined;
        if (tcDeltas) {
          for (const tc of tcDeltas) {
            const idx = (tc.index as number) ?? 0;
            if (!accToolCalls.has(idx)) {
              accToolCalls.set(idx, { id: "", name: "", arguments: "" });
            }
            const acc = accToolCalls.get(idx)!;
            if (typeof tc.id === "string") acc.id = tc.id;
            const fn = tc.function as Record<string, string> | undefined;
            if (fn?.name) acc.name += fn.name;
            if (fn?.arguments) acc.arguments += fn.arguments;
          }
        }

        const fr = (choices?.[0] as Record<string, unknown>)?.finish_reason;
        if (typeof fr === "string" && fr) finishReason = fr;
      }
    }

    // Assemble tool_calls from accumulated fragments
    const toolCalls: APIToolCall[] | undefined = accToolCalls.size > 0
      ? Array.from(accToolCalls.entries())
          .sort(([a], [b]) => a - b)
          .map(([, tc]) => ({
            id: tc.id,
            type: "function" as const,
            function: { name: tc.name, arguments: tc.arguments },
          }))
      : undefined;

    return {
      id: responseId,
      choices: [{
        message: {
          role: "assistant",
          content: accText || null,
          ...(toolCalls ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: finishReason,
      }],
      usage,
      model: responseModel,
    };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", onParentAbort);
  }
}

function resolveAPIEndpoint(
  provider: string,
  config?: { providers?: Record<string, { url?: string; api_key_env?: string }> },
): { apiUrl: string; apiKey: string } {
  const providerConfig = config?.providers?.[provider];

  // URL: provider config > known defaults
  const apiUrl = providerConfig?.url ?? API_URLS[provider];
  if (!apiUrl) {
    throw new Error(`No API URL for provider "${provider}". Set providers.${provider}.url in config.`);
  }

  // API key: declared env var > common conventions
  const apiKeyEnv = providerConfig?.api_key_env;
  const apiKey = apiKeyEnv ? process.env[apiKeyEnv] : undefined;
  if (!apiKey) {
    throw new Error(`No API key for provider "${provider}" (env: ${apiKeyEnv ?? "not configured"})`);
  }

  return { apiUrl, apiKey };
}

/**
 * Build tool list for this agent, applying per-agent allowlist/blocklist from TOML config.
 * Claude tool names (e.g. "Read", "Bash") are mapped to native names (e.g. "read_file", "run_command").
 * Both mapped Claude names and raw native names are checked.
 *
 * MCP tools (prefixed mcp__slug__name) are merged in after local tools and are exempt from
 * the local allowlist/blocklist — they're controlled by agent.mcp_tools instead.
 *
 * ForgeCode principle: task-contextual tool subset — restrict to read-only for review/analysis
 * task types even when the agent role normally allows write access.
 */
function buildTools(
  useTools: boolean,
  canWrite: boolean,
  agent: AgentConfig,
  taskType?: string,
  mcpTools?: APITool[],
): APITool[] | undefined {
  if (!useTools) return undefined;

  const defs = buildLocalToolDefinitions({
    useTools,
    canWrite,
    agent,
    taskType,
    includeUtilityTools: true,
  }) ?? [];

  const localTools = defs.map((t) => ({
    type: "function" as const,
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));

  // Merge MCP tools after local tools — MCP names are prefixed so no collision
  return mcpTools?.length ? [...localTools, ...mcpTools] : localTools;
}

/**
 * ForgeCode principle: progressive tool output limits.
 * As the conversation accumulates turns, reduce max tool output to prevent
 * late-session tool results from flooding the context window.
 *
 * Tiers:
 *   turns  0-9  → 8000 chars (full detail — model still orienting)
 *   turns 10-19 → 4000 chars (moderate — model is in execution phase)
 *   turns 20+   → 2000 chars (compact — model is wrapping up)
 */
function resolveProgressiveOutputLimit(turnCount: number): number {
  if (turnCount < 10) return 8000;
  if (turnCount < 20) return 4000;
  return 2000;
}

/**
 * Wrap a promise with a hard timeout.
 * On timeout, rejects with a descriptive error — the original promise is abandoned
 * (not cancelled, since Promises are not cancellable) but the outer loop can move on.
 */
function withToolTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Tool timeout: "${label}" exceeded ${TOOL_TIMEOUT_MS / 1000}s`)),
      TOOL_TIMEOUT_MS,
    );
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/**
 * Run an array of async tasks with bounded concurrency.
 * Preserves result order — equivalent to Promise.all but limited to `limit` in-flight.
 */
async function parallelWithLimit<T>(
  tasks: Array<() => Promise<T>>,
  limit: number,
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let next = 0;

  async function worker(): Promise<void> {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]();
    }
  }

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

/**
 * Task-aware temperature.
 * Returns undefined for reasoning models that don't support the parameter (o1, o3, o4-mini).
 */
function resolveTemperature(model: string, taskType?: string): number | undefined {
  // OpenAI reasoning models don't support temperature — omit the field entirely
  if (/^o[1-9](-|mini|preview|$)/i.test(model)) return undefined;
  if (taskType === "coding" || taskType === "code_review" || taskType === "analysis") return 0.1;
  if (taskType === "conversation" || taskType === "simple_qa" || taskType === "trivial") return 0.7;
  if (taskType === "orchestrator" || taskType === "expert" || taskType === "research") return 0.3;
  return 0.2;
}

function formatLogLabel(agent: AgentConfig): string {
  return agent.name;
}

// ── Main entry point ──

/**
 * Invoke an agent via direct API calls with native tool execution.
 * This is the non-Anthropic equivalent of invokeCLI() — it gives models full
 * agentic tool access (file I/O, bash, search) through direct API calls
 * instead of shelling out to a CLI binary.
 *
 * HARD REQUIREMENT: Anthropic models must NEVER be routed through this path.
 * They use the claude CLI which provides richer tool access and session management.
 */
export async function invokeNativeAPI(
  agent: AgentConfig,
  message: string,
  opts: InvokeOpts,
  startTime: number,
  taskType?: string,
  route?: { provider: string; model: string },
): Promise<InvocationResult> {
  const provider = route?.provider ?? agent.provider;
  const model = route?.model ?? agent.model;
  const logLabel = formatLogLabel(agent);
  const toolMode = opts.toolMode ?? "auto";

  // Safety: never route Anthropic models through this path
  if (/^(anthropic\/)?claude-/i.test(model) || provider === "anthropic") {
    throw new Error(`Anthropic model "${provider}/${model}" must not be routed through native API — use claude CLI`);
  }

  // Resolve API endpoint and key
  const { apiUrl, apiKey } = resolveAPIEndpoint(provider, opts.config);

  // Workspace setup
  const workDir = ensureWorkspace(
    agent, opts.baseDir, opts.config, opts.agentKey,
    opts.registry, opts.scheduler, opts.memory, opts.instanceSoulsDir,
  );
  const allowedDirs = resolveAgentRuntimePaths(opts.baseDir, agent.allowed_directories);

  // Tool access: any tool_use-capable agent can use native tools.
  // Orchestrators stay read-only locally but can still use utility + MCP tools.
  const useTools = toolMode !== "off" && !!(agent.capabilities?.includes("tool_use") && workDir);
  const canWrite = useTools && (agent.role === "lead" || agent.role === "worker" || agent.role === "coder");
  const degradedRemotes = new Map<string, string>();
  let mcpProfile: McpToolProfileDecision | undefined;

  // ── MCP tool bridge ──
  // Load MCP tools from NyxHive's MCP server and merge them into the tool list.
  // Priority: agent config mcp_tools > soul YAML mcp_tools (same resolution order as Claude CLI path).
  let mcpBridge = null;
  if (useTools) {
    let mcpTools: string[] = agent.mcp_tools ?? [];
    if (mcpTools.length === 0 && opts.agentKey) {
      try {
        const soul = loadAndCompileSoul(opts.agentKey, undefined, opts.instanceSoulsDir);
        if (soul?.capabilities.mcp_tools?.length) {
          mcpTools = soul.capabilities.mcp_tools;
        }
      } catch { /* soul compile failure is non-fatal */ }
    }
    mcpProfile = resolveMcpToolProfile({ requestedTools: mcpTools, taskType, message });
    mcpTools = mcpProfile.exposedTools;
    if (mcpProfile.droppedTools.length > 0) {
      logger.info(
        `[invoke] ${logLabel} MCP profile=${mcpProfile.profile} exposed=${mcpProfile.exposedTools.length}/${mcpProfile.requestedTools.length} ` +
        `saved≈${mcpProfile.estimatedSavedTokens}t dropped=[${mcpProfile.droppedTools.join(",")}]`,
      );
    }
    const endpoints: McpBridgeEndpoint[] = [];
    const localMcpUrl = resolveMcpEndpointUrl(opts.config);
    if (mcpTools.length > 0 && opts.config?.server?.api_key && localMcpUrl) {
      endpoints.push({
        mcpUrl: localMcpUrl,
        apiKey: opts.config.server.api_key,
        toolFilter: mcpTools,
        slug: toMcpSlug(opts.config.daemon?.name ?? "nyxhive"),
      });
    }

    if (mcpTools.length > 0) {
      for (const remote of resolveConfiguredRemoteMcpEndpoints(
        opts.config,
        [opts.agentKey ?? "", agent.name],
        { requireAgentAllowlist: true },
      )) {
        const apiKey = process.env[remote.api_key_env];
        if (!apiKey) {
          logger.warn(`[invoke] ${logLabel} remote MCP "${remote.name}" skipped: missing env ${remote.api_key_env}`);
          continue;
        }
        endpoints.push({
          mcpUrl: remote.url,
          apiKey,
          toolFilter: mcpTools,
          slug: remote.slug,
          name: remote.name,
          onRemoteDown: (info) => {
            if (degradedRemotes.has(info.slug)) return;
            degradedRemotes.set(info.slug, info.reason);
            opts.onRemoteDown?.({
              slug: info.slug,
              url: info.url,
              reason: info.reason,
              availableTools: info.availableTools,
            });
          },
        });
      }
    }

    if (endpoints.length > 0) {
      mcpBridge = await createMultiMcpBridge(endpoints).catch((err) => {
        logger.warn(`[invoke] ${logLabel} MCP bridge init failed: ${err}`);
        return null;
      });
    }
  }

  const tools = buildTools(useTools, canWrite, agent, taskType, mcpBridge?.apiTools);

  // Max turns: agent config > role-based default
  const maxTurns = agent.max_tool_turns ?? (canWrite ? MAX_WRITE_TURNS : MAX_READ_TURNS);

  // ── Session continuity ──
  // Load prior conversation turns from session file (equivalent to Claude's --resume).
  // If opts.sessionId is provided (from processor's cliSessions map), reload the session.
  // If not, generate a new session ID so we can persist this conversation for next time.
  const sessionId = opts.sessionId ?? newNativeSessionId();
  const priorSession = opts.sessionId ? loadNativeSession(workDir, opts.sessionId) : null;

  if (priorSession) {
    logger.info(`[invoke] ${logLabel} native-api resuming session ${sessionId} (${priorSession.messages.length} prior messages)`);
  }

  // ── Build messages ──

  const messages: APIMessage[] = [];

  // System prompt: prefer soul-compiled prompt, fall back to system_prompt
  let systemPrompt = opts.systemPrompt ?? agent.system_prompt ?? "";
  if (!opts.systemPrompt) {
    try {
      const soulKey = opts.agentKey?.trim() || agent.name.toLowerCase();
      const soulPrompt = getSoulSystemPrompt(soulKey, undefined, "compact", opts.instanceSoulsDir);
      if (soulPrompt) systemPrompt = soulPrompt;
    } catch {
      // Soul compile failure is non-fatal
    }
  }

  // Harness guidance — mirrors buildClaudeHarnessAppendPrompt from invoke-cli.ts
  const harnessLines = [
    "IMPORTANT: There is no interactive stdin. Do not attempt to ask questions interactively.",
    "If requirements are unclear, make a reasonable assumption and proceed unless the answer materially changes the plan or implementation.",
    "If you need user input to continue, output a JSON block at the END of your response:\n```json\n{\"input_request\":{\"question\":\"your question here\",\"options\":[{\"key\":\"option1\",\"description\":\"desc\"}]}}\n```",
    "If you output an input_request, stop immediately after the JSON block and do not continue working.",
    "Spend more reasoning on initial planning and final verification. Once the plan is clear, keep routine execution steps concise.",
    "EXPLORATION: Before listing directories, run search_code with 2-3 keywords from the task to find the most relevant files first. This is the fastest path to correct orientation (ForgeCode #1 TermBench principle).",
  ];
  const needsPlanning = taskType && taskType !== "simple_qa" && taskType !== "conversation" && taskType !== "trivial";
  if (needsPlanning) {
    harnessLines.push("For multi-step tasks: you MUST use the todo_write tool before making code changes. Break the work into steps and keep the task list updated.");
  }
  harnessLines.push("Before declaring implementation complete, you MUST run verification and include the output in your response.");
  if (!useTools) {
    harnessLines.push("You do not have tool access. Do not attempt to call tools or generate tool call syntax.");
  }
  let harnessBlock = harnessLines.join("\n\n");
  harnessBlock = appendCurrentSpeakerPrompt(harnessBlock, opts.senderName);
  systemPrompt = `${systemPrompt}\n\n${harnessBlock}`.trim();
  systemPrompt = applyAgenticModePrompt(agent, systemPrompt);

  messages.push({ role: "system", content: systemPrompt });

  // Conversation history: prefer native session (includes tool call history) over
  // opts.conversationHistory (only user/assistant turns from DB).
  if (priorSession?.messages.length) {
    for (const msg of priorSession.messages) {
      messages.push(msg as APIMessage);
    }
  } else if (opts.conversationHistory?.length) {
    for (const msg of opts.conversationHistory) {
      messages.push({ role: msg.role as "user" | "assistant", content: msg.content });
    }
  } else if (opts.conversationContext) {
    messages.push({ role: "user", content: `[Previous context]\n${opts.conversationContext}` });
    messages.push({ role: "assistant", content: "I have the context." });
  }

  // Build user message with knowledge context and skills
  let userMessage = message;
  if (degradedRemotes.size > 0) {
    const unavailable = [...degradedRemotes.entries()]
      .map(([slug, reason]) => `- ${slug}: ${reason}`)
      .join("\n");
    userMessage = `[Remote MCP availability]\nOperating without these remotes for this turn:\n${unavailable}\n\n${userMessage}`;
  }
  if (opts.knowledgeContext) {
    userMessage = `[Relevant Knowledge]\n${opts.knowledgeContext}\n\n${userMessage}`;
  }
  const resolvedSkills = resolveAgentSkills({
    agentSkills: agent.skills,
    agentKey: opts.agentKey,
    taskMessage: message,
    conversationId: opts.sessionId,
    proceduralSkills: opts.proceduralSkills,
  });
  const skillContent = resolvedSkills.content;
  if (skillContent) {
    userMessage = `${userMessage}\n\n# Available Skills\n${skillContent}`;
  }
  messages.push({ role: "user", content: userMessage });

  // ── Tool execution loop ──

  const temperature = resolveTemperature(model, taskType);
  let totalIn = 0;
  let totalOut = 0;
  let turnCount = 0;
  const toolsUsed: string[] = [];
  /** ForgeCode principle: abort the loop after N consecutive tool failures to prevent retry spirals. */
  let consecutiveToolFailures = 0;
  // Track accumulated streaming text across the final response turn for delta emission
  let streamedTextSoFar = "";

  // Activity tracking for stall detection — heartbeats only fire when there's been
  // recent tool activity. No activity = no heartbeat = watchdog fires after threshold.
  let lastActivityAt = Date.now();

  logger.info(
    `[invoke] ${logLabel} native-api start: ${provider}/${model}, ` +
    `${messages.length} msgs, tools=${tools?.length ?? 0}, maxTurns=${maxTurns}` +
    (priorSession ? ` session=${sessionId}` : ` new_session=${sessionId}`),
  );
  recordProviderFileBlockers({
    runtime: "native_api",
    provider,
    model,
    files: opts.files,
    runs: opts.runs,
    runId: opts.runId,
    messageId: opts.messageId,
    traceId: opts.traceId,
    channel: opts.channel,
  });

  // Activity-based heartbeat: only signal alive if recent tool activity
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  if (opts.onHeartbeat) {
    heartbeatTimer = setInterval(() => {
      if (Date.now() - lastActivityAt < ACTIVITY_STALL_MS) {
        opts.onHeartbeat?.();
      }
    }, HEARTBEAT_INTERVAL_MS);
  }

  try {
    for (let turn = 0; turn < maxTurns; turn++) {
      // Check for task cancellation
      if (opts.signal?.aborted) {
        throw new Error("Task cancelled");
      }

      // ForgeCode: tiered reasoning — high for planning turns, low for execution turns
      const reasoningEffort = resolveReasoningEffort(model, turn);

      // Streaming: emit text deltas in real-time via onProgress (mirrors Claude CLI path)
      streamedTextSoFar = "";
      const response = await callAPIStream(
        apiUrl, apiKey, model, messages, tools, provider, opts.signal, temperature, reasoningEffort,
        (delta) => {
          streamedTextSoFar += delta;
          opts.onProgress?.({
            turns: turnCount,
            tokensIn: totalIn,
            tokensOut: totalOut,
            elapsed: Math.round((Date.now() - startTime) / 1000),
            textDelta: delta,
            textSoFar: streamedTextSoFar,
            streamingSafe: true,
            phase: "responding",
          });
        },
      );
      totalIn += response.usage.prompt_tokens;
      totalOut += response.usage.completion_tokens;

      const choice = response.choices?.[0];
      if (!choice) {
        throw new Error(`${provider}/${model} returned no choices`);
      }

      // No tool calls -> final response
      if (!choice.message.tool_calls?.length) {
        const duration = Date.now() - startTime;
        const rates = DEFAULT_COST_RATES[model];
        const cost = rates ? (totalIn * rates.input + totalOut * rates.output) / 1_000_000 : 0;
        const rawText = choice.message.content ?? "";

        // Detect input_request JSON block (same pattern as Claude CLI path)
        const inputRequest = extractClaudeInputRequest(rawText);
        const finalResponse = inputRequest ? stripClaudeInputRequest(rawText) : rawText;

        logger.info(
          `[invoke] ${logLabel} native-api done in ${duration}ms — ` +
          `${totalIn}+${totalOut} tokens, $${cost.toFixed(4)}, ${turnCount} tool turn(s)${inputRequest ? " input_request=1" : ""}`,
        );

        opts.onProgress?.({
          turns: turnCount,
          tokensIn: totalIn,
          tokensOut: totalOut,
          elapsed: Math.round(duration / 1000),
          textSoFar: finalResponse,
          streamingSafe: true,
          phase: "responding",
        });

        // Persist session: save all turns (exclude system message) for next invocation
        const sessionMessages = messages
          .filter((m) => m.role !== "system")
          .concat([{ role: "assistant", content: finalResponse }]) as SessionMessage[];
        saveNativeSession(workDir, sessionId, opts.agentKey ?? agent.name.toLowerCase(), sessionMessages, priorSession);
        for (const draft of resolvedSkills.selectedAutoSkills) {
          opts.proceduralSkills?.recordSuccess(draft.id);
        }

        return {
          response: finalResponse,
          agent: agent.name,
          method: "api",
          task_type: taskType as TaskType,
          model: response.model,
          tokens_in: totalIn,
          tokens_out: totalOut,
          cost,
          duration_ms: duration,
          toolsUsed: toolsUsed.length ? [...new Set(toolsUsed)] : undefined,
          session_id: sessionId,
          session_runtime: "native_api",
          ...(mcpProfile ? {
            context_budget: {
              mcp_profile: mcpProfile.profile,
              mcp_requested_tools: mcpProfile.requestedTools.length,
              mcp_exposed_tools: mcpProfile.exposedTools.length,
              mcp_dropped_tools: mcpProfile.droppedTools,
              estimated_mcp_schema_tokens: mcpProfile.estimatedSchemaTokens,
              estimated_mcp_saved_tokens: mcpProfile.estimatedSavedTokens,
            },
          } : {}),
          ...(inputRequest ? { input_request: inputRequest } : {}),
        };
      }

      // Include assistant message with tool_calls in conversation history
      messages.push({
        role: "assistant",
        content: choice.message.content,
        tool_calls: choice.message.tool_calls,
      });

      // ForgeCode: planning enforcement — on the first tool turn of a planning task,
      // if todo_write was not called, inject a harness reminder before continuing.
      if (turn === 0 && needsPlanning) {
        const calledTodoWrite = choice.message.tool_calls.some((tc) => tc.function.name === "todo_write");
        if (!calledTodoWrite) {
          logger.warn(`[invoke] ${logLabel} planning_violation: turn 0 had no todo_write — injecting reminder`);
          // Inject as a tool result for a synthetic todo_write call so the conversation stays valid,
          // then add a user reminder. The model will see the planning requirement before its next turn.
          messages.push({
            role: "user",
            content: "[harness] Planning step required: use todo_write to create your task list before making changes.",
          });
        }
      }

      // Execute tool calls in parallel with concurrency cap and per-tool timeout.
      // TOOL_CONCURRENCY_LIMIT prevents fan-out storms when the model issues many calls.
      // withToolTimeout prevents a hung tool from blocking the entire turn.
      const toolCallTasks = choice.message.tool_calls.map((tc) => async () => {
        const toolName = tc.function.name;

        // ForgeCode: tool-call correction layer — attempt to repair malformed JSON
        // before failing with an error. Handles truncated args, single quotes, noise.
        const args: Record<string, unknown> | null = correctToolArgs(tc.function.arguments);
        if (!args) {
          logger.warn(`[invoke] ${logLabel} irreparable tool args for ${toolName}: ${tc.function.arguments.slice(0, 200)}`);
          return { id: tc.id, name: toolName, content: "Error: malformed tool arguments (could not repair JSON)", isError: true };
        }

        // Route MCP tools (prefixed mcp__slug__name) to the MCP bridge
        if (mcpBridge && toolName.startsWith("mcp__")) {
          const result = await withToolTimeout(mcpBridge.callTool(toolName, args), toolName);
          return { id: tc.id, name: toolName, content: result, isError: result.startsWith("Error:") };
        }

        const toolCtx: ToolContext = {
          workDir,
          allowedDirectories: allowedDirs,
          knowledge: opts.knowledge,
          compiledKnowledge: opts.compiledKnowledge,
          embedder: opts.embedder,
          writable: !!canWrite,
          onFileChange: opts.onFileChange,
          maxOutputChars: resolveProgressiveOutputLimit(turnCount),
        };

        try {
          const result = await withToolTimeout(executeTool({ name: toolName, arguments: args }, toolCtx), toolName);
          return { id: tc.id, name: toolName, content: result, isError: result.startsWith("Error:") };
        } catch (err) {
          const msg = `Error: ${err instanceof Error ? err.message : String(err)}`;
          return { id: tc.id, name: toolName, content: msg, isError: true };
        }
      });

      const toolCallResults = await parallelWithLimit(toolCallTasks, TOOL_CONCURRENCY_LIMIT);

      // ForgeCode failure tracking: count consecutive turns where all tools failed.
      // If every call in this turn returned an error, increment the failure counter.
      const allFailed = toolCallResults.every((r) => r.isError);
      if (allFailed) {
        consecutiveToolFailures++;
        logger.warn(`[invoke] ${logLabel} all tools failed this turn (${consecutiveToolFailures}/${MAX_CONSECUTIVE_TOOL_FAILURES})`);
        if (consecutiveToolFailures >= MAX_CONSECUTIVE_TOOL_FAILURES) {
          logger.warn(`[invoke] ${logLabel} aborting after ${MAX_CONSECUTIVE_TOOL_FAILURES} consecutive all-fail turns`);
          // Push the failed tool results so the model has context, then break
          for (const r of toolCallResults) {
            messages.push({ role: "tool", tool_call_id: r.id, content: r.content });
          }
          break;
        }
      } else {
        consecutiveToolFailures = 0;
      }

      // Record activity and update turn counters after all parallel calls complete
      lastActivityAt = Date.now();
      turnCount += toolCallResults.length;
      for (const r of toolCallResults) {
        toolsUsed.push(r.name);
      }

      const elapsed = Math.round((Date.now() - startTime) / 1000);
      const toolSummary = toolCallResults.map((r) => r.name).join(", ");
      logger.info(`[invoke] ${logLabel} native-api turn=${turnCount} elapsed=${elapsed}s tools=[${toolSummary}]`);

      opts.onProgress?.({
        turns: turnCount,
        tokensIn: totalIn,
        tokensOut: totalOut,
        elapsed,
        activity: `Tools: ${toolSummary}`,
        phase: "working",
      });

      // Push tool results back into message history
      for (const r of toolCallResults) {
        messages.push({
          role: "tool",
          tool_call_id: r.id,
          content: r.content,
        });
      }
      messages.push({
        role: "user",
        content: buildPostToolReplyGuidance({ runtimeMode: opts.runtimeMode, taskType }),
      });
    }

    // Hit max turns — return whatever we have
    logger.warn(`[invoke] ${logLabel} native-api hit max turns (${maxTurns})`);
    const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
    const duration = Date.now() - startTime;
    const rates = DEFAULT_COST_RATES[model];
    const cost = rates ? (totalIn * rates.input + totalOut * rates.output) / 1_000_000 : 0;

    // Still persist what we have
    const sessionMessages = messages.filter((m) => m.role !== "system") as SessionMessage[];
    saveNativeSession(workDir, sessionId, opts.agentKey ?? agent.name.toLowerCase(), sessionMessages, priorSession);

    return {
      response: lastAssistant?.content ?? "(max tool turns reached)",
      agent: agent.name,
      method: "api",
      task_type: taskType as TaskType,
      model,
      tokens_in: totalIn,
      tokens_out: totalOut,
      cost,
      duration_ms: duration,
      toolsUsed: toolsUsed.length ? [...new Set(toolsUsed)] : undefined,
      hitMaxTurns: true,
      session_id: sessionId,
      session_runtime: "native_api",
      ...(mcpProfile ? {
        context_budget: {
          mcp_profile: mcpProfile.profile,
          mcp_requested_tools: mcpProfile.requestedTools.length,
          mcp_exposed_tools: mcpProfile.exposedTools.length,
          mcp_dropped_tools: mcpProfile.droppedTools,
          estimated_mcp_schema_tokens: mcpProfile.estimatedSchemaTokens,
          estimated_mcp_saved_tokens: mcpProfile.estimatedSavedTokens,
        },
      } : {}),
    };
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    if (mcpBridge) await mcpBridge.close().catch(() => {});
  }
}

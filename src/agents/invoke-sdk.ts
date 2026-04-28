import { logger } from "../utils/logger.js";
import type { AgentConfig, InvocationResult } from "../types.js";
import { ensureWorkspace } from "./workspace.js";
import { DEFAULT_COST_RATES, getEffortForAgent } from "../defaults.js";
import type { TaskType } from "../providers/types.js";
import { executeTool, type ToolContext } from "./tools.js";
import { getSoulSystemPrompt } from "../soul/index.js";
import type { InvokeOpts } from "./invoke.js";
import { resolveAgentRuntimePaths } from "./paths.js";
import { buildLocalToolDefinitions } from "./tool-permissions.js";
import { applyAgenticModePrompt } from "./agentic-mode.js";
import { buildPostToolReplyGuidance } from "./post-tool-reply-guidance.js";
import { recordProviderFileBlockers } from "../providers/file-blockers.js";

const MAX_SDK_READ_TURNS = 5;
const MAX_SDK_WRITE_TURNS = 15;

export async function invokeClientSDK(
  agent: AgentConfig,
  message: string,
  opts: InvokeOpts,
  startTime: number,
  route?: { provider: string; model: string; maxTokens: number; taskType: TaskType; fallback?: { provider: string; model: string } },
): Promise<InvocationResult> {
  const router = opts.router!;

  // Use route from routing table if provided, otherwise fall back to agent defaults
  const providerName = (route?.provider ?? agent.provider) as "anthropic" | "openrouter";
  const model = route?.model ?? agent.model;
  const maxTokens = route?.maxTokens ?? 4096;
  const workDir = agent.working_directory ? ensureWorkspace(agent, opts.baseDir, opts.config, opts.agentKey, opts.registry, opts.scheduler, opts.memory, opts.instanceSoulsDir) : null;
  const allowedDirectories = resolveAgentRuntimePaths(opts.baseDir, agent.allowed_directories);

  // Only provide tools if agent has tool_use capability AND has a workspace.
  // Pure orchestrators NEVER get tools — they must produce text (delegation tags) only.
  // Lead agents get full tool access (they implement directly + delegate).
  const isReadOnlyRole = agent.role === "orchestrator";
  const useTools = agent.capabilities?.includes("tool_use") && workDir && !isReadOnlyRole;
  // Lead and worker agents with tool_use get write tools; read-only roles don't.
  const canWrite = useTools && (agent.role === "lead" || agent.role === "worker");
  const tools = buildLocalToolDefinitions({
    useTools: !!useTools,
    canWrite: !!canWrite,
    agent,
    taskType: route?.taskType,
    includeUtilityTools: false,
  });

  // Build messages with conversation history
  const messages: Array<{ role: "user" | "assistant"; content: string }> = [];
  if (opts.conversationHistory && opts.conversationHistory.length > 0) {
    for (const msg of opts.conversationHistory) {
      messages.push({ role: msg.role, content: msg.content });
    }
  } else if (opts.conversationContext) {
    messages.push({ role: "user", content: `[Previous context]\n${opts.conversationContext}` });
    messages.push({ role: "assistant", content: "I have the context." });
  }
  messages.push({ role: "user", content: message });

  // Prefer soul-compiled prompt if a soul file exists; fall back to system_prompt
  let systemPrompt = opts.systemPrompt ?? agent.system_prompt;
  if (!opts.systemPrompt) {
    try {
      const soulKey = opts.agentKey?.trim() || agent.name.toLowerCase();
      const soulPrompt = getSoulSystemPrompt(soulKey, undefined, "compact", opts.instanceSoulsDir);
      if (soulPrompt) systemPrompt = soulPrompt;
    } catch {
      // Soul compile failure is non-fatal — fall back to system_prompt
    }
  }
  if (!useTools) {
    systemPrompt += "\n\nYou do not have tool access. Do not attempt to call tools or generate tool call syntax.";
  }
  systemPrompt = applyAgenticModePrompt(agent, systemPrompt ?? "");

  // Resolve effort level: agent config > role-based default
  const effort = getEffortForAgent(agent.effort, agent.role);

  let totalTokensIn = 0;
  let totalTokensOut = 0;

  logger.info(`[invoke] SDK request start: ${agent.name} via ${providerName}/${model}, ${messages.length} messages${useTools ? " (tools enabled)" : ""}${effort ? `, effort=${effort}` : ""}`);

  // Tool loop — max turns to prevent runaway
  const maxTurns = canWrite ? MAX_SDK_WRITE_TURNS : MAX_SDK_READ_TURNS;
  let recordedProviderFileBlockers = false;
  for (let turn = 0; turn < maxTurns; turn++) {
    const response = await router.complete(
      {
        messages: messages.map((m) => ({ ...m, role: m.role as "system" | "user" | "assistant" })),
        model,
        maxTokens,
        system: systemPrompt,
        tools,
        files: turn === 0 ? opts.files : undefined,
        effort,
      },
      providerName,
      model,
      route?.fallback as { provider: import("../providers/types.js").ProviderName; model: string } | undefined,
    );
    if (!recordedProviderFileBlockers && turn === 0) {
      recordProviderFileBlockers({
        runtime: "sdk",
        provider: response.provider,
        model: response.model,
        files: opts.files,
        runs: opts.runs,
        runId: opts.runId,
        messageId: opts.messageId,
        traceId: opts.traceId,
        channel: opts.channel,
      });
      recordedProviderFileBlockers = true;
    }

    totalTokensIn += response.tokensIn;
    totalTokensOut += response.tokensOut;

    // No tool calls — we have the final response
    if (!response.toolCalls || response.toolCalls.length === 0) {
      const duration = Date.now() - startTime;
      const rates = DEFAULT_COST_RATES[response.model] ?? DEFAULT_COST_RATES[model];
      const cost = rates ? (totalTokensIn * rates.input + totalTokensOut * rates.output) / 1_000_000 : 0;

      logger.info(
        `[invoke] ${agent.name} SDK completed in ${duration}ms — ${totalTokensIn}+${totalTokensOut} tokens, $${cost.toFixed(4)}, ${turn + 1} turn(s)`,
      );

      return {
        response: response.content,
        agent: agent.name,
        method: "sdk",
        task_type: route?.taskType,
        model: response.model,
        tokens_in: totalTokensIn,
        tokens_out: totalTokensOut,
        cost,
        duration_ms: duration,
      };
    }

    // Execute tool calls and feed results back
    messages.push({ role: "assistant", content: response.content });

    for (const toolCall of response.toolCalls) {
      const toolCtx: ToolContext = {
        workDir: workDir!,
        allowedDirectories,
        knowledge: opts.knowledge,
        embedder: opts.embedder,
        writable: !!canWrite,
        onFileChange: opts.onFileChange,
      };
      const result = await executeTool(toolCall, toolCtx);
      logger.info(`[invoke] ${agent.name} SDK tool: ${toolCall.name}(${JSON.stringify(toolCall.arguments).slice(0, 80)})`);
      messages.push({
        role: "user",
        content: `[Tool result for ${toolCall.name}]:\n${result}`,
      });
    }

    messages.push({
      role: "user",
      content: buildPostToolReplyGuidance({ runtimeMode: opts.runtimeMode, taskType: route?.taskType }),
    });
  }

  // Hit max turns — return what we have
  logger.warn(`[invoke] ${agent.name} SDK hit max tool turns (${maxTurns})`);
  const lastAssistant = messages.filter((m) => m.role === "assistant").pop();
  const duration = Date.now() - startTime;
  const rates = DEFAULT_COST_RATES[model];
  const cost = rates ? (totalTokensIn * rates.input + totalTokensOut * rates.output) / 1_000_000 : 0;

  return {
    response: lastAssistant?.content ?? "(max tool turns reached)",
    agent: agent.name,
    method: "sdk",
    task_type: route?.taskType,
    model,
    tokens_in: totalTokensIn,
    tokens_out: totalTokensOut,
    cost,
    duration_ms: duration,
  };
}

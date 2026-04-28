/**
 * Delegation synthesis logic: response composition, synthesis prompt building,
 * orchestrator re-entry invocation. Extracted from DelegationEngine for module size management.
 */
import { logger } from "../utils/logger.js";
import { invokeAgent, type CLIProgress } from "../agents/invoke.js";
import type { InvocationResult } from "../types.js";
import { AGENT_TIMEOUT_MS, getBillingType } from "../defaults.js";
import { formatError } from "../utils/error.js";
import type { DelegationContext } from "./delegation.js";

/**
 * Assemble the final composed response from delegation results (mechanical concatenation).
 */
export function composeDelegationResponse(
  cleanedResponse: string,
  actionResults: string[],
  subtaskResults: Array<{ agent: string; agentKey: string; response: string }>,
  unknownErrors: string,
  ctx: DelegationContext,
  originMessageId?: string,
  agentKey?: string,
  channel?: string,
): string {
  // Emit synthesis_start event
  if (originMessageId && subtaskResults.length > 0) {
    ctx.emit("synthesis_start", {
      message_id: originMessageId,
      channel: channel ?? "",
      agent: agentKey ?? "",
      agent_count: subtaskResults.length,
    });
  }

  const formattedResults = subtaskResults.map(r => `**${r.agent}** (@${r.agentKey}):\n${r.response}`);
  if (originMessageId && subtaskResults.length > 0) {
    ctx.emit("delegation_result", {
      message_id: originMessageId,
      channel: channel ?? "",
      agent: agentKey ?? "",
      results: subtaskResults,
    });
  }

  const parts = [cleanedResponse];
  if (actionResults.length > 0) {
    parts.push(actionResults.join("\n"));
  }
  if (formattedResults.length > 0) {
    const hasLeadSynthesis = cleanedResponse.trim().length > 0;
    if (hasLeadSynthesis) {
      const specialistSummary = subtaskResults
        .map((result) => `${result.agent} (@${result.agentKey})`)
        .join(", ");
      parts.push(`Specialist support: ${specialistSummary}.`);
    } else {
      parts.push(`---\n${formattedResults.join("\n\n")}`);
    }
  }
  if (unknownErrors) parts.push(unknownErrors);
  const composedResponse = parts.filter(Boolean).join("\n\n");

  // Emit final composed response so SSE clients replace streamed delegation fragments
  if (formattedResults.length > 0 && originMessageId) {
    ctx.emit("response:delta", {
      message_id: originMessageId,
      text_delta: "",
      text_so_far: composedResponse,
      agent: agentKey,
      channel,
      replace: true,
    });
  }

  return composedResponse;
}

/**
 * Build the synthesis prompt for orchestrator re-entry.
 * Formats delegation results into a structured message for the orchestrator to review.
 */
export function buildSynthesisPrompt(
  subtaskResults: Array<{ agent: string; agentKey: string; response: string }>,
  originalUserMessage?: string,
): string {
  const RESULT_CAP = 4000;
  const resultBlocks = subtaskResults.map(r => {
    const capped = r.response.length > RESULT_CAP ? `${r.response.slice(0, RESULT_CAP)}\n[...truncated]` : r.response;
    return `**${r.agent}** (@${r.agentKey}):\n${capped}`;
  });

  const parts = [
    "[Delegation Results]",
    "The following agents completed their tasks:\n",
    resultBlocks.join("\n\n"),
  ];

  if (originalUserMessage) {
    const cappedOriginal = originalUserMessage.length > 500
      ? `${originalUserMessage.slice(0, 500)}...`
      : originalUserMessage;
    parts.push(
      "\n[Original Request]",
      cappedOriginal,
    );
  }

  parts.push(
    "\n[Instructions]",
    "Review these results and respond to the ORIGINAL REQUEST. You may:",
    "- Delegate further tasks to other agents based on what you learned",
    "- Synthesize the results into a final response that addresses the original request",
    "- Do both — delegate follow-up work AND provide commentary",
    "Your response must directly address what was asked in the original request.",
  );

  return parts.join("\n");
}

/**
 * Invoke the orchestrator again for a re-entry turn.
 * Uses the same agent config and model, passes the synthesis prompt as the message.
 * Does NOT persist the synthesis prompt to conversation history.
 */
export async function invokeForReentry(
  originalResult: InvocationResult,
  synthesisPrompt: string,
  convId: string,
  channel: string,
  senderId: string,
  traceId: string | null,
  parentEventId: number | null,
  ctx: DelegationContext,
  onProgress?: (info: CLIProgress) => void,
): Promise<InvocationResult> {
  // primaryResult.agent is display name ("Nyx"), registry/config keys are lowercase ("nyx")
  const agentKey = originalResult.agent.toLowerCase();
  const agentConfig = ctx.getAgent(agentKey);
  if (!agentConfig) {
    logger.error(`[processor] Re-entry failed: agent config not found for "${agentKey}"`);
    return { response: synthesisPrompt, agent: originalResult.agent, method: "sdk", duration_ms: 0 };
  }

  const synthMode = agentConfig.always_cli ? "cli" as const : "sdk" as const;
  const systemPromptResult = ctx.buildSystemPrompt(agentKey, agentConfig.system_prompt, null, channel, undefined, synthMode);
  ctx.config.memory?.saveContextTrace(convId, agentKey, systemPromptResult.trace);
  const { messages: conversationHistory } = ctx.getConversationHistory(convId, agentConfig.model, systemPromptResult.prompt.length, agentKey);

  // Start trace event for re-entry
  let eventId: number | null = null;
  if (ctx.config.traces && traceId) {
    eventId = ctx.config.traces.startEvent(traceId, agentKey, "[re-entry synthesis]", parentEventId ?? undefined);
  }

  try {
    // Re-entry goes through normal routing. The orchestrator check in invokeAgent()
    // ensures it stays on SDK. This gives proper model selection and token limits.
    const result = await Promise.race([
      invokeAgent(agentConfig, synthesisPrompt, {
        baseDir: ctx.config.baseDir,
        channel,
        systemPrompt: systemPromptResult.prompt,
        conversationHistory,
        config: ctx.config.nyxhiveConfig,
        agentKey,
        senderName: senderId,
        sandbox: ctx.config.sandbox,
        registry: ctx.config.registry,
        scheduler: ctx._scheduler,
        memory: ctx.config.memory,
        knowledge: ctx.config.knowledge,
        embedder: ctx.config.embedder,
        onProgress,
        vault: ctx.config.vault,
        router: ctx.config.router,
        cliEscalationTasks: ctx.config.cliEscalationTasks,
      }),
      new Promise<never>((_, reject) => {
        const t = agentConfig.timeout_ms ?? AGENT_TIMEOUT_MS;
        setTimeout(() => reject(new Error(`Orchestrator re-entry timed out after ${Math.round(t / 1000)}s`)), t);
      }),
    ]);

    // Complete trace event with model routing data
    if (ctx.config.traces && eventId) {
      ctx.config.traces.completeEvent(eventId, {
        responseExcerpt: result.response.slice(0, 500),
        tokensIn: result.tokens_in,
        tokensOut: result.tokens_out,
        cost: result.cost,
        durationMs: result.duration_ms,
        model: result.model ?? agentConfig.model,
        taskType: result.task_type ?? "orchestrator",
        billingType: getBillingType(result.method, result.model ?? agentConfig.model),
      });
    }

    return result;
  } catch (err) {
    const errorMsg = formatError(err);
    logger.error(`[processor] Orchestrator re-entry failed: ${errorMsg}`);
    if (ctx.config.traces && eventId) {
      ctx.config.traces.failEvent(eventId, errorMsg);
    }
    // On re-entry failure, return an error message as if the orchestrator responded
    return { response: `[Re-entry synthesis failed: ${errorMsg}]`, agent: originalResult.agent, method: "sdk", duration_ms: 0 };
  }
}

import { logger } from "../utils/logger.js";
import type { AgentConfig, InputRequest, InvocationResult } from "../types.js";
import { DEFAULT_COST_RATES } from "../defaults.js";

export interface CLIParseResult extends InvocationResult {
  exitedPlanMode?: boolean;
  planText?: string;
  hitMaxTurns?: boolean;
}

export interface OpenCodeEvent {
  type: string;
  part?: {
    type?: string;
    text?: string;
    toolInvocation?: {
      state: "call" | "result";
      toolName?: string;
      args?: Record<string, unknown>;
      result?: unknown;
    };
  };
  error?: { message?: string; code?: string };
  usage?: { promptTokens?: number; completionTokens?: number };
}

export interface CodexExecEvent {
  type: string;
  thread_id?: string;
  item?: {
    id?: string;
    type?: string;
    text?: string;
    command?: string;
    aggregated_output?: string;
    exit_code?: number | null;
    status?: string;
  };
  usage?: {
    input_tokens?: number;
    cached_input_tokens?: number;
    output_tokens?: number;
  };
  error?: {
    message?: string;
  };
}

export class CodexNoAssistantResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexNoAssistantResponseError";
  }
}

const CLAUDE_INPUT_REQUEST_BLOCK_RE = /```json\s*\n?\s*(\{[\s\S]*?"input_request"[\s\S]*?\})\s*\n?\s*```\s*$/i;

export function extractClaudeInputRequest(text: string): InputRequest | undefined {
  const match = text.match(CLAUDE_INPUT_REQUEST_BLOCK_RE);
  if (!match) return undefined;

  try {
    const parsed = JSON.parse(match[1]) as {
      input_request?: {
        question?: string | null;
        options?: Array<{ key?: string | null; description?: string | null }> | null;
        timeout_ms?: number | null;
        context_hint?: string | null;
      } | null;
    };
    const raw = parsed.input_request;
    const question = typeof raw?.question === "string" ? raw.question.trim() : "";
    if (!question) return undefined;
    const rawOptions = raw?.options;
    const options = Array.isArray(rawOptions)
      ? rawOptions.reduce<Array<{ key: string; description?: string }>>((acc, option) => {
          const key = typeof option?.key === "string" ? option.key.trim() : "";
          const description = typeof option?.description === "string" ? option.description.trim() : undefined;
          if (key) acc.push({ key, description: description || undefined });
          return acc;
        }, [])
      : undefined;

    return {
      question,
      options: options && options.length > 0 ? options : undefined,
      timeout_ms: typeof raw?.timeout_ms === "number" && Number.isFinite(raw.timeout_ms) && raw.timeout_ms > 0
        ? raw.timeout_ms
        : undefined,
      context_hint: typeof raw?.context_hint === "string" && raw.context_hint.trim()
        ? raw.context_hint.trim()
        : undefined,
    };
  } catch {
    return undefined;
  }
}

export function stripClaudeInputRequest(text: string): string {
  return text.replace(CLAUDE_INPUT_REQUEST_BLOCK_RE, "").trim();
}

/**
 * Parse NDJSON output from claude CLI (stream-json or json format).
 * streamCLIOutput() filters down to just assistant + result lines.
 * Extracts the result message, accumulates token usage from assistant messages.
 */
export function parseClaudeJsonOutput(
  agent: AgentConfig,
  output: string,
  duration: number,
  logLabel = `[agent=${agent.name}]`,
): CLIParseResult {
  const lines = output.split("\n").filter(Boolean);

  let resultMsg: Record<string, any> | null = null;
  let tokensIn = 0;
  let tokensOut = 0;
  let lastTurnTokensIn = 0;
  let exitedPlanMode = false;
  let inPlanMode = false;
  const planTextParts: string[] = [];
  const allTextParts: string[] = [];
  const toolsUsed = new Set<string>();
  let sessionId: string | undefined;

  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);

      // Accumulate tokens from assistant messages
      if (parsed.type === "assistant" && parsed.message?.usage) {
        const u = parsed.message.usage;
        const turnIn = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
        tokensIn += turnIn;
        tokensOut += u.output_tokens ?? 0;
        // Cached prompt reuse is a billing/perf signal, not a stable UI proxy for active context occupancy.
        lastTurnTokensIn = u.input_tokens ?? 0;
      }

      // Detect plan mode tools and collect text content
      if (parsed.type === "assistant" && parsed.message?.content) {
        for (const block of parsed.message.content) {
          if (block.type === "tool_use") {
            if (block.name) toolsUsed.add(block.name);
            if (block.name === "EnterPlanMode") inPlanMode = true;
            if (block.name === "ExitPlanMode") { exitedPlanMode = true; inPlanMode = false; }
          }
          if (block.type === "text" && block.text) {
            allTextParts.push(block.text);
            if (inPlanMode) {
              planTextParts.push(block.text);
            }
          }
        }
      }

      if (parsed.type === "result") {
        resultMsg = parsed;
        if (parsed.session_id) sessionId = parsed.session_id;
      }
    } catch {
      // Skip non-JSON lines
    }
  }

  if (!resultMsg) {
    logger.warn(`[invoke] ${agent.name} CLI output had no result message, using extracted text`);
    // Use text extracted from assistant content blocks, not raw NDJSON
    const fallbackText = allTextParts.join("\n\n").trim();
    return {
      response: fallbackText || "[No response text captured]",
      agent: agent.name,
      method: "cli",
      tokens_in: tokensIn || undefined,
      tokens_out: tokensOut || undefined,
      duration_ms: duration,
      toolsUsed: toolsUsed.size > 0 ? [...toolsUsed] : undefined,
      session_id: sessionId,
      session_runtime: sessionId ? "claude_cli" : undefined,
      last_turn_tokens_in: lastTurnTokensIn || undefined,
    };
  }

  const cost = resultMsg.total_cost_usd ?? resultMsg.cost_usd ?? 0;
  const numTurns = resultMsg.num_turns ?? 1;
  let response: string;
  if (resultMsg.is_error) {
    response = `[CLI error: ${resultMsg.subtype}] ${resultMsg.result ?? "unknown error"}`;
  } else if (resultMsg.result) {
    response = resultMsg.result;
    // If the result is very short but the agent produced more text across turns,
    // the result field may only contain the final text block — append earlier text
    // to avoid losing the full response (e.g. subagent does tool work then stops).
    if (response.length < 200 && allTextParts.length > 1 && numTurns > 1) {
      const fullText = allTextParts.join("\n\n").trim();
      if (fullText.length > response.length) {
        response = fullText;
      }
    }
  } else {
    response = exitedPlanMode ? "Plan ready for review" : "Task completed";
  }

  // Fallback: if no tokens from assistant messages, check result-level usage
  if (tokensIn === 0 && resultMsg.usage) {
    const u = resultMsg.usage;
    tokensIn = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    tokensOut = u.output_tokens ?? 0;
    lastTurnTokensIn = u.input_tokens ?? 0;
  }

  // Detect if the CLI hit the max-turns cap (only when explicitly configured)
  const maxTurns = agent.max_tool_turns;
  const hitMaxTurns = maxTurns ? numTurns >= maxTurns : false;

  logger.info(
    `[invoke] ${logLabel} backend=claude completed duration=${duration}ms tokens=${tokensIn}+${tokensOut} nominal_cost=$${cost.toFixed(4)} turns=${numTurns}${hitMaxTurns ? ` hit_cap=${maxTurns}` : ""}`,
  );

  if (hitMaxTurns) {
    logger.warn(`[invoke] ${logLabel} backend=claude max_turns=${numTurns}/${maxTurns} continuation=possible`);
  }

  if (resultMsg.is_error) {
    logger.warn(`[invoke] ${logLabel} backend=claude result_error=${resultMsg.subtype}`);
  }

  // Collect plan text: prefer text from within plan mode, fall back to all assistant text
  const planText = exitedPlanMode
    ? (planTextParts.length > 0 ? planTextParts.join("\n\n") : allTextParts.join("\n\n")) || undefined
    : undefined;
  const inputRequest = extractClaudeInputRequest(response);
  const cleanedResponse = inputRequest ? stripClaudeInputRequest(response) : response;

  return {
    response: cleanedResponse,
    agent: agent.name,
    method: "cli",
    model: agent.model,
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    cost,
    duration_ms: duration,
    exitedPlanMode: exitedPlanMode || undefined,
    planText,
    toolsUsed: toolsUsed.size > 0 ? [...toolsUsed] : undefined,
    hitMaxTurns: hitMaxTurns || undefined,
    input_request: inputRequest,
    session_id: sessionId,
    session_runtime: sessionId ? "claude_cli" : undefined,
    last_turn_tokens_in: lastTurnTokensIn || undefined,
  };
}

/**
 * Parse NDJSON output from OpenCode CLI.
 * Extracts the final response text, token counts, and tool usage.
 */
export function parseOpenCodeOutput(
  agent: AgentConfig,
  output: string,
  duration: number,
  logLabel = `[agent=${agent.name}]`,
): InvocationResult {
  const lines = output.split("\n").filter(Boolean);

  let tokensIn = 0;
  let tokensOut = 0;
  const textParts: string[] = [];
  const toolsUsed = new Set<string>();
  let hasError = false;
  let errorMessage = "";

  for (const line of lines) {
    try {
      const parsed: OpenCodeEvent = JSON.parse(line);

      if (parsed.type === "text" && parsed.part?.text) {
        textParts.push(parsed.part.text);
      }

      else if (parsed.type === "tool_use" && parsed.part?.toolInvocation) {
        const inv = parsed.part.toolInvocation;
        if (inv.toolName) toolsUsed.add(inv.toolName);
      }

      else if (parsed.type === "step_finish" && parsed.usage) {
        tokensIn += parsed.usage.promptTokens ?? 0;
        tokensOut += parsed.usage.completionTokens ?? 0;
      }

      else if (parsed.type === "error") {
        hasError = true;
        errorMessage = parsed.error?.message ?? "unknown error";
      }
    } catch {
      // Skip non-JSON lines
    }
  }

  const response = textParts.join("").trim();

  // Calculate cost from token counts
  const model = agent.model;
  const rates = DEFAULT_COST_RATES[model];
  const cost = rates ? (tokensIn * rates.input + tokensOut * rates.output) / 1_000_000 : 0;

  logger.info(
    `[invoke] ${logLabel} backend=opencode completed duration=${duration}ms tokens=${tokensIn}+${tokensOut} cost=$${cost.toFixed(4)}`,
  );

  if (hasError) {
    logger.warn(`[invoke] ${logLabel} backend=opencode error_events=${errorMessage}`);
  }

  return {
    response: response || (hasError ? `[OpenCode error] ${errorMessage}` : "Task completed"),
    agent: agent.name,
    method: "api",
    task_type: undefined,
    model,
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    cost,
    duration_ms: duration,
    toolsUsed: toolsUsed.size > 0 ? [...toolsUsed] : undefined,
  };
}

export function parseCodexJsonOutput(
  agent: AgentConfig,
  output: string,
  duration: number,
  logLabel = `[agent=${agent.name}]`,
): InvocationResult {
  const lines = output.split("\n").filter(Boolean);

  let tokensIn = 0;
  let tokensOut = 0;
  let turnCount = 0;
  const textParts: string[] = [];
  const toolsUsed = new Set<string>();
  let hasError = false;
  let errorMessage = "";

  for (const line of lines) {
    try {
      const parsed: CodexExecEvent = JSON.parse(line);

      if (parsed.type === "turn.completed" && parsed.usage) {
        turnCount++;
        tokensIn += (parsed.usage.input_tokens ?? 0) + (parsed.usage.cached_input_tokens ?? 0);
        tokensOut += parsed.usage.output_tokens ?? 0;
        continue;
      }

      if ((parsed.type === "item.started" || parsed.type === "item.updated" || parsed.type === "item.completed") && parsed.item) {
        if (parsed.item.type === "command_execution") {
          toolsUsed.add("command_execution");
        } else if (parsed.item.type === "agent_message" && parsed.type === "item.completed" && parsed.item.text) {
          textParts.push(parsed.item.text);
        }
        continue;
      }

      if (parsed.type === "error") {
        hasError = true;
        errorMessage = parsed.error?.message ?? "unknown error";
      }
    } catch {
      // Skip non-JSON lines gracefully.
    }
  }

  const rawResponse = textParts.join("\n\n").trim();
  const inputRequest = rawResponse ? extractClaudeInputRequest(rawResponse) : undefined;
  const response = inputRequest ? stripClaudeInputRequest(rawResponse) : rawResponse;

  if (!response && !hasError) {
    throw new CodexNoAssistantResponseError(
      `Codex produced no assistant response (${lines.length} events, ${turnCount} completed turns)`,
    );
  }

  const model = agent.model;
  const rates = DEFAULT_COST_RATES[model];
  const cost = rates ? (tokensIn * rates.input + tokensOut * rates.output) / 1_000_000 : 0;

  logger.info(
    `[invoke] ${logLabel} backend=codex completed duration=${duration}ms tokens=${tokensIn}+${tokensOut} cost=$${cost.toFixed(4)} turns=${turnCount || (response ? 1 : 0)}`,
  );

  if (hasError) {
    logger.warn(`[invoke] ${logLabel} backend=codex error_events=${errorMessage}`);
  }

  return {
    response: response || (hasError ? `[Codex error] ${errorMessage}` : "Task completed"),
    agent: agent.name,
    method: "cli",
    model,
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    cost,
    duration_ms: duration,
    toolsUsed: toolsUsed.size > 0 ? [...toolsUsed] : undefined,
    input_request: inputRequest,
  };
}

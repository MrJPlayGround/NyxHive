/**
 * Ralph Loop — autonomous iteration mode for delegated agents.
 *
 * When mode is "ralph", the agent iterates autonomously:
 *   execute → verify → adjust → repeat
 * until verified completion, repeated errors, or max rounds.
 */
import { logger } from "../utils/logger.js";
import { invokeAgent, type CLIProgress } from "../agents/invoke.js";
import type { InvocationResult, RalphIteration, AgentConfig } from "../types.js";
import { RALPH_MAX_ROUNDS, RALPH_MAX_SAME_ERRORS } from "../defaults.js";
import { DELEGATION_COST_CEILING_USD } from "./delegation.js";

/** System prompt section injected for Ralph mode agents. */
export function buildRalphInstructions(maxRounds: number): string {
  return [
    "[Ralph Mode — Autonomous Iteration]",
    "",
    `You are operating in Ralph mode. You have up to ${maxRounds} rounds to complete this task autonomously.`,
    "",
    "Each round you MUST:",
    "1. Execute the task (implement, fix, build)",
    "2. Verify your work (run tests, check output, validate deliverables)",
    "3. Report your status clearly at the end using one of:",
    "   - RALPH:PASS — task is verified complete",
    "   - RALPH:FAIL <reason> — verification failed, you will iterate",
    "   - RALPH:BLOCKED <reason> — fundamental blocker, cannot proceed",
    "",
    "If verification fails, analyze the failure, adjust your approach, and try again.",
    "Do NOT repeat the same approach that already failed.",
    "Do NOT ask for human input — resolve issues autonomously.",
  ].join("\n");
}

/** Build a continuation prompt for the next Ralph iteration. */
function buildIterationPrompt(
  originalTask: string,
  round: number,
  maxRounds: number,
  previousIterations: RalphIteration[],
  lastResponse: string,
): string {
  const history = previousIterations.map((it) =>
    `  Round ${it.round}: ${it.verification_result}${it.error ? ` — ${it.error}` : ""}${it.next_action ? ` → ${it.next_action}` : ""}`,
  ).join("\n");

  const lastExcerpt = lastResponse.length > 2000
    ? `...${lastResponse.slice(-2000)}`
    : lastResponse;

  return [
    `[Ralph Mode — Round ${round + 1}/${maxRounds}]`,
    "",
    `Original task: ${originalTask.slice(0, 1000)}`,
    "",
    "## Iteration History",
    history || "  (first round)",
    "",
    "## Last Response (excerpt)",
    lastExcerpt,
    "",
    "## Instructions",
    "The previous attempt did not pass verification.",
    "Analyze what went wrong, adjust your approach, and try again.",
    "Do NOT repeat the same approach. Try a different strategy.",
    "End with RALPH:PASS, RALPH:FAIL <reason>, or RALPH:BLOCKED <reason>.",
  ].join("\n");
}

/** Parse Ralph status from agent response. */
export function parseRalphVerdict(response: string): {
  result: "pass" | "fail" | "blocked" | "none";
  reason?: string;
} {
  // Check from end of response backwards — last verdict wins
  const passMatch = response.match(/RALPH:PASS\b/i);
  const failMatch = response.match(/RALPH:FAIL\s*(.*)/i);
  const blockedMatch = response.match(/RALPH:BLOCKED\s*(.*)/i);

  // Find the last occurring verdict
  const verdicts: Array<{ index: number; result: "pass" | "fail" | "blocked"; reason?: string }> = [];
  if (passMatch?.index !== undefined) verdicts.push({ index: passMatch.index, result: "pass" });
  if (failMatch?.index !== undefined) verdicts.push({ index: failMatch.index, result: "fail", reason: failMatch[1]?.trim() });
  if (blockedMatch?.index !== undefined) verdicts.push({ index: blockedMatch.index, result: "blocked", reason: blockedMatch[1]?.trim() });

  if (verdicts.length === 0) return { result: "none" };
  verdicts.sort((a, b) => b.index - a.index);
  return { result: verdicts[0].result, reason: verdicts[0].reason };
}

export interface RalphLoopOpts {
  agentConfig: AgentConfig;
  task: string;
  invokeOpts: Parameters<typeof invokeAgent>[2];
  maxRounds?: number;
  timeoutMs: number;
  onProgress?: (info: CLIProgress) => void;
  onIteration?: (iteration: RalphIteration) => void;
}

export interface RalphLoopResult {
  finalResult: InvocationResult;
  iterations: RalphIteration[];
  outcome: "verified" | "max_rounds" | "blocked" | "repeated_error" | "cost_ceiling";
}

/**
 * Execute the Ralph loop: invoke agent, parse verdict, iterate until done.
 */
export async function executeRalphLoop(opts: RalphLoopOpts): Promise<RalphLoopResult> {
  const maxRounds = opts.maxRounds ?? RALPH_MAX_ROUNDS;
  const iterations: RalphIteration[] = [];
  const errorCounts = new Map<string, number>();
  let currentTask = opts.task;
  let lastResult: InvocationResult | null = null;
  let totalCost = 0;

  for (let round = 0; round < maxRounds; round++) {
    const roundStart = Date.now();

    logger.info(`[ralph] Round ${round + 1}/${maxRounds} for ${opts.agentConfig.name}`);

    if (opts.onProgress) {
      opts.onProgress({
        phase: "working",
        activity: `Ralph iteration ${round + 1}/${maxRounds}`,
        agent: opts.agentConfig.name,
        delegationDepth: 0,
        turns: round + 1,
        elapsed: Date.now(),
        tokensIn: 0,
        tokensOut: 0,
      });
    }

    const result = await Promise.race([
      invokeAgent(opts.agentConfig, currentTask, opts.invokeOpts),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Ralph round ${round + 1} timed out`)), opts.timeoutMs),
      ),
    ]);

    lastResult = result;
    totalCost += result.cost ?? 0;

    const verdict = parseRalphVerdict(result.response);
    const verificationResult = verdict.result === "none" ? "pass" : verdict.result === "blocked" ? "error" : verdict.result;

    const iteration: RalphIteration = {
      round: round + 1,
      action: result.response.slice(0, 200),
      verification_result: verificationResult,
      error: verdict.reason,
      next_action: verificationResult === "fail" ? "iterate" : null,
      duration_ms: Date.now() - roundStart,
      tokens_in: result.tokens_in,
      tokens_out: result.tokens_out,
    };
    iterations.push(iteration);
    opts.onIteration?.(iteration);

    // Verified pass — done
    if (verdict.result === "pass" || verdict.result === "none") {
      logger.info(`[ralph] Verified pass at round ${round + 1}`);
      return { finalResult: result, iterations, outcome: "verified" };
    }

    // Blocked — stop
    if (verdict.result === "blocked") {
      logger.warn(`[ralph] Blocked at round ${round + 1}: ${verdict.reason}`);
      return { finalResult: result, iterations, outcome: "blocked" };
    }

    // Check repeated errors
    const errorKey = (verdict.reason ?? "unknown").slice(0, 100).toLowerCase();
    const count = (errorCounts.get(errorKey) ?? 0) + 1;
    errorCounts.set(errorKey, count);
    if (count >= RALPH_MAX_SAME_ERRORS) {
      logger.warn(`[ralph] Same error repeated ${count}x, stopping: ${errorKey}`);
      return { finalResult: result, iterations, outcome: "repeated_error" };
    }

    // Cost ceiling
    if (totalCost >= DELEGATION_COST_CEILING_USD) {
      logger.warn(`[ralph] Cost ceiling ($${totalCost.toFixed(2)}) hit at round ${round + 1}`);
      return { finalResult: result, iterations, outcome: "cost_ceiling" };
    }

    // Build next iteration prompt
    currentTask = buildIterationPrompt(opts.task, round + 1, maxRounds, iterations, result.response);
  }

  logger.warn(`[ralph] Max rounds (${maxRounds}) reached`);
  return { finalResult: lastResult!, iterations, outcome: "max_rounds" };
}

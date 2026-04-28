/**
 * review-gate.ts — Auto-review gate for coding delegations.
 *
 * After a coder agent (e.g. Forge) completes a task, this module runs a cheap
 * LLM review against the original request, the agent's response, and the actual
 * git diff. Produces a PASS / WARN / FAIL verdict that gets appended to the
 * delegation result before returning to the orchestrator.
 *
 * Key exports:
 *  - captureGitDiff()        — grabs uncommitted or last-commit diff from a repo
 *  - buildReviewPrompt()     — assembles the review prompt with task + response + diff
 *  - parseVerdict()          — extracts structured verdict JSON from LLM output
 *  - runReviewGate()         — orchestrates the full review (diff → prompt → LLM → verdict)
 *  - formatReviewAnnotation() — formats the verdict as a markdown block for appending
 *
 * Design constraints:
 *  - Never blocks a delegation — failures degrade to WARN, not errors
 *  - 60s default timeout; skips review on timeout or LLM failure
 *  - Only triggers for configured roles (default: ["coder"])
 *  - Diffs truncated to max_diff_lines to stay within cheap model context
 */
import { logger } from "../utils/logger.js";
import type { ProviderRouter } from "../providers/router.js";
import type { TraceStore } from "../memory/traces.js";
import type { InvocationResult, AgentConfig } from "../types.js";
import { resolveAgentRuntimePath } from "../agents/paths.js";
import { trimTextToTokenBudget } from "../context/token-discipline.js";

// --- Types ---

export interface ReviewGateConfig {
  enabled: boolean;
  /** Model to use for review (defaults to code_review route) */
  model?: string;
  /** Provider to use for review */
  provider?: string;
  /** Max tokens for the review response */
  max_tokens?: number;
  /** Max diff lines to include in prompt (truncate beyond this) */
  max_diff_lines?: number;
  /** Timeout in ms for the review LLM call (default: 60s) */
  timeout_ms?: number;
  /** Max retry attempts on FAIL verdict (default: 1) */
  max_retries?: number;
  /** Agent roles that trigger the review gate */
  roles?: string[];
}

export type ReviewVerdict = "pass" | "fail" | "warn";

export interface ReviewGateResult {
  verdict: ReviewVerdict;
  summary: string;
  issues: string[];
  raw: string;
  /** Number of review attempts (1 = first pass, 2+ = retries) */
  attempts: number;
}

// --- Defaults ---

const DEFAULT_MAX_TOKENS = 2048;
const DEFAULT_MAX_DIFF_LINES = 500;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_ROLES = ["coder", "lead"];
const REVIEW_TASK_TOKEN_BUDGET = 700;
const REVIEW_RESPONSE_TOKEN_BUDGET = 1200;
const REVIEW_DIFF_TOKEN_BUDGET = 3000;

// --- Git diff capture ---

/**
 * Capture the git diff for an agent's working directory.
 * Uses `git diff HEAD` to see uncommitted changes, or `git diff HEAD~1`
 * if everything is committed (to see the last commit's changes).
 */
export async function captureGitDiff(workingDir: string, maxLines: number = DEFAULT_MAX_DIFF_LINES): Promise<string | null> {
  try {
    // First try uncommitted changes
    const uncommitted = Bun.spawnSync(["git", "diff", "HEAD"], { cwd: workingDir });
    let diff = uncommitted.stdout.toString().trim();

    // If no uncommitted changes, check the last commit
    if (!diff) {
      const lastCommit = Bun.spawnSync(["git", "diff", "HEAD~1", "HEAD"], { cwd: workingDir });
      diff = lastCommit.stdout.toString().trim();
    }

    if (!diff) return null;

    // Truncate if too long
    const lines = diff.split("\n");
    if (lines.length > maxLines) {
      return `${lines.slice(0, maxLines).join("\n")}\n\n... (truncated, ${lines.length - maxLines} lines omitted)`;
    }

    return diff;
  } catch (err) {
    logger.warn(`[review-gate] Failed to capture git diff from ${workingDir}: ${err}`);
    return null;
  }
}

// --- Prompt builder ---

export function buildReviewPrompt(
  _agentName: string,
  task: string,
  response: string,
  diff: string | null,
): string {
  const cappedTask = trimTextToTokenBudget(task, REVIEW_TASK_TOKEN_BUDGET, {
    marker: "[...task trimmed for review token budget...]",
    mode: "fast",
  });
  const cappedResponse = trimTextToTokenBudget(response, REVIEW_RESPONSE_TOKEN_BUDGET, {
    marker: "[...agent response trimmed for review token budget...]",
    mode: "fast",
  });
  const cappedDiff = diff
    ? trimTextToTokenBudget(diff, REVIEW_DIFF_TOKEN_BUDGET, {
        marker: "[...diff trimmed for review token budget...]",
        mode: "fast",
      })
    : null;

  const trims = [
    cappedTask.trimmed ? `task ${cappedTask.originalTokenEstimate}->${cappedTask.tokenEstimate}` : null,
    cappedResponse.trimmed ? `response ${cappedResponse.originalTokenEstimate}->${cappedResponse.tokenEstimate}` : null,
    cappedDiff?.trimmed ? `diff ${cappedDiff.originalTokenEstimate}->${cappedDiff.tokenEstimate}` : null,
  ].filter(Boolean);
  if (trims.length > 0) {
    logger.warn(`[token-discipline] review gate prompt trimmed: ${trims.join(", ")}`);
  }

  const diffSection = diff
    ? `\n## Git Diff\n\`\`\`diff\n${cappedDiff!.text}\n\`\`\``
    : "\n## Git Diff\nNo diff available.";

  return `You are a code review gate. Evaluate whether a coding agent's work is acceptable.

## Task Given
${cappedTask.text}

## Agent Response (excerpt)
${cappedResponse.text}
${diffSection}

## Instructions

Review the agent's work for:
1. **Correctness** — Does the code do what the task asked?
2. **Completeness** — Are all parts of the task addressed?
3. **Quality** — No obvious bugs, security issues, or anti-patterns?
4. **Tests** — Did the agent run tests/builds if applicable?

Respond with ONLY valid JSON (no markdown fences):
{
  "verdict": "pass" | "fail" | "warn",
  "summary": "One-sentence summary of your assessment",
  "issues": ["List of specific issues found, empty if pass"]
}

Rules:
- "pass": Work is correct, complete, tested. Ship it.
- "warn": Work is mostly fine but has minor concerns. Note them.
- "fail": Work has significant issues — incomplete, incorrect, or untested.
- Be pragmatic. Don't fail for style nits. Focus on correctness and completeness.`;
}

// --- Verdict parser ---

export function parseVerdict(raw: string, attempts = 1): ReviewGateResult {
  const trimmed = raw.trim();

  // Try to extract JSON from the response (handle markdown fences)
  let jsonStr = trimmed;
  const fenceMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (fenceMatch) {
    jsonStr = fenceMatch[1].trim();
  }

  try {
    const parsed = JSON.parse(jsonStr) as { verdict?: string; summary?: string; issues?: string[] };

    const verdict = (parsed.verdict === "pass" || parsed.verdict === "fail" || parsed.verdict === "warn")
      ? parsed.verdict
      : "warn";

    return {
      verdict,
      summary: typeof parsed.summary === "string" ? parsed.summary : "Unable to parse review summary",
      issues: Array.isArray(parsed.issues) ? parsed.issues.filter((i): i is string => typeof i === "string") : [],
      raw: trimmed,
      attempts,
    };
  } catch {
    // If JSON parsing fails, treat as a warning with the raw text
    logger.warn(`[review-gate] Failed to parse review verdict JSON: ${trimmed.slice(0, 200)}`);
    return {
      verdict: "warn",
      summary: "Review gate could not parse LLM response",
      issues: [trimmed.slice(0, 500)],
      raw: trimmed,
      attempts,
    };
  }
}

// --- Feedback extraction ---

/**
 * Extract actionable feedback from a FAIL verdict to inject into a retry prompt.
 */
export function extractFeedback(result: ReviewGateResult): string {
  const parts: string[] = [];
  if (result.summary) parts.push(result.summary);
  if (result.issues.length > 0) {
    parts.push("Issues found:");
    for (const issue of result.issues) {
      parts.push(`- ${issue}`);
    }
  }
  return parts.join("\n");
}

/**
 * Build a retry prompt that includes the original task + review feedback.
 */
export function buildRetryPrompt(originalTask: string, feedback: string): string {
  return `${originalTask}\n\n## Review Feedback — Fix These Issues\n\nThe following issues were found in the previous attempt:\n\n${feedback}\n\nPlease fix all issues listed above and re-verify your work.`;
}

// --- Runner ---

export interface ReviewGateContext {
  router?: ProviderRouter;
  config?: ReviewGateConfig;
  baseDir: string;
  traces?: TraceStore;
  traceId?: string;
  parentEventId?: number;
}

/**
 * Run the review gate on a completed delegation result.
 * Returns null if the gate is disabled or not applicable.
 */
export async function runReviewGate(
  ctx: ReviewGateContext,
  agentConfig: AgentConfig,
  task: string,
  result: InvocationResult,
): Promise<ReviewGateResult | null> {
  const config = ctx.config;
  if (!config?.enabled) return null;
  if (!ctx.router) {
    logger.warn("[review-gate] No router available, skipping review gate");
    return null;
  }

  // Check if agent role triggers the gate
  const roles = config.roles ?? DEFAULT_ROLES;
  if (agentConfig.role && !roles.includes(agentConfig.role)) {
    return null;
  }

  // Capture git diff from agent's working directory
  const workDir = resolveAgentRuntimePath(ctx.baseDir, agentConfig.working_directory) ?? ctx.baseDir;
  const maxDiffLines = config.max_diff_lines ?? DEFAULT_MAX_DIFF_LINES;
  const diff = await captureGitDiff(workDir, maxDiffLines);

  // Build the review prompt
  const prompt = buildReviewPrompt(agentConfig.name, task, result.response, diff);

  // Call the LLM
  const maxTokens = config.max_tokens ?? DEFAULT_MAX_TOKENS;
  const provider = config.provider;
  const model = config.model;

  const timeoutMs = config.timeout_ms ?? DEFAULT_TIMEOUT_MS;

  logger.info(`[review-gate] Running review gate for ${agentConfig.name} (${provider ?? "default"}/${model ?? "default"}, timeout=${timeoutMs}ms)`);

  // Start trace event if tracing is available
  let eventId: number | undefined;
  if (ctx.traces && ctx.traceId) {
    eventId = ctx.traces.startEvent(ctx.traceId, "review_gate", `Review gate for ${agentConfig.name}`, ctx.parentEventId);
  }

  const startMs = Date.now();

  try {
    const llmCall = ctx.router.complete(
      {
        messages: [{ role: "user", content: prompt }],
        maxTokens,
        temperature: 0,
        model,
      },
      provider as "anthropic" | "openrouter" | undefined,
      model,
    );

    // Race the LLM call against a timeout
    const timeout = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Review gate timed out after ${timeoutMs}ms`)), timeoutMs),
    );

    const response = await Promise.race([llmCall, timeout]);
    const gateResult = parseVerdict(response.content);
    const durationMs = Date.now() - startMs;

    logger.info(`[review-gate] Verdict for ${agentConfig.name}: ${gateResult.verdict} — ${gateResult.summary} (${durationMs}ms)`);

    // Complete trace event — review gate is always an SDK API call
    if (ctx.traces && eventId) {
      ctx.traces.completeEvent(eventId, {
        responseExcerpt: `${gateResult.verdict}: ${gateResult.summary}`,
        tokensIn: response.tokensIn,
        tokensOut: response.tokensOut,
        durationMs,
        model: response.model ?? model,
        taskType: "review_gate",
        billingType: "api",
      });
    }

    return gateResult;
  } catch (err) {
    logger.error(`[review-gate] Review gate LLM call failed (${Date.now() - startMs}ms): ${err}`);

    // Fail trace event
    if (ctx.traces && eventId) {
      ctx.traces.failEvent(eventId, String(err));
    }

    return {
      verdict: "warn",
      summary: "Review gate LLM call failed",
      issues: [`Error: ${err}`],
      raw: String(err),
      attempts: 1,
    };
  }
}

/**
 * Format a review gate result as a markdown annotation to append to agent response.
 */
export function formatReviewAnnotation(result: ReviewGateResult): string {
  const emoji = result.verdict === "pass" ? "PASS" : result.verdict === "fail" ? "FAIL" : "WARN";
  const attemptInfo = result.attempts > 1 ? ` (attempt ${result.attempts})` : "";
  const issueList = result.issues.length > 0
    ? `\n${result.issues.map(i => `>   - ${i}`).join("\n")}`
    : "";

  return `\n\n> **Review Gate [${emoji}]${attemptInfo}:** ${result.summary}${issueList}`;
}

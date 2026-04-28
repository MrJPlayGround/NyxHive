/**
 * Pattern distillation — extract reusable patterns from task outcomes.
 *
 * Reads recent outcomes, groups by agent, builds a summary prompt,
 * calls a cheap LLM to extract structured patterns, and stores them
 * in PatternStore for injection into future delegation envelopes.
 */

import { logger } from "../utils/logger.js";
import type { OutcomeStore, TaskOutcome } from "../memory/outcomes.js";
import type { PatternStore } from "../memory/patterns.js";
import { parsePatternResponse } from "../memory/patterns.js";
import type { ProviderRouter } from "../providers/router.js";

export interface DistillationResult {
  agents_processed: number;
  patterns_extracted: number;
  patterns_pruned: number;
  expired_pruned: number;
}

/** Build the analysis prompt for a set of outcomes. */
function buildDistillationPrompt(agent: string, outcomes: TaskOutcome[]): string {
  const successes = outcomes.filter(o => o.outcome === "success");
  const failures = outcomes.filter(o => o.outcome === "failed");
  const partials = outcomes.filter(o => o.outcome === "partial");

  const lines: string[] = [
    `Analyze these ${outcomes.length} task outcomes for agent "${agent}" from the past week.`,
    `Successes: ${successes.length}, Failures: ${failures.length}, Partial: ${partials.length}`,
    "",
  ];

  for (const o of outcomes) {
    const verifyStatus = o.verification_passed === 1 ? " [tests: PASS]" : o.verification_passed === 0 ? " [tests: FAIL]" : "";
    lines.push(`- [${o.outcome.toUpperCase()}] ${o.task_type}: ${o.review_verdict ?? "no review"}${verifyStatus}${o.failure_reason ? ` — ${o.failure_reason}` : ""}${o.retry_count > 0 ? ` (${o.retry_count} retries)` : ""}${o.cost_cents ? ` [$${(o.cost_cents / 100).toFixed(2)}]` : ""}${o.duration_ms ? ` [${Math.round(o.duration_ms / 1000)}s]` : ""}`);
  }

  lines.push("");
  lines.push(`Extract patterns as a JSON array. Each pattern should have:
- agent: "${agent}"
- pattern: what was observed (be specific, mention file types or task categories)
- confidence: 0.0-1.0 based on evidence strength
- evidence_count: how many outcomes support this pattern
- recommendation: actionable advice for future tasks
- category: one of "success_pattern", "failure_pattern", "cost_pattern", "performance_pattern"

Only include patterns with at least 2 supporting outcomes or 1 strong signal (e.g., repeated failure mode).
Return ONLY the JSON array, no explanation.`);

  return lines.join("\n");
}

/**
 * Run pattern distillation over recent outcomes.
 *
 * Called as a system task by the scheduler (weekly cron).
 * Uses a cheap model (haiku/flash) since the analysis is structured.
 */
export async function distillPatterns(opts: {
  outcomes: OutcomeStore;
  patterns: PatternStore;
  router: ProviderRouter;
  sinceDays?: number;
}): Promise<DistillationResult> {
  const { outcomes, patterns, router } = opts;
  const sinceDays = opts.sinceDays ?? 7;
  const since = new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000).toISOString();

  const result: DistillationResult = {
    agents_processed: 0,
    patterns_extracted: 0,
    patterns_pruned: 0,
    expired_pruned: 0,
  };

  // Prune expired patterns first
  result.expired_pruned = patterns.pruneExpired();
  if (result.expired_pruned > 0) {
    logger.info(`[distill] Pruned ${result.expired_pruned} expired patterns`);
  }

  // Query all recent outcomes
  const recentOutcomes = outcomes.query({ since, limit: 500 });
  if (recentOutcomes.length === 0) {
    logger.info("[distill] No outcomes in the last week, skipping distillation");
    return result;
  }

  // Group by agent
  const byAgent = new Map<string, TaskOutcome[]>();
  for (const o of recentOutcomes) {
    const key = o.agent.toLowerCase();
    const list = byAgent.get(key) ?? [];
    list.push(o);
    byAgent.set(key, list);
  }

  logger.info(`[distill] Processing ${recentOutcomes.length} outcomes across ${byAgent.size} agents`);

  for (const [agent, agentOutcomes] of byAgent) {
    // Skip agents with very few outcomes — not enough signal
    if (agentOutcomes.length < 2) continue;

    const prompt = buildDistillationPrompt(agent, agentOutcomes);

    try {
      // Use a cheap model for analysis — structured task, doesn't need reasoning power
      const response = await router.complete({
        messages: [{ role: "user", content: prompt }],
        model: "haiku",
        maxTokens: 2000,
        temperature: 0.1,
      });

      const content = response.content;

      const extracted = parsePatternResponse(content);

      for (const p of extracted) {
        // Force agent to match (in case the LLM returns something else)
        p.agent = agent;
        patterns.record(p);
      }

      result.patterns_extracted += extracted.length;
      result.agents_processed++;

      if (extracted.length > 0) {
        logger.info(`[distill] ${agent}: extracted ${extracted.length} patterns from ${agentOutcomes.length} outcomes`);
      }

      // Prune old patterns for this agent (keep last 8 batches)
      const pruned = patterns.pruneOld(agent);
      result.patterns_pruned += pruned;
    } catch (err) {
      logger.error(`[distill] Failed to distill patterns for ${agent}: ${err}`);
    }
  }

  logger.info(`[distill] Complete: ${result.agents_processed} agents, ${result.patterns_extracted} patterns extracted, ${result.patterns_pruned} pruned`);
  return result;
}

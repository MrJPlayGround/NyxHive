/**
 * Autonomous development loop (Ralph pattern).
 *
 * Decomposes a feature into stories, executes each in a fresh CLI session,
 * runs quality checks, commits on pass, retries on fail. Memory persists
 * through files (git history, LEARNINGS.md, workspace docs), not conversation context.
 */

import type { DevPlanStore, DevPlan, DevStory } from "./plan.js";
import type { AgentRegistry } from "../agents/registry.js";
import type { MemoryStore } from "../memory/store.js";
import type { NyxHiveConfig } from "../types.js";
import type { CLIProgress } from "../agents/invoke.js";
import type { SSEEvent } from "../types.js";
import type { FileAttachment } from "../providers/types.js";
import { getBudgetConfig } from "../defaults.js";
import { logger } from "../utils/logger.js";
import { formatError } from "../utils/error.js";

const MAX_PLAN_DURATION_MS = 4 * 60 * 60 * 1000; // 4 hours

/** Narrow interface: only what executeDevPlan needs from the processor. */
export interface DevLoopProcessor {
  processImmediate(opts: {
    channel: string;
    sender: string;
    sender_id?: string;
    thread_id?: string;
    message: string;
    agent?: string;
    modelOverride?: string;
    is_group?: boolean;
    files?: FileAttachment[];
    onProgress?: (info: CLIProgress) => void;
    onEvent?: (event: SSEEvent) => void;
    trust?: import("../security/input-sanitizer.js").TrustOrigin;
  }): Promise<{ message_id: string; response: string; agent: string; trace_id?: string }>;
}

export interface DevLoopOpts {
  planStore: DevPlanStore;
  processor: DevLoopProcessor;
  registry: AgentRegistry;
  memory?: MemoryStore;
  config: NyxHiveConfig;
}

/**
 * Execute a development plan story-by-story.
 * Called when a plan transitions to 'running'.
 * Runs asynchronously — caller should not await unless they want to block.
 */
export async function executeDevPlan(planId: string, opts: DevLoopOpts): Promise<void> {
  const { planStore, processor, registry, memory, config } = opts;

  const plan = planStore.getPlan(planId);
  if (!plan) {
    logger.error(`[dev-loop] Plan ${planId} not found`);
    return;
  }

  if (plan.status !== "running") {
    logger.warn(`[dev-loop] Plan ${planId} not in 'running' state (${plan.status}), skipping`);
    return;
  }

  const planStart = Date.now();
  logger.info(`[dev-loop] Starting plan ${planId}: "${plan.feature}" (agent=${plan.agent}, branch=${plan.branch})`);

  // Ensure git branch exists
  const agentConfig = registry.get(plan.agent);
  if (!agentConfig) {
    logger.error(`[dev-loop] Agent '${plan.agent}' not found in registry`);
    planStore.updatePlanStatus(planId, "failed");
    return;
  }

  while (true) {
    // Re-fetch plan status (may have been paused externally)
    const current = planStore.getPlan(planId);
    if (!current || current.status !== "running") {
      logger.info(`[dev-loop] Plan ${planId} status changed to '${current?.status}', stopping loop`);
      break;
    }

    // Check plan duration limit
    if (Date.now() - planStart > MAX_PLAN_DURATION_MS) {
      logger.warn(`[dev-loop] Plan ${planId} exceeded max duration (4h), pausing`);
      planStore.updatePlanStatus(planId, "paused");
      break;
    }

    // Budget check: pause if monthly spend > 90%
    if (memory) {
      const monthCost = memory.getTotalCost(24 * 30);
      const budgetCfg = getBudgetConfig(config.budget);
      if (budgetCfg.monthly > 0 && monthCost > budgetCfg.monthly * 0.9) {
        logger.warn(`[dev-loop] Budget >90% ($${monthCost.toFixed(2)}/$${budgetCfg.monthly}), pausing plan ${planId}`);
        planStore.updatePlanStatus(planId, "paused");
        break;
      }
    }

    // Get next pending story
    const story = planStore.getNextPendingStory(planId);
    if (!story) {
      // All stories processed — check overall result
      const progress = planStore.getPlanProgress(planId);
      if (progress.failed > 0) {
        planStore.updatePlanStatus(planId, "failed");
        logger.info(`[dev-loop] Plan ${planId} finished with failures: ${progress.passed} passed, ${progress.failed} failed, ${progress.skipped} skipped`);
      } else {
        planStore.updatePlanStatus(planId, "completed");
        logger.info(`[dev-loop] Plan ${planId} completed: ${progress.passed}/${progress.total} stories passed`);
      }
      break;
    }

    // Execute the story
    await executeStory(plan, story, opts);
  }
}

async function executeStory(plan: DevPlan, story: DevStory, opts: DevLoopOpts): Promise<void> {
  const { planStore, processor } = opts;
  const storyStart = Date.now();

  planStore.updateStory(story.id, { status: "running", attempts: story.attempts + 1 });

  logger.info(`[dev-loop] Story ${story.id} (${story.sequence}/${plan.feature}): "${story.title}" attempt ${story.attempts + 1}`);

  // Build the story prompt
  const prompt = buildStoryPrompt(plan, story, opts);

  try {
    // Execute via processImmediate — this spawns a fresh CLI session
    const result = await processor.processImmediate({
      channel: "dev-loop",
      sender: `dev-loop:${plan.id}`,
      sender_id: `dev-loop:${plan.id}`,
      message: prompt,
      agent: plan.agent,
    });

    const duration = Date.now() - storyStart;

    // Check if the agent reported success or failure
    const response = result.response.toLowerCase();
    const hasError = response.includes("[blocked]") || response.includes("[failed]") || response.includes("could not complete");

    if (hasError) {
      handleStoryFailure(plan, story, result.response, duration, opts);
    } else {
      // Story appears to have succeeded
      planStore.updateStory(story.id, {
        status: "passed",
        duration_ms: duration,
        learnings: extractLearnings(result.response),
      });
      logger.info(`[dev-loop] Story ${story.id} PASSED in ${Math.round(duration / 1000)}s`);
    }
  } catch (err) {
    const duration = Date.now() - storyStart;
    const errorMsg = formatError(err);
    handleStoryFailure(plan, story, errorMsg, duration, opts);
  }
}

function handleStoryFailure(
  _plan: DevPlan,
  story: DevStory,
  error: string,
  duration: number,
  opts: DevLoopOpts,
): void {
  const { planStore } = opts;
  const attempt = story.attempts + 1;

  if (attempt >= story.max_retries) {
    planStore.updateStory(story.id, {
      status: "failed",
      last_error: error.slice(0, 2000),
      duration_ms: duration,
    });
    logger.warn(`[dev-loop] Story ${story.id} FAILED after ${attempt} attempts: ${error.slice(0, 200)}`);
  } else {
    // Reset to pending for retry
    planStore.updateStory(story.id, {
      status: "pending",
      attempts: attempt,
      last_error: error.slice(0, 2000),
      duration_ms: duration,
    });
    logger.info(`[dev-loop] Story ${story.id} failed attempt ${attempt}/${story.max_retries}, will retry`);
  }
}

function buildStoryPrompt(plan: DevPlan, story: DevStory, opts: DevLoopOpts): string {
  const { planStore } = opts;

  // Get completed stories for context
  const allStories = planStore.getStories(plan.id);
  const completedStories = allStories
    .filter(s => s.status === "passed" && s.sequence < story.sequence)
    .map(s => `- [x] ${s.id}: ${s.title}${s.commit_hash ? ` (commit ${s.commit_hash.slice(0, 7)})` : ""}`);

  // Collect learnings from previous stories
  const previousLearnings = allStories
    .filter(s => s.learnings && s.sequence < story.sequence)
    .map(s => `### ${s.title}\n${s.learnings}`)
    .join("\n\n");

  // Build acceptance criteria
  const criteria = story.acceptance_criteria.length > 0
    ? story.acceptance_criteria.map(c => `- [ ] ${c}`).join("\n")
    : "- [ ] Implementation complete and working";

  // Build checks
  const checks = plan.checks.length > 0
    ? plan.checks.map((c, i) => `${i + 1}. \`${c}\``).join("\n")
    : "1. Code compiles without errors";

  // Error context from previous failed attempts
  const errorContext = story.last_error
    ? `\n## Previous Attempt Failed\n\`\`\`\n${story.last_error.slice(0, 1000)}\n\`\`\`\nFix the issue above. Do not repeat the same approach that failed.\n`
    : "";

  return `## Task
Implement: "${story.title}"

## Acceptance Criteria
${criteria}

## Context
Branch: ${plan.branch}
Plan: ${plan.feature}
${completedStories.length > 0 ? `\nPrevious stories completed:\n${completedStories.join("\n")}` : ""}
${errorContext}
${previousLearnings ? `## Learnings from Previous Stories\n${previousLearnings}\n` : ""}
## Quality Checks (must all pass before committing)
${checks}

## Rules
- Implement ONLY this story. Do not work on future stories.
- If you discover something that affects future stories, note it but don't implement it.
- If you're blocked and can't complete this story, explain why clearly and include [BLOCKED] in your response.
- Commit with message: "feat(${plan.id}): ${story.title}"
- After committing, list any learnings or discoveries as bullet points under a "## Learnings" heading.`;
}

function extractLearnings(response: string): string | null {
  // Look for a learnings section in the agent's response
  const match = response.match(/##\s*Learnings?\s*\n([\s\S]*?)(?:\n##|$)/i);
  if (match?.[1].trim()) {
    return match[1].trim();
  }
  return null;
}

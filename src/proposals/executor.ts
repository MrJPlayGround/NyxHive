/**
 * Proposal executor — auto-execution on approval with capacity gating.
 *
 * When a proposal transitions to `approved`, the executor checks capacity
 * and triggers execution if a slot is available. Completed executions
 * automatically pick up the next queued proposal.
 *
 * Review gate integration: after execution, optionally runs review gate.
 * On FAIL verdict, retries with feedback (up to max_retries). On second
 * FAIL, marks proposal as failed with review feedback.
 */
import { logger } from "../utils/logger.js";
import { createPrForBranch, extractPrUrl, proposalBranchName } from "./pr-utils.js";
import { createWorktree, cleanupWorktree, type WorktreeResult } from "../agents/worktree.js";
import { generatePluginJson } from "../agents/skill-loader.js";
import type { ProposalStore } from "./store.js";
import type { ReviewGateResult } from "../queue/review-gate.js";
import { extractFeedback, buildRetryPrompt } from "../queue/review-gate.js";
import type { OutcomeStore } from "../memory/outcomes.js";
import type { PatternStore } from "../memory/patterns.js";
import { runVerification, resolveVerifyConfig, type VerifyConfig } from "./verification.js";
import { validateArtifacts, type ArtifactKind, type ArtifactEvidence } from "./artifacts.js";
import { DEFAULT_PROPOSAL_EXECUTION_MODEL } from "./model-policy.js";

export type ExecutionTrigger = "auto" | "approval" | "manual";

export interface ExecutorConfig {
  maxConcurrent: number;
  maxRetries: number;
}

export interface ProjectDef {
  name: string;
  repo_path: string;
  default?: boolean;
  verify?: VerifyConfig;
}

export interface ExecutorContext {
  processImmediate: (opts: {
    channel: string; sender: string; message: string; agent: string;
    cwdOverride?: string;
    modelOverride?: string;
  }) => Promise<{ response: string; agent: string }>;
  resolveProposalAgent: (category: string, filesAffected: string[]) => string;
  resolveProposalRepoPath: (filesAffected: string[]) => string;
  emit: (type: string, data: Record<string, unknown>) => void;
  /** Optional outcome tracking store. */
  outcomes?: OutcomeStore;
  /** Run review gate on the agent's output. Returns null if gate disabled. */
  runReview?: (opts: {
    agent: string; task: string; response: string; repoPath: string;
  }) => Promise<ReviewGateResult | null>;
  /** Project definitions for verification config lookup. */
  projects?: ProjectDef[];
  /** Pattern store for injecting learned patterns into execution prompts. */
  patterns?: PatternStore;
}

const DEFAULT_MAX_CONCURRENT = 1;
const DEFAULT_MAX_RETRIES = 1;
const DEFAULT_TYPECHECK_COMMAND = "bun run typecheck";
const DEFAULT_TEST_COMMAND = "bun test";

function formatExecutorLogLabel(
  proposalId: string,
  extras?: Record<string, string | number | undefined>,
): string {
  const parts = [`proposal=${proposalId}`];
  if (extras) {
    for (const [key, value] of Object.entries(extras)) {
      if (value === undefined || value === "") continue;
      parts.push(`${key}=${String(value).replace(/\s+/g, "_")}`);
    }
  }
  return `[${parts.join(" ")}]`;
}

function formatQualityGateSteps(verifyConfig: VerifyConfig | null): string[] {
  if (!verifyConfig) {
    return [
      `Run \`${DEFAULT_TYPECHECK_COMMAND}\` — fix ALL type errors`,
      `Run \`${DEFAULT_TEST_COMMAND}\` — fix ALL test failures`,
    ];
  }

  const steps: string[] = [];
  if (verifyConfig.build_command) {
    steps.push(`Run \`${verifyConfig.build_command}\` — fix ALL build/type errors`);
  }
  if (verifyConfig.test_command) {
    steps.push(`Run \`${verifyConfig.test_command}\` — fix ALL test failures`);
  }

  return steps.length > 0 ? steps : ["Run the project's configured verification checks and fix any failures"];
}

function formatNumberedSteps(start: number, steps: string[]): string {
  return steps.map((step, index) => `${start + index}. ${step}`).join("\n");
}

export class ProposalExecutor {
  private store: ProposalStore;
  private ctx: ExecutorContext;
  private config: ExecutorConfig;
  private activeCount = 0;

  constructor(store: ProposalStore, ctx: ExecutorContext, config?: Partial<ExecutorConfig>) {
    this.store = store;
    this.ctx = ctx;
    this.config = {
      maxConcurrent: config?.maxConcurrent ?? DEFAULT_MAX_CONCURRENT,
      maxRetries: config?.maxRetries ?? DEFAULT_MAX_RETRIES,
    };
  }

  /** Current number of executing proposals. */
  get executing(): number {
    return this.activeCount;
  }

  /** Whether the executor has capacity to start a new execution. */
  get hasCapacity(): boolean {
    return this.activeCount < this.config.maxConcurrent;
  }

  /**
   * Called when a proposal is approved. Checks capacity and triggers
   * execution if a slot is available. Otherwise the proposal waits
   * in `approved` status for pickup.
   */
  async onApproved(proposalId: string, trigger: ExecutionTrigger): Promise<void> {
    const logLabel = formatExecutorLogLabel(proposalId, { trigger });
    // Store the trigger
    this.store.setExecutionTrigger(proposalId, trigger);

    if (!this.hasCapacity) {
      logger.info(`[executor] ${logLabel} queued capacity=${this.activeCount}/${this.config.maxConcurrent}`);
      return;
    }

    await this.executeProposal(proposalId);
  }

  /**
   * Pick up the next approved proposal and execute it.
   * Called after a proposal completes to drain the queue.
   */
  async pickupNext(): Promise<void> {
    if (!this.hasCapacity) return;

    const approved = this.store.listApproved();
    if (approved.length === 0) return;

    // Execute oldest approved first (FIFO)
    await this.executeProposal(approved[0].proposal_id);
  }

  /**
   * Execute all approved proposals. If bundlePr is true, executes them all
   * in a single worktree/branch and creates one combined PR.
   * If bundlePr is false, triggers each individually (they queue via capacity).
   */
  async executeAll(bundlePr: boolean): Promise<{ triggered: number }> {
    const approved = this.store.listApproved();
    if (approved.length === 0) return { triggered: 0 };

    if (!bundlePr) {
      // Trigger each individually — they'll queue via capacity gating
      for (const proposal of approved) {
        this.onApproved(proposal.proposal_id, "manual");
      }
      return { triggered: approved.length };
    }

    // Bundle mode: execute all in a single worktree, one combined PR
    await this.executeBatch(approved.map(p => p.proposal_id));
    return { triggered: approved.length };
  }

  /**
   * Execute multiple proposals in a single worktree/branch, creating one combined PR.
   * Each proposal is implemented sequentially in the same workspace.
   */
  async executeBatch(proposalIds: string[]): Promise<void> {
    const batchId = `batch-${Date.now().toString(36)}`;
    const batchBranch = `proposal/${batchId}`;
    const logLabel = `[executor:batch] [batch=${batchId} count=${proposalIds.length}]`;

    // Claim all proposals as executing
    const proposals: Array<{ proposal_id: string; title: string; description: string; category: string; files_affected: string[] }> = [];
    for (const id of proposalIds) {
      const proposal = this.store.get(id);
      if (!proposal || proposal.status !== "approved") {
        logger.warn(`${logLabel} skip=${id} reason=not_approved`);
        continue;
      }
      const executionRef = `${batchId}-${id}`;
      const claimed = this.store.markExecuting(id, executionRef);
      if (!claimed) {
        logger.warn(`${logLabel} skip=${id} reason=claim_failed`);
        continue;
      }
      this.store.setExecutionTrigger(id, "manual");
      proposals.push({
        proposal_id: proposal.proposal_id,
        title: proposal.title,
        description: proposal.description,
        category: proposal.category,
        files_affected: proposal.files_affected,
      });
    }

    if (proposals.length === 0) {
      logger.warn(`${logLabel} no proposals claimed`);
      return;
    }

    this.activeCount++;
    logger.info(`${logLabel} executing ${proposals.length} proposals in batch`);

    // Use the first proposal to resolve repo path (they should all be same project)
    const repoPath = this.ctx.resolveProposalRepoPath(proposals[0].files_affected);
    let worktree: import("../agents/worktree.js").WorktreeResult | null = null;

    try {
      // Create single worktree for the batch
      try {
        worktree = createWorktree(repoPath, batchBranch);
      } catch (err) {
        logger.warn(`${logLabel} worktree_failed error=${err}`);
      }

      if (worktree) {
        try { generatePluginJson(worktree.path); } catch {}
      }

      const workingDir = worktree?.path ?? repoPath;
      const agent = this.ctx.resolveProposalAgent(proposals[0].category, proposals[0].files_affected);
      const verifyConfig = resolveVerifyConfig(repoPath, this.ctx.projects);
      const qualityGateSteps = formatQualityGateSteps(verifyConfig);
      const completedIds: string[] = [];
      const failedIds: string[] = [];
      let sharedPrUrl: string | null = null;

      // Execute each proposal sequentially in the same worktree
      for (const proposal of proposals) {
        const itemLabel = `${logLabel} [proposal=${proposal.proposal_id}]`;
        logger.info(`${itemLabel} executing title="${proposal.title}"`);

        const filesInfo = proposal.files_affected.length > 0
          ? `Files to modify:\n${proposal.files_affected.map(f => `- ${repoPath}/${f}`).join("\n")}`
          : "No specific files listed.";

        let patternsContext = "";
        if (this.ctx.patterns) {
          const patterns = this.ctx.patterns.searchRelevant({
            agent,
            taskType: proposal.category,
            filePaths: proposal.files_affected,
          });
          const formatted = this.ctx.patterns.formatForInjection(patterns);
          if (formatted) patternsContext = `\n\n${formatted}\n`;
        }

        const taskMessage = `[Batch execution — proposal ${proposal.proposal_id}]\n\n${proposal.description}\n\n${filesInfo}${patternsContext}\n\n## Git Workflow\nWorking in shared batch worktree at: ${workingDir}\nBranch: ${batchBranch} (shared with other proposals in this batch)\n\n1. Make the changes for THIS proposal only\n${formatNumberedSteps(2, qualityGateSteps)}\n${qualityGateSteps.length + 2}. Commit with a descriptive message (feat/fix/chore as appropriate)\n${qualityGateSteps.length + 3}. Do NOT push yet — more proposals may follow\n\nCRITICAL: Do NOT push. Do NOT create a PR. Just commit.`;

        try {
          const result = await this.ctx.processImmediate({
            channel: "system",
            sender: "proposal-executor",
            message: taskMessage,
            agent,
            cwdOverride: workingDir,
            modelOverride: DEFAULT_PROPOSAL_EXECUTION_MODEL,
          });

          this.store.markCompleted(proposal.proposal_id, result.response, result.agent, null);
          completedIds.push(proposal.proposal_id);
          logger.info(`${itemLabel} completed`);
        } catch (err) {
          logger.error(`${itemLabel} failed error=${err}`);
          this.store.markFailed(proposal.proposal_id, String(err), "proposal-executor");
          failedIds.push(proposal.proposal_id);
        }
      }

      // Push and create combined PR if any succeeded
      if (completedIds.length > 0 && worktree) {
        const pushResult = Bun.spawnSync(
          ["git", "push", "-u", "origin", batchBranch],
          { cwd: workingDir },
        );

        if (pushResult.exitCode === 0) {
          const _prBody = completedIds
            .map(id => {
              const p = proposals.find(pp => pp.proposal_id === id);
              return `- ${p?.title ?? id} (${id})`;
            })
            .join("\n");

          const prTitle = completedIds.length === 1
            ? proposals.find(p => p.proposal_id === completedIds[0])?.title ?? "Batch proposals"
            : `Batch: ${completedIds.length} proposals`;

          const prUrl = createPrForBranch(
            batchBranch,
            prTitle,
            completedIds.join(", "),
            repoPath,
          );

          if (prUrl) {
            sharedPrUrl = prUrl;
            // Update all completed proposals with the shared PR URL
            for (const id of completedIds) {
              this.store.setPrUrl(id, prUrl);
            }
            logger.info(`${logLabel} pr_created url=${prUrl} proposals=${completedIds.length}`);
          }
        } else {
          logger.error(`${logLabel} push_failed stderr=${pushResult.stderr.toString()}`);
        }
      }

      // Emit completion events
      for (const id of completedIds) {
        const p = proposals.find(pp => pp.proposal_id === id);
        if (p) {
          this.ctx.emit("proposal:completed", {
            proposal_id: p.proposal_id,
            title: p.title,
            category: p.category,
            description: p.description,
            files_affected: p.files_affected,
            executed_by: agent,
            pr_url: sharedPrUrl,
          });
        }
      }

      logger.info(`${logLabel} batch_done completed=${completedIds.length} failed=${failedIds.length}`);
    } catch (err) {
      logger.error(`${logLabel} batch_failed error=${err}`);
      // Mark any still-executing proposals as failed
      for (const proposal of proposals) {
        const current = this.store.get(proposal.proposal_id);
        if (current?.status === "executing") {
          this.store.markFailed(proposal.proposal_id, `Batch execution failed: ${err}`, "proposal-executor");
        }
      }
      if (worktree) {
        try { cleanupWorktree(repoPath, worktree.path, worktree.branch); } catch {}
      }
    } finally {
      this.activeCount--;
      this.pickupNext().catch(err => logger.error(`[executor] Pickup failed: ${err}`));
    }
  }

  /**
   * Execute a single proposal. Handles the full lifecycle:
   * markExecuting -> delegate to agent -> review gate -> retry on FAIL -> markCompleted/markFailed -> pickup next.
   */
  async executeProposal(proposalId: string): Promise<void> {
    const logLabel = formatExecutorLogLabel(proposalId);
    const proposal = this.store.get(proposalId);
    if (!proposal || proposal.status !== "approved") {
      logger.warn(`[executor] ${logLabel} cannot_execute reason=not_found_or_not_approved`);
      return;
    }

    const executionRef = `exec-${proposalId}-${Date.now()}`;
    const claimed = this.store.markExecuting(proposalId, executionRef);
    if (!claimed) {
      logger.warn(`[executor] ${logLabel} claim_failed race=1`);
      return;
    }

    this.activeCount++;
    logger.info(`[executor] ${logLabel} executing title="${proposal.title}" slot=${this.activeCount}/${this.config.maxConcurrent}`);

    let worktree: WorktreeResult | null = null;
    const repoPath = this.ctx.resolveProposalRepoPath(proposal.files_affected);

    try {
      const agent = this.ctx.resolveProposalAgent(proposal.category, proposal.files_affected);
      const branch = proposalBranchName(proposal.proposal_id);
      const activeLogLabel = formatExecutorLogLabel(proposalId, { agent, branch });

      // Create worktree for isolated execution
      try {
        worktree = createWorktree(repoPath, branch);
        if (!worktree) {
          logger.warn(`[executor] ${activeLogLabel} worktree=create_failed fallback=prompt_branching`);
        }
      } catch (err) {
        logger.warn(`[executor] ${activeLogLabel} worktree=create_failed fallback=prompt_branching error=${err}`);
      }

      // Install skills plugin in worktree
      if (worktree) {
        try {
          generatePluginJson(worktree.path);
        } catch (err) {
          logger.warn(`[executor] ${activeLogLabel} plugin_json_failed path=${worktree.path} error=${err}`);
        }
      }

      const workingDir = worktree?.path ?? repoPath;
      const verifyConfig = resolveVerifyConfig(repoPath, this.ctx.projects);
      const qualityGateSteps = formatQualityGateSteps(verifyConfig);

      const filesInfo = proposal.files_affected.length > 0
        ? `Files to modify:\n${proposal.files_affected.map(f => `- ${repoPath}/${f}`).join("\n")}`
        : "No specific files listed.";

      // Inject learned patterns relevant to this execution
      let patternsContext = "";
      if (this.ctx.patterns) {
        const patterns = this.ctx.patterns.searchRelevant({
          agent,
          taskType: proposal.category,
          filePaths: proposal.files_affected,
        });
        const formatted = this.ctx.patterns.formatForInjection(patterns);
        if (formatted) patternsContext = `\n\n${formatted}\n`;
      }

      const gitInstructions = worktree
        ? `## Git Workflow\nWorking in isolated worktree at: ${worktree.path}\nBranch: ${branch}\n\n1. Make the changes\n${formatNumberedSteps(2, qualityGateSteps)}\n${qualityGateSteps.length + 2}. Commit (feat/fix/chore as appropriate)\n${qualityGateSteps.length + 3}. git push -u origin ${branch}\n\nCRITICAL: Do NOT push if verification fails.`
        : `## Git Workflow — follow these steps exactly:\n1. cd ${repoPath}\n2. git checkout main || git checkout master && git pull\n3. git checkout -b ${branch}\n4. Make the changes\n${formatNumberedSteps(5, qualityGateSteps)}\n${qualityGateSteps.length + 5}. If any check fails, fix the issues and re-run until all checks pass. Do NOT proceed with failures.\n${qualityGateSteps.length + 6}. Commit (feat/fix/chore as appropriate)\n${qualityGateSteps.length + 7}. git push -u origin ${branch}\n${qualityGateSteps.length + 8}. gh pr create --title "${proposal.title}" --body "Implements proposal ${proposal.proposal_id}"\n\nCRITICAL: Do NOT push if verification fails. Do NOT merge the PR.`;

      const taskMessage = `[Executing proposal ${proposal.proposal_id}]\n\n${proposal.description}\n\n${filesInfo}${patternsContext}\n\n${gitInstructions}`;

      let result = await this.ctx.processImmediate({
        channel: "system",
        sender: "proposal-executor",
        message: taskMessage,
        agent,
        cwdOverride: workingDir,
        modelOverride: DEFAULT_PROPOSAL_EXECUTION_MODEL,
      });

      // Run review gate if available
      let reviewVerdict: ReviewGateResult | null = null;
      if (this.ctx.runReview) {
        reviewVerdict = await this.ctx.runReview({
          agent, task: taskMessage, response: result.response, repoPath,
        });

        // On FAIL, retry with feedback (up to maxRetries)
        if (reviewVerdict?.verdict === "fail" && this.config.maxRetries > 0) {
          const feedback = extractFeedback(reviewVerdict);
          const retryMessage = buildRetryPrompt(taskMessage, feedback);

          logger.info(`[executor] ${activeLogLabel} review_gate=fail retry=1`);

          result = await this.ctx.processImmediate({
            channel: "system",
            sender: "proposal-executor",
            message: retryMessage,
            agent,
            cwdOverride: workingDir,
            modelOverride: DEFAULT_PROPOSAL_EXECUTION_MODEL,
          });

          // Re-run review gate on retry
          reviewVerdict = await this.ctx.runReview({
            agent, task: retryMessage, response: result.response, repoPath,
          });

          if (reviewVerdict) reviewVerdict.attempts = 2;

          // If still FAIL after retry, mark failed and return
          if (reviewVerdict?.verdict === "fail") {
            logger.warn(`[executor] ${activeLogLabel} review_gate=fail retry_exhausted=1`);
            this.store.markFailed(proposalId, `Review gate failed after retry: ${reviewVerdict.summary}`, result.agent);

            if (this.ctx.outcomes) {
              try {
                this.ctx.outcomes.record({
                  proposal_id: proposalId,
                  trace_id: executionRef,
                  agent: result.agent,
                  task_type: proposal.category,
                  review_verdict: "fail",
                  retry_count: 1,
                  outcome: "failed",
                  failure_reason: `Review gate failed after retry: ${reviewVerdict.summary}`,
                });
              } catch { /* don't let outcome recording block cleanup */ }
            }

            return;
          }
        }
      }

      // Run verification (test/build) if configured for this project
      if (verifyConfig) {
        const verification = await runVerification(workingDir, verifyConfig);
        if (!verification.passed) {
          const failedSteps = verification.steps.filter(s => !s.passed);
          const summary = failedSteps.map(s => `${s.name}: ${s.output.slice(0, 500)}`).join("\n\n");
          logger.warn(`[executor] ${activeLogLabel} verification=failed steps=${failedSteps.map(s => s.name).join(",")}`);

          this.store.markFailed(proposalId, `Verification failed:\n${summary}`, result.agent);

          if (this.ctx.outcomes) {
            try {
              this.ctx.outcomes.record({
                proposal_id: proposalId,
                trace_id: executionRef,
                agent: result.agent,
                task_type: proposal.category,
                review_verdict: reviewVerdict?.verdict ?? null,
                retry_count: reviewVerdict?.attempts ? reviewVerdict.attempts - 1 : 0,
                outcome: "failed",
                failure_reason: `Verification failed: ${failedSteps.map(s => s.name).join(", ")}`,
                verification_passed: false,
              });
            } catch { /* don't block cleanup */ }
          }

          return;
        }
        logger.info(`[executor] ${activeLogLabel} verification=passed steps=${verification.steps.map(s => s.name).join(",")}`);
      }

      // Collect actual artifacts produced by the execution
      let prUrl = extractPrUrl(result.response);
      if (!prUrl) {
        prUrl = createPrForBranch(branch, proposal.title, proposal.proposal_id, repoPath);
        if (prUrl) {
          logger.info(`[executor] ${activeLogLabel} pr_url=recovered value=${prUrl}`);
        }
      }

      const hasCommits = branchHasNewCommits(branch, repoPath);

      // Build evidence-based artifact map.
      // If verification ran and we got here, it passed (failures return early above).
      // Evidence carries provenance: scope, command, exit code, branch.
      const actualArtifacts: Partial<Record<ArtifactKind, boolean | ArtifactEvidence>> = {
        commit: { present: hasCommits, scope: repoPath, branch },
        pr: { present: !!prUrl, ref: prUrl ?? undefined },
        test_pass: verifyConfig?.test_command
          ? { present: true, scope: workingDir, command: verifyConfig.test_command, exit_code: 0, branch }
          : true, // no verification configured — can't falsify
        type_check: verifyConfig?.build_command
          ? { present: true, scope: workingDir, command: verifyConfig.build_command, exit_code: 0, branch }
          : true, // no verification configured — can't falsify
      };

      // Validate artifacts against category expectations
      const artifactResult = validateArtifacts(proposal.category, actualArtifacts);
      if (!artifactResult.passed) {
        const missingDesc = artifactResult.missing.map(m => m.kind).join(", ");
        logger.warn(`[executor] ${activeLogLabel} artifact_check=failed missing=${missingDesc}`);
        this.store.markFailed(proposalId, `Missing required artifacts: ${missingDesc}`, result.agent);

        if (this.ctx.outcomes) {
          try {
            this.ctx.outcomes.record({
              proposal_id: proposalId,
              trace_id: executionRef,
              agent: result.agent,
              task_type: proposal.category,
              review_verdict: reviewVerdict?.verdict ?? null,
              retry_count: reviewVerdict?.attempts ? reviewVerdict.attempts - 1 : 0,
              outcome: "failed",
              failure_reason: `Missing required artifacts: ${missingDesc}`,
              verification_passed: !!verifyConfig, // if we got here, verification either passed or didn't run
            });
          } catch { /* don't block cleanup */ }
        }

        return;
      }

      logger.info(`[executor] ${activeLogLabel} artifact_check=passed artifacts=${artifactResult.checks.filter(c => c.present).map(c => c.kind).join(",")}`);
      this.store.markCompleted(proposalId, result.response, result.agent, prUrl);

      // Record outcome
      if (this.ctx.outcomes) {
        try {
          this.ctx.outcomes.record({
            proposal_id: proposalId,
            trace_id: executionRef,
            agent: result.agent,
            task_type: proposal.category,
            review_verdict: reviewVerdict?.verdict ?? null,
            retry_count: reviewVerdict?.attempts ? reviewVerdict.attempts - 1 : 0,
            pr_url: prUrl ?? null,
            outcome: "success",
            verification_passed: verifyConfig ? true : null,
          });
        } catch (err) {
          logger.warn(`[executor] ${activeLogLabel} outcome_record_failed error=${err}`);
        }
      }

      this.ctx.emit("proposal:completed", {
        proposal_id: proposal.proposal_id,
        title: proposal.title,
        category: proposal.category,
        description: proposal.description,
        files_affected: proposal.files_affected,
        executed_by: result.agent,
        response_excerpt: result.response.slice(0, 2000),
        pr_url: prUrl ?? null,
        review_verdict: reviewVerdict?.verdict ?? null,
      });

      logger.info(`[executor] ${activeLogLabel} completed=1${prUrl ? ` pr=${prUrl}` : ""}${reviewVerdict ? ` review=${reviewVerdict.verdict}` : ""}`);
    } catch (err) {
      logger.error(`[executor] ${logLabel} failed error=${err}`);
      this.store.markFailed(proposalId, String(err), "proposal-executor");

      // Clean up worktree on failure
      if (worktree) {
        try {
          cleanupWorktree(repoPath, worktree.path, worktree.branch);
        } catch { /* best-effort cleanup */ }
      }

      if (this.ctx.outcomes) {
        try {
          this.ctx.outcomes.record({
            proposal_id: proposalId,
            trace_id: executionRef,
            agent: "proposal-executor",
            task_type: proposal?.category ?? "unknown",
            outcome: "failed",
            failure_reason: String(err),
          });
        } catch { /* don't let outcome recording prevent cleanup */ }
      }
    } finally {
      this.activeCount--;
      // Try to pick up next queued proposal
      this.pickupNext().catch(err => logger.error(`[executor] Pickup failed: ${err}`));
    }
  }
}

/** Check if a proposal branch has new commits vs its parent (main/master). */
function branchHasNewCommits(branch: string, repoPath: string): boolean {
  try {
    // Check branch exists — if git fails entirely (not a repo, etc.), assume OK
    const branchCheck = Bun.spawnSync(["git", "rev-parse", "--verify", branch], { cwd: repoPath });
    if (branchCheck.exitCode !== 0) {
      // Branch doesn't exist OR not a git repo — only fail if we can confirm it's a git repo
      const gitCheck = Bun.spawnSync(["git", "rev-parse", "--git-dir"], { cwd: repoPath });
      if (gitCheck.exitCode !== 0) return true; // Not a git repo, can't validate — allow
      return false; // Git works but branch doesn't exist
    }

    // Find the merge base with main/master
    const base = Bun.spawnSync(["git", "merge-base", branch, "HEAD"], { cwd: repoPath });
    if (base.exitCode !== 0) return true; // Can't determine base — allow

    const mergeBase = base.stdout.toString().trim();
    const branchTip = Bun.spawnSync(["git", "rev-parse", branch], { cwd: repoPath });
    if (branchTip.exitCode !== 0) return true; // Can't read tip — allow

    // If branch tip === merge base, no new commits
    return branchTip.stdout.toString().trim() !== mergeBase;
  } catch {
    return true; // If we can't check, don't block
  }
}

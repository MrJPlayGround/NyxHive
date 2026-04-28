import { logger } from "../utils/logger.js";
import { formatError } from "../utils/error.js";
import { resolveNotificationTarget } from "../notifications/routing.js";
import type { AgentAction } from "../agents/actor.js";
import type { AgentRegistry } from "../agents/registry.js";
import type { KnowledgeStore } from "../memory/knowledge.js";
import type { EmbeddingProvider } from "../memory/embeddings.js";
import type { AgentConfig, NyxHiveConfig, TeamConfig } from "../types.js";
import type { Channel } from "../channels/types.js";
import type { Scheduler, ScheduledTask } from "../scheduler/index.js";
import type { ProposalStore, Proposal, ProposalCategory, ProposalEffort, ProposalAutonomy } from "../proposals/store.js";
import type { MemoryStore } from "../memory/store.js";
import type { QueueDB } from "./db.js";
import type { DevPlanStore } from "../development/plan.js";
import type { DevLoopProcessor } from "../development/loop.js";
import { chunkMarkdown } from "../memory/ingest.js";
import { buildObsidianNote, extractTags, detectWikiLinks, getVaultNoteTitles } from "../memory/obsidian.js";
import { executeDevPlan } from "../development/loop.js";
import { extractPrUrl, proposalBranchName } from "../proposals/pr-utils.js";
import { DEFAULT_PROPOSAL_EXECUTION_MODEL } from "../proposals/model-policy.js";

/** Detect if [@learn:] content is a decision based on keywords. */
const DECISION_PATTERNS = /\b(decided|agreed|chose|chosen|went with|we will|approved)\b|(?:^|\s)(decision:|rationale:)/im;
function detectLearningCategory(content: string): string {
  if (DECISION_PATTERNS.test(content)) return "decisions";
  return "learnings";
}

/**
 * Narrow interface for what ManagementActionExecutor needs from the processor.
 */
export interface ManagementContext extends DevLoopProcessor {
  registry: AgentRegistry | undefined;
  knowledge: KnowledgeStore | undefined;
  embedder: EmbeddingProvider | undefined;
  nyxhiveConfig: NyxHiveConfig | undefined;
  teams: Record<string, TeamConfig> | undefined;
  getAgent(key: string): AgentConfig | undefined;
  emit(type: string, data: Record<string, unknown>): void;
  resolveProposalAgent(category: string, filesAffected: string[]): string;
  resolveReviewAgent(preferredAgents?: string[]): string;
  resolveProposalReviewModel(preferredAgents?: string[], requestedModel?: string): string;
  resolveProposalRepoPath(filesAffected: string[]): string;
  scheduler: Scheduler | undefined;
  channels: Channel[] | undefined;
  devPlanStore: DevPlanStore | undefined;
  proposalStore: ProposalStore | undefined;
  queue: QueueDB;
  memory: MemoryStore | undefined;
}

type ManagementActionOrigin = {
  channel: string;
  senderId: string;
  messageId?: string;
};

/**
 * Executes management actions (hire, fire, reassign, schedule, alert, develop, learn, propose)
 * extracted from QueueProcessor to reduce its size.
 */
export class ManagementActionExecutor {
  private alertCounts: Map<string, { count: number; resetAt: number }> = new Map();

  async execute(
    actions: AgentAction[],
    agentKey: string,
    ctx: ManagementContext,
    origin?: ManagementActionOrigin,
  ): Promise<string[]> {
    const registry = ctx.registry;
    if (!registry) return ["[Management actions unavailable: no registry]"];

    const entry = registry.getEntry(agentKey);
    const canManage = entry?.role === "orchestrator" || entry?.role === "lead";

    // propose and learn are allowed from any agent; everything else requires lead/coordinator permissions
    const OPEN_ACTIONS = new Set(["propose", "learn"]);
    const hasRestrictedActions = actions.some(a => !OPEN_ACTIONS.has(a.type));
    if (hasRestrictedActions && !canManage) {
      // Execute only the open actions, skip the rest
      const openActions = actions.filter(a => OPEN_ACTIONS.has(a.type));
      const skippedTypes = actions.filter(a => !OPEN_ACTIONS.has(a.type)).map(a => a.type);
      if (openActions.length === 0) {
        return [`[Management actions ignored: ${agentKey} is not a lead/coordinator agent]`];
      }
      const results = await this.executeActions(openActions, agentKey, ctx, origin);
      if (skippedTypes.length > 0) {
        results.push(`[Skipped ${skippedTypes.join(", ")}: requires lead/coordinator permissions]`);
      }
      return results;
    }

    return this.executeActions(actions, agentKey, ctx, origin);
  }

  private async executeActions(
    actions: AgentAction[],
    agentKey: string,
    ctx: ManagementContext,
    origin?: ManagementActionOrigin,
  ): Promise<string[]> {
    const registry = ctx.registry;
    if (!registry) return ["[Management actions unavailable: no registry]"];
    const results: string[] = [];

    for (const action of actions) {
      switch (action.type) {
        case "hire": {
          const { key, name, provider, model, prompt } = action.params;
          if (!key || !name) {
            results.push("[hire failed: key and name required]");
            break;
          }
          const result = registry.create(key, {
            name,
            provider: provider || undefined,
            model: model || undefined,
            system_prompt: prompt || undefined,
          }, agentKey);
          if (result.success) {
            const created = registry.getEntry(key);
            results.push(`[Hired ${name} (@${key}) on ${created?.provider}/${created?.model}]`);
          } else {
            results.push(`[hire failed: ${result.error}]`);
          }
          break;
        }

        case "fire": {
          const key = action.params.key;
          if (!key) { results.push("[fire failed: key required]"); break; }
          const result = registry.disable(key);
          results.push(result.success ? `[Fired @${key}]` : `[fire failed: ${result.error}]`);
          break;
        }

        case "reassign": {
          const { key, model, provider } = action.params;
          if (!key || !model) { results.push("[reassign failed: key and model required]"); break; }
          const updates: Record<string, string> = { model };
          if (provider) updates.provider = provider;
          const result = registry.update(key, updates);
          results.push(result.success
            ? `[Reassigned @${key} to ${provider ? `${provider}/` : ""}${model}]`
            : `[reassign failed: ${result.error}]`);
          break;
        }

        case "team": {
          const { name, agents: agentList } = action.params;
          if (!name || !agentList) { results.push("[team failed: name and agents required]"); break; }
          const agentKeys = agentList.split(",").map((a: string) => a.trim());
          if (ctx.teams) {
            ctx.teams[name] = { name, agents: agentKeys };
            results.push(`[Team '${name}' set to: ${agentKeys.join(", ")}]`);
          } else {
            results.push("[team failed: teams not configured]");
          }
          break;
        }

        case "schedule": {
          if (!ctx.scheduler) { results.push("[schedule failed: scheduler not available]"); break; }
          const { name: schedName, cron, run_at, agent: schedAgent, prompt: schedPrompt, tier } = action.params;
          if (!schedName || !schedAgent || !schedPrompt) {
            results.push("[schedule failed: name, agent, and prompt required]");
            break;
          }
          if (!ctx.getAgent(schedAgent)) {
            results.push(`[schedule failed: agent '${schedAgent}' not found]`);
            break;
          }
          try {
            ctx.scheduler.addTask({
              name: schedName,
              cron_expression: cron || undefined,
              run_at: run_at ? Number(run_at) : undefined,
              agent: schedAgent,
              prompt: schedPrompt,
              created_by: agentKey,
            });
            results.push(`[Scheduled '${schedName}' (${cron ? `cron: ${cron}` : "one-shot"}) on @${schedAgent}${tier === "premium" ? " [premium]" : ""}]`);
          } catch (err) {
            results.push(`[schedule failed: ${formatError(err)}]`);
          }
          break;
        }

        case "unschedule": {
          if (!ctx.scheduler) { results.push("[unschedule failed: scheduler not available]"); break; }
          const targetName = action.params.key || action.params.id;
          if (!targetName) { results.push("[unschedule failed: name or id required]"); break; }
          const allTasks = ctx.scheduler.listTasks(true);
          const target = allTasks.find((t: ScheduledTask) => t.name === targetName || t.id === targetName);
          if (!target) {
            results.push(`[unschedule failed: task '${targetName}' not found]`);
            break;
          }
          if (target.created_by === "config") {
            results.push(`[unschedule failed: '${target.name}' is config-protected]`);
          } else if (target.created_by === "system") {
            ctx.scheduler.updateTask(target.id, { enabled: false });
            results.push(`[Disabled '${target.name}' (returns on restart)]`);
          } else {
            ctx.scheduler.deleteTask(target.id);
            results.push(`[Unscheduled '${target.name}']`);
          }
          break;
        }

        case "alert": {
          const alertMsg = action.params.message;
          if (!alertMsg) { results.push("[alert failed: message required]"); break; }
          if (alertMsg.length > 2000) { results.push("[alert failed: message exceeds 2000 chars]"); break; }

          const now = Date.now();
          const hourKey = "alerts";
          const alertState = this.alertCounts.get(hourKey) ?? { count: 0, resetAt: now + 3600_000 };
          if (now > alertState.resetAt) { alertState.count = 0; alertState.resetAt = now + 3600_000; }
          if (alertState.count >= 10) {
            results.push("[alert rate-limited: max 10 per hour]");
            break;
          }
          alertState.count++;
          this.alertCounts.set(hourKey, alertState);

          const explicitTarget = action.params.channel && action.params.recipient
            ? { channel: action.params.channel, recipient: action.params.recipient }
            : null;
          const alertTarget = explicitTarget
            ?? (ctx.nyxhiveConfig ? resolveNotificationTarget(ctx.nyxhiveConfig, "alerts") : null);
          const alertChannel = alertTarget?.channel;
          const alertRecipient = alertTarget?.recipient;

          if (!alertChannel || !alertRecipient) {
            results.push("[alert failed: no channel/recipient specified and no owner configured]");
            break;
          }

          const ch = ctx.channels?.find((c: Channel) => c.name.toLowerCase() === alertChannel!.toLowerCase());
          if (ch?.sendOutbound) {
            try {
              await ch.sendOutbound(alertRecipient, alertMsg);
              results.push(`[Alert sent via ${ch.name}]`);
            } catch (err) {
              results.push(`[alert failed: ${formatError(err)}]`);
            }
          } else {
            const fallback = ctx.channels?.find((c: Channel) => !!c.sendOutbound);
            if (fallback?.sendOutbound) {
              try {
                await fallback.sendOutbound(alertRecipient, alertMsg);
                results.push(`[Alert sent via ${fallback.name} (fallback)]`);
              } catch (err) {
                results.push(`[alert failed: ${formatError(err)}]`);
              }
            } else {
              logger.warn(`[processor] Alert could not be delivered: channel '${alertChannel}' not available`);
              results.push(`[alert logged but not delivered: channel '${alertChannel}' unavailable]`);
            }
          }

          if (alertChannel?.toLowerCase() !== "ios") {
            const iosCh = ctx.channels?.find((c: Channel) => c.name === "ios");
            if (iosCh?.sendOutbound) {
              try {
                await iosCh.sendOutbound("ios:system", alertMsg);
                ctx.emit("agent:outbound", { channel: "ios:system", agent: agentKey, message: alertMsg.substring(0, 200), source: "alert" });
              } catch (err) {
                logger.debug(`[management] iOS alert delivery failed (best-effort): ${formatError(err)}`);
              }
            }
          }
          break;
        }

        case "develop": {
          if (!ctx.devPlanStore || !ctx.registry) {
            results.push("[develop failed: dev plan store or registry not available]");
            break;
          }
          const feature = action.params.feature;
          const devAgent = action.params.agent;
          const branch = action.params.branch;
          if (!feature || !devAgent) {
            results.push("[develop failed: feature and agent required]");
            break;
          }
          if (!ctx.registry.get(devAgent)) {
            results.push(`[develop failed: agent '${devAgent}' not found]`);
            break;
          }
          const plan = ctx.devPlanStore.createPlan({
            feature,
            branch: branch || `feat/${feature.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}`,
            agent: devAgent,
            createdBy: agentKey,
            checks: action.params.checks ? action.params.checks.split(",").map((c: string) => c.trim()) : undefined,
          });

          if (action.params.stories) {
            const storyTitles = action.params.stories.split(/,\s*\d+\.\s*|\d+\.\s*/).filter(Boolean);
            ctx.devPlanStore.addStories(plan.id, storyTitles.map((t: string) => ({ title: t.trim() })));
          }

          ctx.devPlanStore.updatePlanStatus(plan.id, "running");
          executeDevPlan(plan.id, {
            planStore: ctx.devPlanStore,
            processor: ctx,
            registry: ctx.registry,
            memory: ctx.memory,
            config: ctx.nyxhiveConfig!,
          }).catch(err => logger.error(`[dev-loop] Plan ${plan.id} crashed: ${err}`));

          results.push(`[Dev plan '${plan.id}' created for "${feature}" on branch ${plan.branch}, assigned to @${devAgent}]`);
          break;
        }

        case "dev-pause": {
          if (!ctx.devPlanStore) { results.push("[dev-pause failed: dev plan store not available]"); break; }
          const pauseId = action.params.key || action.params.id;
          if (!pauseId) { results.push("[dev-pause failed: plan id required]"); break; }
          const pausePlan = ctx.devPlanStore.getPlan(pauseId);
          if (!pausePlan) { results.push(`[dev-pause failed: plan '${pauseId}' not found]`); break; }
          if (pausePlan.status !== "running") { results.push(`[dev-pause failed: plan is ${pausePlan.status}, not running]`); break; }
          ctx.devPlanStore.updatePlanStatus(pauseId, "paused");
          results.push(`[Dev plan '${pauseId}' paused]`);
          break;
        }

        case "dev-resume": {
          if (!ctx.devPlanStore || !ctx.registry) { results.push("[dev-resume failed: dev plan store or registry not available]"); break; }
          const resumeId = action.params.key || action.params.id;
          if (!resumeId) { results.push("[dev-resume failed: plan id required]"); break; }
          const resumePlan = ctx.devPlanStore.getPlan(resumeId);
          if (!resumePlan) { results.push(`[dev-resume failed: plan '${resumeId}' not found]`); break; }
          if (resumePlan.status !== "paused") { results.push(`[dev-resume failed: plan is ${resumePlan.status}, not paused]`); break; }
          ctx.devPlanStore.updatePlanStatus(resumeId, "running");
          executeDevPlan(resumeId, {
            planStore: ctx.devPlanStore,
            processor: ctx,
            registry: ctx.registry,
            memory: ctx.memory,
            config: ctx.nyxhiveConfig!,
          }).catch(err => logger.error(`[dev-loop] Plan ${resumeId} crashed: ${err}`));
          results.push(`[Dev plan '${resumeId}' resumed]`);
          break;
        }

        case "dev-skip": {
          if (!ctx.devPlanStore) { results.push("[dev-skip failed: dev plan store not available]"); break; }
          const skipPlanId = action.params.key || action.params.id;
          const skipStoryId = action.params.story;
          if (!skipPlanId || !skipStoryId) { results.push("[dev-skip failed: plan id and story id required]"); break; }
          ctx.devPlanStore.skipStory(skipStoryId);
          results.push(`[Story '${skipStoryId}' skipped in plan '${skipPlanId}']`);
          break;
        }

        case "learn": {
          const content = action.params.content;
          if (!content) { results.push("[learn failed: content required]"); break; }

          const category = action.params.category || detectLearningCategory(content);
          const isDecision = category === "decisions";
          const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
          const slug = content.slice(0, 40).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "");
          const filename = `${timestamp}-${slug}.md`;
          const title = content.slice(0, 80);

          const vaultPath = ctx.nyxhiveConfig?.vault?.path;
          if (vaultPath) {
            const { join } = await import("node:path");
            const { mkdirSync, writeFileSync, existsSync } = await import("node:fs");

            const existingTitles = getVaultNoteTitles(vaultPath, ctx.nyxhiveConfig?.vault?.skip_dirs);
            const linkedContent = detectWikiLinks(content, existingTitles);
            const tags = extractTags(content, category, existingTitles);

            const markdown = buildObsidianNote({
              title,
              content: linkedContent,
              category,
              tags,
              sourceAgent: agentKey,
              relatedNotes: [...existingTitles].filter(t =>
                content.toLowerCase().includes(t.toLowerCase()) && t.length >= 3
              ).slice(0, 5),
            });

            const dir = join(vaultPath, "Learnings", category);
            if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
            const filePath = join(dir, filename);
            writeFileSync(filePath, markdown, "utf-8");
            logger.info(`[learn] Wrote ${filePath}`);

            if (ctx.knowledge && ctx.embedder) {
              const sourcePath = `Learnings/${category}/${filename}`;
              const chunks = chunkMarkdown(title, markdown, category, sourcePath);
              for (const chunk of chunks) {
                const embedding = await ctx.embedder.embed(chunk.prefixed);
                ctx.knowledge.upsertChunk(
                  chunk.title, chunk.section, chunk.content, chunk.category,
                  chunk.sourcePath, chunk.contentHash, embedding,
                  undefined, isDecision ? 3 : 2,
                  undefined, undefined, undefined,
                  isDecision ? "accepted" : undefined,
                );
              }
              results.push(`[Learned and ingested: "${content.slice(0, 60)}${content.length > 60 ? "..." : ""}" (${category})]`);
            } else {
              results.push(`[Learned: "${content.slice(0, 60)}${content.length > 60 ? "..." : ""}" -- saved to vault, pending ingestion]`);
            }
          } else if (ctx.knowledge && ctx.embedder) {
            const markdown = buildObsidianNote({ title, content, category, sourceAgent: agentKey });
            const sourcePath = `learnings/${category}/${filename}`;
            const chunks = chunkMarkdown(title, markdown, category, sourcePath);
            for (const chunk of chunks) {
              const embedding = await ctx.embedder.embed(chunk.prefixed);
              ctx.knowledge.upsertChunk(
                chunk.title, chunk.section, chunk.content, chunk.category,
                chunk.sourcePath, chunk.contentHash, embedding,
                undefined, isDecision ? 3 : 2,
                undefined, undefined, undefined,
                isDecision ? "accepted" : undefined,
              );
            }
            results.push(`[Learned and ingested: "${content.slice(0, 60)}${content.length > 60 ? "..." : ""}" (${category})]`);
          } else {
            results.push("[learn failed: no vault path or knowledge store configured]");
          }
          break;
        }

        case "batch-approve": {
          if (!ctx.proposalStore) {
            results.push("[batch-approve failed: proposal store not available]");
            break;
          }
          const batchResult = ctx.proposalStore.batchApprove({
            category: action.params.category as ProposalCategory | undefined,
            maxAutonomy: action.params.max_autonomy as ProposalAutonomy | undefined,
            approvedBy: agentKey,
          });
          if (batchResult.count > 0) {
            results.push(`[Batch-approved ${batchResult.count} proposals]`);
          } else {
            results.push("[Batch-approve: no matching proposals found]");
          }
          break;
        }

        case "batch-reject": {
          if (!ctx.proposalStore) {
            results.push("[batch-reject failed: proposal store not available]");
            break;
          }
          const reason = action.params.reason;
          if (!reason) {
            results.push("[batch-reject failed: reason required]");
            break;
          }
          const olderThanMs = action.params.older_than_days
            ? Number(action.params.older_than_days) * 24 * 60 * 60 * 1000
            : undefined;
          const rejectResult = ctx.proposalStore.batchReject({
            category: action.params.category as ProposalCategory | undefined,
            olderThanMs,
            reason,
          });
          if (rejectResult.count > 0) {
            results.push(`[Batch-rejected ${rejectResult.count} proposals: ${reason}]`);
          } else {
            results.push("[Batch-reject: no matching proposals found]");
          }
          break;
        }

        case "propose": {
          if (!ctx.proposalStore) {
            results.push("[propose failed: proposal store not available]");
            break;
          }
          const { description, category, effort, priority, files, source } = action.params;
          // Derive title from description if not provided (agents sometimes use multi-line format without explicit title)
          const title = action.params.title || (description ? description.split(/[.\n]/)[0].slice(0, 80) : "");
          if (!title || !description) {
            logger.warn(`[proposals] Propose failed: title=${JSON.stringify(title)}, description=${JSON.stringify(description?.slice(0, 80))}, raw params=${JSON.stringify(action.params)}`);
            results.push("[propose failed: title and description required]");
            break;
          }

          const similar = ctx.proposalStore.findSimilar(title, description);
          if (similar) {
            logger.info(`[proposals] Blocked similar: "${title}" matches "${similar.proposal.title}" (similarity: ${similar.similarity.toFixed(2)})`);
            results.push(`[propose skipped: similar to ${similar.proposal.proposal_id} "${similar.proposal.title}"]`);
            break;
          }

          const { classifyAutonomy } = await import("../proposals/autonomy.js");
          const { evaluateProposalDecision } = await import("../proposals/decision-policy.js");
          let filesArray: string[] = [];
          if (files) {
            const trimmed = files.trim();
            if (trimmed.startsWith("[")) {
              try { filesArray = JSON.parse(trimmed); } catch { filesArray = trimmed.replace(/[\[\]"]/g, "").split(",").map((f: string) => f.trim()); }
            } else {
              filesArray = trimmed.split(",").map((f: string) => f.trim());
            }
          }
          const autonomy = classifyAutonomy(
            (category ?? "improvement") as ProposalCategory,
            (effort ?? "medium") as ProposalEffort,
            filesArray,
          );
          const proposalDecision = evaluateProposalDecision({
            title,
            description,
            category: (category ?? "improvement") as ProposalCategory,
            priority: (priority ?? "medium") as "low" | "medium" | "high",
            effort: (effort ?? "small") as ProposalEffort,
            files: filesArray,
          });
          if (!proposalDecision.shouldCreate) {
            logger.info(`[proposals] Skipped "${title}" — ${proposalDecision.reason}`);
            results.push(`[propose skipped: ${proposalDecision.reason}; suggested lane=${proposalDecision.suggestedLane}]`);
            break;
          }

          const proposal = ctx.proposalStore.create({
            title,
            description,
            category: (category ?? "improvement") as ProposalCategory,
            priority: (priority ?? "medium") as "low" | "medium" | "high",
            effort: (effort ?? "medium") as ProposalEffort,
            files_affected: filesArray,
            thread_id: origin?.channel === "gateway" ? origin.senderId : null,
            proposed_by: agentKey,
            scout_source: source ?? null,
            autonomy,
          });

          if (autonomy === "auto") {
            logger.info(`[processor] Auto-executing proposal ${proposal.proposal_id}: "${title}"`);
            ctx.proposalStore.markExecuting(proposal.proposal_id, `direct-${proposal.proposal_id}`);
            const execAgent = ctx.resolveProposalAgent(category ?? "improvement", filesArray);
            const repoPath = ctx.resolveProposalRepoPath(filesArray);
            const branch = proposalBranchName(proposal.proposal_id);
            const filesInfo = filesArray.length > 0
              ? `Files to modify:\n${filesArray.map((f: string) => `- ${repoPath}/${f}`).join("\n")}`
              : "No specific files listed.";
            try {
              const result = await ctx.processImmediate({
                channel: "system",
                sender: "proposal-system",
                message: `[Auto-approved proposal ${proposal.proposal_id}]\n\n${description}\n\n${filesInfo}\n\nWorking directory: ${repoPath}\n\n## Git Workflow — follow these steps:\n1. cd ${repoPath}\n2. git checkout main || git checkout master && git pull\n3. git checkout -b ${branch}\n4. Make the changes\n5. Commit (feat/fix/chore as appropriate)\n6. git push -u origin ${branch}\n7. gh pr create --title "${title}" --body "Implements proposal ${proposal.proposal_id}"\n\nDo NOT merge the PR. Create it and report the PR URL.`,
                agent: execAgent,
                trust: "system",
                modelOverride: DEFAULT_PROPOSAL_EXECUTION_MODEL,
              });
              const prUrl = extractPrUrl(result.response);
              ctx.proposalStore.markCompleted(proposal.proposal_id, result.response, result.agent, prUrl);

              // Emit proposal:completed for learning listeners
              ctx.emit("proposal:completed", {
                proposal_id: proposal.proposal_id,
                title,
                category: category ?? "improvement",
                description,
                files_affected: filesArray as string[],
                executed_by: result.agent,
                response_excerpt: result.response.slice(0, 2000),
                pr_url: prUrl ?? null,
              });

              results.push(`[Proposal ${proposal.proposal_id} auto-executed: "${title}"${prUrl ? ` — PR: ${prUrl}` : ""}]`);
            } catch (err) {
              ctx.proposalStore!.markFailed(proposal.proposal_id, String(err), execAgent);
              results.push(`[Proposal ${proposal.proposal_id} auto-execution failed: ${err}]`);
            }
          } else {
            // Auto-review: immediately move to reviewing and fire lightweight review
            const store = ctx.proposalStore!;
            if (!store.markReviewing(proposal.proposal_id)) {
              results.push(`[Proposal ${proposal.proposal_id} auto-review skipped: already reviewing or no longer reviewable]`);
              continue;
            }
            (async () => {
              try {
                const reviewAgent = ctx.resolveReviewAgent(["nyx", "analyst"]);
                const active = store.list({ status: "proposed" });
                const existingContext = active.length > 0
                  ? `\nExisting proposals:\n${active.map((p: Proposal) => `- ${p.proposal_id}: "${p.title}" (${p.category}, ${p.effort})`).join("\n")}`
                  : "";

                const reviewPrompt = `You are reviewing a proposal for User's NyxHive system. Be brutally concise.

Title: ${title}
Category: ${category ?? "improvement"}
Priority: ${priority ?? "medium"}
Effort: ${effort ?? "medium"}
Description: ${description}
Files: ${files ?? "none"}
Proposed by: ${agentKey}
${existingContext}

If the proposal has minor issues (bad title, unclear description, wrong category/effort), fix them yourself. Don't flag issues you can fix.

Respond with EXACTLY this format (no other text):

VERDICT: DO | SKIP | MERGE
REASON: <1 sentence why>
EFFORT: <your corrected estimate: trivial/small/medium/large>
OVERLAPS: <proposal-id if this overlaps an existing proposal, or "none">
CORRECTED TITLE: <only if title needs fixing, otherwise omit this line>
CORRECTED DESCRIPTION: <only if description needs fixing, otherwise omit this line>
CORRECTED CATEGORY: <only if wrong: maintenance/feature/bugfix/improvement, otherwise omit>`;

                const result = await ctx.processImmediate({
                  channel: "system",
                  sender: `auto-review:${proposal.proposal_id}`,
                  message: reviewPrompt,
                  agent: reviewAgent,
                  trust: "system",
                  modelOverride: ctx.resolveProposalReviewModel(["nyx", "analyst"]),
                });
                store.saveReview(proposal.proposal_id, result.response, "auto-review");
              } catch (err) {
                store.saveReview(proposal.proposal_id, `Auto-review failed: ${err}`, "system");
              }
            })();

            // Send rich proposal notifications to owner via configured channels
            const ownerChannel = ctx.nyxhiveConfig?.daemon?.owner_channel;
            const ownerId = ctx.nyxhiveConfig?.daemon?.owner_id;

            if (ctx.channels && ownerId) {
              for (const ch of ctx.channels) {
                // Use rich notifications for channels that support it
                if (ch.sendProposalNotification) {
                  const targetRecipient = (ownerChannel?.toLowerCase() === ch.name) ? ownerId : null;
                  if (!targetRecipient) continue;
                  try {
                    if (ch.sendProposalNotification) {
                      await ch.sendProposalNotification(targetRecipient, proposal);
                    } else if (ch.sendOutbound) {
                      const { formatProposalPlainText } = await import("../proposals/notifications.js");
                      await ch.sendOutbound(targetRecipient, formatProposalPlainText(proposal));
                    }
                  } catch (err) {
                    logger.debug(`[management] Proposal notification to ${ch.name} failed: ${formatError(err)}`);
                  }
                }
              }

              // Also send to iOS (plain text, always best-effort)
              const iosCh = ctx.channels.find((c: Channel) => c.name === "ios");
              if (iosCh?.sendOutbound) {
                try {
                  const { formatProposalPlainText } = await import("../proposals/notifications.js");
                  await iosCh.sendOutbound("ios:system", formatProposalPlainText(proposal));
                } catch (err) {
                  logger.debug(`[management] Proposal iOS delivery failed: ${formatError(err)}`);
                }
              }
            }

            ctx.emit("proposal:created", {
              message_id: origin?.messageId,
              channel: origin?.channel,
              sender_id: origin?.senderId,
              threadId: proposal.thread_id ?? undefined,
              proposal_id: proposal.proposal_id,
              title: proposal.title,
              description: proposal.description,
              category: proposal.category,
              autonomy: proposal.autonomy,
              priority: proposal.priority,
              effort: proposal.effort,
              files_affected: proposal.files_affected,
              proposed_by: proposal.proposed_by,
            });

            results.push(`[Proposal ${proposal.proposal_id} created: "${title}" — awaiting approval]`);
          }
          break;
        }
      }
    }

    return results;
  }
}

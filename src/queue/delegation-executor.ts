/**
 * Delegation execution logic: turn processing, parallel dispatch, mention resolution,
 * envelope building. Extracted from DelegationEngine for module size management.
 */

/**
 * Per-agent concurrency cap: limits how many simultaneous delegations can target
 * the same agent across all active conversations. Prevents orchestrators from
 * flooding a single agent with more work than it can handle concurrently.
 */
const MAX_CONCURRENT_DELEGATIONS_PER_AGENT = 3;
import { logger } from "../utils/logger.js";
import { extractMessageEssence } from "../context/summarize.js";
import { trimTextToTokenBudget } from "../context/token-discipline.js";
import { invokeAgent, type CLIProgress } from "../agents/invoke.js";
import type { AgentConfig, InvocationResult, ActorMention, DelegationRun, DelegationRunEnvironment, DelegationRunFileTouch, DelegationRunStatus } from "../types.js";
import { ACTOR_MAX_DEPTH, ACTOR_MAX_MESSAGES, AGENT_TIMEOUT_MS, getBudgetConfig, resolveModelHint, hintToModelTier, getBillingType } from "../defaults.js";
import { parseActorMentions, parseAgentActions, parseFollowups, parseBtwTags, parseSteerTags, } from "../agents/actor.js";
import { extractContracts } from "../agents/contract-extractor.js";
import { dispatchToInstance } from "../agents/dispatch.js";
import { formatError } from "../utils/error.js";
import { existsSync, readFileSync } from "node:fs";
import { join, basename, isAbsolute } from "node:path";
import { loadAndCompileSoul, resolveModel } from "../soul/runtime.js";
import { injectModelContext } from "../soul/compiler.js";
import { mergeRetrievalTraces } from "../memory/retrieval-trace.js";
import { runReviewGate, formatReviewAnnotation, type ReviewGateContext } from "./review-gate.js";
import type { DelegationContext } from "./delegation.js";
import { DELEGATION_COST_CEILING_USD } from "./delegation.js";
import type { RoutingStore } from "../memory/routing.js";
import type { RelayOriginContext } from "../types.js";
import { randomUUID } from "node:crypto";
import { buildRunContextNote, deriveRunResult, resolveRunBrain } from "../runs/result.js";
import { RELAY_PRESENTING_INSTANCE_HEADER } from "../federation/relay.js";

/**
 * Strip absolute paths from text that crosses agent boundaries.
 * Replaces /Users/.../project/src/foo.ts with src/foo.ts (or just the filename).
 */
export function sanitizeAbsolutePaths(text: string): string {
  // Match absolute paths like /home/user/dev/project-name/src/file.ts
  return text.replace(
    /(?:\/(?:Users|home)\/[^/]+\/(?:dev|work|projects?)\/[^/]+\/)([^\s"'`,;)\]]+)/g,
    (_match, relPart) => relPart,
  );
}

/** Max chars of file content to inline per file in delegation envelopes. */
const FILE_CONTENT_BUDGET = 2000;
/** Max number of files to inline content for. */
const MAX_INLINE_FILES = 5;
/** Max prompt budget for the full delegation envelope before the task body. */
const DELEGATION_ENVELOPE_TOKEN_BUDGET = 3000;
const ORIGIN_INSTANCE_ALIAS = "origin";

type RelayDispatchContext = RelayOriginContext & {
  callbackSender?: string;
  callbackSenderId?: string;
};

/**
 * Convert an absolute path to a relative one by stripping common project prefixes.
 * If the path is already relative, returns it as-is.
 */
function toRelativePath(filePath: string): string {
  if (!isAbsolute(filePath)) return filePath;
  // Strip common project root patterns: /Users/.../dev/project-name/
  const match = filePath.match(/\/(?:Users|home)\/[^/]+\/(?:dev|work|projects?)\/[^/]+\/(.+)/);
  if (match) return match[1];
  // Fallback: just use the filename
  return basename(filePath);
}

function buildDelegationRunEnvironment(agent: AgentConfig, cwdOverride?: string | null): DelegationRunEnvironment {
  return {
    provider: agent.provider,
    model: agent.model,
    working_directory: agent.working_directory ?? null,
    cwd_override: cwdOverride ?? null,
    sandbox: agent.sandbox,
    agentic_mode: agent.agentic_mode,
    allowed_tools: agent.allowed_tools ? [...agent.allowed_tools] : undefined,
    disallowed_tools: agent.disallowed_tools ? [...agent.disallowed_tools] : undefined,
    mcp_tools: agent.mcp_tools ? [...agent.mcp_tools] : undefined,
    approved_commands: agent.approved_commands ? [...agent.approved_commands] : undefined,
  };
}

/**
 * Resolve file paths to inline content snippets for delegation envelopes.
 * Reads each file that exists, truncates to budget, returns relative-path keyed content.
 * Files that don't exist or can't be read are returned with a placeholder.
 */
function resolveFileContents(
  filePaths: string[],
  cwdHint?: string,
): Array<{ relativePath: string; content: string | null }> {
  const results: Array<{ relativePath: string; content: string | null }> = [];

  for (const fp of filePaths.slice(0, MAX_INLINE_FILES)) {
    const relPath = toRelativePath(fp);

    // Try to read the file — check absolute path first, then relative to CWD hint
    let content: string | null = null;
    const candidates = isAbsolute(fp) ? [fp] : [];
    if (cwdHint) candidates.push(join(cwdHint, fp));
    // Also try the path as-is if it's relative (might resolve from process CWD)
    if (!isAbsolute(fp)) candidates.push(fp);

    for (const candidate of candidates) {
      try {
        if (existsSync(candidate)) {
          const raw = readFileSync(candidate, "utf-8");
          content = raw.length > FILE_CONTENT_BUDGET
            ? raw.slice(0, FILE_CONTENT_BUDGET) + `\n... (truncated, ${raw.length} chars total)`
            : raw;
          break;
        }
      } catch {
        // Can't read — skip to next candidate
      }
    }

    results.push({ relativePath: relPath, content });
  }

  return results;
}

async function dispatchToRelayOrigin(
  relay: RelayDispatchContext,
  agent: string,
  task: string,
  presentingInstance?: string,
): Promise<InvocationResult> {
  const startTime = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AGENT_TIMEOUT_MS);

  try {
    const res = await fetch(relay.callbackUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-NyxRelay-Token": relay.callbackToken,
        [RELAY_PRESENTING_INSTANCE_HEADER]:
          presentingInstance?.trim()
          || relay.callbackSenderId?.trim()
          || relay.callbackSender?.trim()
          || relay.originInstance,
      },
      body: JSON.stringify({
        message: task,
        agent,
        nonce: randomUUID(),
        sender: relay.callbackSender ?? relay.originInstance,
        sender_id: relay.callbackSenderId ?? relay.callbackSender ?? relay.originInstance,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "(no body)");
      throw new Error(`Origin callback returned ${res.status}: ${body.slice(0, 200)}`);
    }

    const data = await res.json() as {
      response: string;
      agent?: string;
      tokens_in?: number;
      tokens_out?: number;
      cost?: number;
      duration_ms?: number;
    };

    return {
      response: data.response,
      agent: data.agent ?? agent,
      method: "sdk",
      duration_ms: data.duration_ms ?? (Date.now() - startTime),
      tokens_in: data.tokens_in,
      tokens_out: data.tokens_out,
      cost: data.cost,
    };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`Origin callback timed out after ${Math.round(AGENT_TIMEOUT_MS / 1000)}s`);
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Build the envelope prepended to a delegated task so the worker agent
 * has the full context of the user request + orchestrator reasoning.
 *
 * ISOLATION PRINCIPLE: Never sends absolute file paths across agent boundaries.
 * Instead, inlines file content snippets so agents don't need shared filesystem access.
 *
 * When a DelegationContract is available on the mention, uses structured
 * contract fields for richer context. Falls back to legacy filePaths/verifyHints.
 */
export function buildDelegationEnvelope(
  userMsg: string,
  reasoning: string | null,
  mention: ActorMention,
  patternContext?: string | null,
  cwdHint?: string,
  originInstance?: string,
): string {
  const parts: string[] = [];
  parts.push("[Delegation Context]");
  if (userMsg) parts.push(`Original request: "${userMsg.slice(0, 500)}"`);
  if (reasoning) parts.push(`Orchestrator reasoning: ${reasoning.slice(0, 1000)}`);

  const c = mention.contract;
  if (c) {
    // Inline file content instead of raw paths
    const allInputPaths = c.inputFiles;
    if (allInputPaths.length) {
      const resolved = resolveFileContents(allInputPaths, cwdHint);
      const withContent = resolved.filter(r => r.content !== null);
      const withoutContent = resolved.filter(r => r.content === null);

      if (withContent.length) {
        parts.push("");
        parts.push("Relevant files:");
        for (const r of withContent) {
          parts.push(`--- ${r.relativePath} ---`);
          parts.push(r.content!);
          parts.push("");
        }
      }
      if (withoutContent.length) {
        parts.push(`Referenced files (not inlined): ${withoutContent.map(r => r.relativePath).join(", ")}`);
      }
    }

    // Output files — use relative paths only (files may not exist yet)
    if (c.outputFiles.length) {
      parts.push(`Output files: ${c.outputFiles.map(toRelativePath).join(", ")}`);
    }

    // Exclude files — relative paths only
    if (c.excludeFiles.length) {
      parts.push(`Do NOT modify: ${c.excludeFiles.map(toRelativePath).join(", ")}`);
    }

    if (c.constraints.length)     parts.push(`Constraints: ${c.constraints.join("; ")}`);
    if (c.verification.length)    parts.push(`Verification: ${c.verification.join("; ")}`);
    if (c.successCriteria.length) parts.push(`Success criteria: ${c.successCriteria.join("; ")}`);
    parts.push(`Expected output: ${c.outputType}${c.shouldCommit ? " (commit)" : ""}`);
    if (c.priority !== "normal")  parts.push(`Priority: ${c.priority}`);
    if (c.dependsOn.length)       parts.push(`Depends on: ${c.dependsOn.join(", ")}`);
  } else {
    // Fallback to legacy heuristic fields — inline content, not paths
    if (mention.filePaths?.length) {
      const resolved = resolveFileContents(mention.filePaths, cwdHint);
      const withContent = resolved.filter(r => r.content !== null);
      const withoutContent = resolved.filter(r => r.content === null);

      if (withContent.length) {
        parts.push("");
        parts.push("Relevant files:");
        for (const r of withContent) {
          parts.push(`--- ${r.relativePath} ---`);
          parts.push(r.content!);
          parts.push("");
        }
      }
      if (withoutContent.length) {
        parts.push(`Referenced files: ${withoutContent.map(r => r.relativePath).join(", ")}`);
      }
    }
    if (mention.verifyHints?.length) {
      parts.push(`Verification: ${mention.verifyHints.join("; ")}`);
    }
  }

  // Inject learned patterns (max ~500 tokens, pre-formatted)
  if (patternContext) {
    parts.push("");
    parts.push(patternContext);
  }

  if (mention.instance && originInstance) {
    parts.push("");
    parts.push(`[Relay Return Path] Origin instance: ${originInstance}`);
    parts.push(`To delegate back, use [@${ORIGIN_INSTANCE_ALIAS}.<agent>: task] or [@${originInstance}.<agent>: task].`);
  }

  parts.push("");
  parts.push("[Your Task]");
  parts.push("");
  const rawEnvelope = parts.join("\n");
  const capped = trimTextToTokenBudget(rawEnvelope, DELEGATION_ENVELOPE_TOKEN_BUDGET, {
    marker: "[...delegation context trimmed for token budget...]",
    mode: "fast",
  });
  if (capped.trimmed) {
    logger.warn(
      `[token-discipline] delegation envelope for @${mention.agent} trimmed from ${capped.originalTokenEstimate} to ${capped.tokenEstimate} tokens`,
    );
  }
  return capped.text;
}

/**
 * Build a continuation prompt for agents that hit the max-turns cap.
 * Gives the agent its original task + a summary of progress so it can
 * pick up where it left off with a fresh context window.
 */
export function buildContinuationPrompt(originalTask: string, previousResponse: string): string {
  const STATE_CAP = 1500;
  const lastState = previousResponse.length > STATE_CAP
    ? `...${previousResponse.slice(-STATE_CAP)}`
    : previousResponse;

  const essence = extractMessageEssence("assistant", previousResponse, 2000);

  return [
    "[Continuation — Previous Session Hit Turn Limit]",
    "",
    `Original task: ${originalTask.slice(0, 1000)}`,
    "",
    "## Progress Summary",
    essence,
    "",
    "## Last Working State",
    lastState,
    "",
    "[Instructions]",
    "Continue from the progress summary above.",
    "Do NOT retry approaches that resulted in errors listed above.",
    "Focus on completing remaining work — do not redo what was already done.",
    "If everything was actually completed, confirm what was done and verify it works.",
  ].join("\n");
}

/** Look up relevant patterns for an agent and format for injection. */
export function getPatternContext(ctx: DelegationContext, agentKey: string, filePaths?: string[]): string | null {
  const patterns = ctx.config.patterns;
  if (!patterns) return null;

  try {
    const relevant = patterns.searchRelevant({
      agent: agentKey,
      filePaths,
      limit: 3,
    });
    return patterns.formatForInjection(relevant);
  } catch (err) {
    logger.warn(`[delegation] Pattern lookup failed for ${agentKey}: ${err}`);
    return null;
  }
}

/**
 * Check whether the orchestrator should handle a task directly
 * instead of delegating, based on task simplicity and historical success rate.
 * Returns a nudge string if self-handling is advisable, null otherwise.
 */
export function getSelfHandlingNudge(
  routingStore: RoutingStore,
  orchestrator: string,
  taskType: string,
  taskDescription: string,
): string | null {
  // Complexity check: short task, few file references
  if (taskDescription.length > 200) return null
  const fileRefs = taskDescription.match(/\b[\w/.-]+\.(ts|js|py|swift|md)\b/g) ?? []
  if (fileRefs.length > 2) return null

  const rate = routingStore.getAgentSuccessRate(orchestrator, taskType)
  if (rate === null || rate < 80) return null

  return `Consider handling this directly — you have a ${rate}% success rate on ${taskType} tasks.`
}

/** Result type for executeDelegationTurn */
export interface DelegationTurnResult {
  cleanedResponse: string;
  mentions: Array<{ agent: string; task: string }>;
  subtaskResults: Array<{ agent: string; agentKey: string; response: string }>;
  actionResults: string[];
  unknownErrors: string;
  followupsQueued: number;
}

/**
 * Execute a single delegation turn: parse mentions, invoke delegates, collect results.
 * Returns structured data so the caller can decide what to do next (re-enter or return).
 *
 * The `processWithActorModel` callback is used for recursive sub-delegation.
 */
export async function executeDelegationTurn(
  response: string,
  agentKey: string,
  traceId: string | null,
  parentEventId: number | null,
  convId: string,
  channel: string,
  senderId: string,
  depth: number,
  messageCount: { value: number },
  ctx: DelegationContext,
  processWithActorModel: (
    primaryResult: InvocationResult,
    traceId: string | null,
    parentEventId: number | null,
    convId: string,
    channel: string,
    senderId: string,
    depth: number,
    messageCount: { value: number },
    ctx: DelegationContext,
    originMessageId?: string,
    onProgress?: (info: CLIProgress) => void,
    originalUserMessage?: string,
    parentKnowledgeContext?: string | null,
  ) => Promise<string>,
  originMessageId?: string,
  onProgress?: (info: CLIProgress) => void,
  originalUserMessage?: string,
  parentKnowledgeContext?: string | null,
): Promise<DelegationTurnResult> {
  // Parse and execute management actions first (hire/fire/reassign/team/schedule/alert)
  const { actions, cleanedResponse: postActions } = parseAgentActions(response);
  let actionResults: string[] = [];
  if (actions.length > 0) {
    logger.info(`[processor] Management actions from ${agentKey}: ${actions.map(a => a.type).join(", ")}`);
    actionResults = await ctx.executeManagementActions(actions, agentKey, {
      channel,
      senderId,
      messageId: originMessageId,
    });
  }

  // Parse and queue followup tags
  const { followups, cleanedResponse: postFollowups } = parseFollowups(postActions);
  let followupsQueued = 0;
  if (followups.length > 0) {
    for (const followup of followups) {
      const targetAgent = followup.agent || agentKey;
      ctx.queueFollowup(followup.task, targetAgent, agentKey, 1);
      followupsQueued++;
    }
    logger.info(`[processor] Queued ${followupsQueued} followup(s) from ${agentKey}: ${followups.map(f => `${f.agent || "self"}:"${f.task.slice(0, 60)}"`).join(", ")}`);
  }

  // Parse btw tags — ephemeral side queries, fire-and-forget
  const { btws, cleanedResponse: postBtws } = parseBtwTags(postFollowups);
  if (btws.length > 0 && ctx.handleBtw) {
    for (const btw of btws) {
      ctx.handleBtw(btw.agent, btw.content, agentKey).catch((err) => {
        logger.warn(`[processor] BTW query to @${btw.agent} failed: ${err}`);
      });
    }
    logger.info(`[processor] Fired ${btws.length} BTW query(s) from ${agentKey}: ${btws.map(b => `@${b.agent}`).join(", ")}`);
  }

  // Parse steer tags — mid-task context injection
  const { steers, cleanedResponse: postSteers } = parseSteerTags(postBtws);
  if (steers.length > 0 && ctx.handleSteer) {
    for (const steer of steers) {
      ctx.handleSteer(steer.agent, steer.content, agentKey).catch((err) => {
        logger.warn(`[processor] Steer to @${steer.agent} failed: ${err}`);
      });
    }
    logger.info(`[processor] Queued ${steers.length} steer(s) from ${agentKey}: ${steers.map(s => `@${s.agent}`).join(", ")}`);
  }

  // Parse delegation mentions from the btw/steer-stripped response
  const knownAgents = ctx.getKnownAgentKeys();
  const { mentions, unknownAgents, cleanedResponse: rawCleanedResponse } = parseActorMentions(postSteers, knownAgents);

  // Extract delegation contracts (zero-cost heuristic enrichment)
  if (mentions.length > 0) {
    extractContracts(mentions);
  }

  // Self-handling nudge: suggest the orchestrator handle simple tasks directly
  // if it has a strong track record on that task type
  let cleanedResponse = rawCleanedResponse;
  if (mentions.length > 0 && ctx.config.routing) {
    const nudges: string[] = [];
    for (const mention of mentions) {
      const taskType = mention.contract?.outputType ?? "unknown";
      const nudge = getSelfHandlingNudge(ctx.config.routing, agentKey, taskType, mention.task);
      if (nudge) {
        nudges.push(`[Self-handling hint for @${mention.agent} task]: ${nudge}`);
        logger.info(`[delegation] Self-handling nudge for ${agentKey} on ${taskType}: ${nudge}`);
      }
    }
    if (nudges.length > 0) {
      cleanedResponse = `${cleanedResponse}\n\n${nudges.join("\n")}`;
    }
  }

  // Emit delegation_parsed event
  if (mentions.length > 0 && originMessageId) {
    ctx.emit("delegation_parsed", {
      message_id: originMessageId,
      channel,
      from: agentKey,
      agents: mentions.map(m => m.agent),
      tasks: mentions.map(m => m.task.substring(0, 100)),
    });
  }

  // Report unknown agents
  const unknownErrors = unknownAgents.length > 0
    ? unknownAgents.map(a => `[Error: Agent @${a} not found. Available: ${[...knownAgents].join(", ")}]`).join("\n")
    : "";

  if (mentions.length === 0) {
    return { cleanedResponse, mentions, subtaskResults: [], actionResults, unknownErrors, followupsQueued };
  }

  // Depth guard (for recursive sub-delegation, not re-entry loop)
  if (depth >= ACTOR_MAX_DEPTH) {
    logger.warn(`[processor] Actor model max depth (${ACTOR_MAX_DEPTH}) reached, stopping recursion`);
    return { cleanedResponse, mentions: [], subtaskResults: [], actionResults, unknownErrors, followupsQueued };
  }

  // Pre-emptively trim mentions to fit within actor message budget
  const availableSlots = ACTOR_MAX_MESSAGES - messageCount.value;
  const trimmedMentions = availableSlots > 0 ? mentions.slice(0, availableSlots) : [];
  if (trimmedMentions.length < mentions.length) {
    logger.warn(`[processor] Actor model max messages (${ACTOR_MAX_MESSAGES}) reached — skipping ${mentions.length - trimmedMentions.length} mention(s)`);
  }

  // Per-conversation budget warning (check before delegation batch)
  if (traceId && ctx.config.traces && !ctx.conversationBudgetWarned.has(traceId)) {
    const traceCost = ctx.config.traces.getTraceCost(traceId);
    const budgetCfg = getBudgetConfig(ctx.config.nyxhiveConfig?.budget);
    if (traceCost > budgetCfg.perConversationWarn) {
      ctx.conversationBudgetWarned.set(traceId, Date.now());
      logger.warn(`[budget] Conversation ${traceId} cost $${traceCost.toFixed(4)} exceeds per-conversation warning of $${budgetCfg.perConversationWarn}`);
      ctx.emit("budget:warning", {
        period: "conversation",
        spent: traceCost,
        limit: budgetCfg.perConversationWarn,
        trace_id: traceId,
        channel,
      });
    }
  }

  // Pre-count all mentions for the message budget (before parallel spawn)
  messageCount.value += trimmedMentions.length;

  // Notify channels about delegation batch (for progress tree)
  if (originMessageId) {
    ctx.emit("delegation:batch", {
      message_id: originMessageId,
      channel,
      parentAgent: agentKey,
      agents: trimmedMentions.map(m => m.agent),
      parallel: trimmedMentions.length > 1,
    });
  }

  // Build delegation envelope: original user request + orchestrator reasoning
  const orchestratorReasoning = cleanedResponse.trim();
  const userMsg = originalUserMessage ?? "";

  // Search knowledge on original user message for broader context to carry forward
  const broadKnowledge = originalUserMessage
    ? await ctx.searchKnowledge(originalUserMessage)
    : { context: parentKnowledgeContext ?? null, chunkIds: [], chunkSnippets: new Map(), trace: undefined };

  // Spawn all same-level delegations in parallel
  const subtaskResults: Array<{ agent: string; agentKey: string; response: string }> = [];
  const promises = trimmedMentions.map(async (mention) => {
    // Remote instance dispatch — skip local agent resolution entirely
    if (mention.instance) {
      const instanceLabel = `${mention.instance}.${mention.agent}`;
      logger.info(`[processor] Remote delegation: ${instanceLabel} — "${mention.task.slice(0, 80)}"`);

      const delegationKey = `${convId}:${instanceLabel}`;
      // Flooding cap: reject if this agent already has too many active delegations
      const agentActiveDelegations = [...ctx.activeDelegations.values()].filter(d => d.agent === instanceLabel).length;
      if (agentActiveDelegations >= MAX_CONCURRENT_DELEGATIONS_PER_AGENT) {
        logger.warn(`[processor] Delegation flood cap hit for ${instanceLabel} (${agentActiveDelegations}/${MAX_CONCURRENT_DELEGATIONS_PER_AGENT} active) — skipping`);
        return null;
      }
      ctx.activeDelegations.set(delegationKey, {
        agent: instanceLabel,
        task: mention.task.slice(0, 200),
        dispatchedAt: Date.now(),
        convId,
        fromAgent: agentKey,
      });

      let eventId: number | null = null;
      if (ctx.config.traces && traceId) {
        eventId = ctx.config.traces.startEvent(traceId, instanceLabel, mention.task, parentEventId ?? undefined);
      }

      try {
        // Resolve local CWD hint so we can inline file content for the remote agent
        let remoteCwdHint: string | undefined;
        const remotePaths = [
          ...(mention.contract?.inputFiles ?? []),
          ...(mention.filePaths ?? []),
        ];
        if (remotePaths.length > 0) {
          const projects = ctx.config.nyxhiveConfig?.daemon?.projects;
          if (projects) {
            for (const proj of projects) {
              if (remotePaths.some(f => { try { return existsSync(join(proj.repo_path, f)); } catch { return false; } })) {
                remoteCwdHint = proj.repo_path;
                break;
              }
            }
            if (!remoteCwdHint) {
              const defaultProj = projects.find(p => p.default) ?? projects[0];
              if (defaultProj) remoteCwdHint = defaultProj.repo_path;
            }
          }
        }

        // Build envelope with file content inlined (no absolute paths cross the wire)
        const patternContext = getPatternContext(ctx, mention.agent, mention.contract?.outputFiles);
        const delegationEnvelope = buildDelegationEnvelope(
          userMsg,
          orchestratorReasoning,
          mention,
          patternContext,
          remoteCwdHint,
          ctx.config.nyxhiveConfig?.daemon.name,
        );
        const enrichedTask = delegationEnvelope + sanitizeAbsolutePaths(mention.task);
        const targetInstance = mention.instance.trim().toLowerCase();
        const originInstance = ctx.currentRelay?.originInstance?.trim().toLowerCase();
        const shouldRelayBack = !!ctx.currentRelay
          && (targetInstance === ORIGIN_INSTANCE_ALIAS || (originInstance !== undefined && targetInstance === originInstance));
        const result = shouldRelayBack
          ? await dispatchToRelayOrigin(
              ctx.currentRelay!,
              mention.agent,
              enrichedTask,
              ctx.config.nyxhiveConfig?.daemon.name,
            )
          : await dispatchToInstance(
              mention.instance,
              mention.agent,
              enrichedTask,
              ctx.config.nyxhiveConfig!,
              AGENT_TIMEOUT_MS,
              ctx.config.relayCallbacks,
            );

        if (ctx.config.traces && traceId && eventId) {
          ctx.config.traces.completeEvent(eventId, {
            responseExcerpt: result.response.slice(0, 500),
            tokensIn: result.tokens_in ?? 0,
            tokensOut: result.tokens_out ?? 0,
            cost: result.cost ?? 0,
            model: result.model,
            taskType: result.task_type,
            modelHint: mention.modelHint,
            billingType: getBillingType(result.method, result.model),
          });
        }

        subtaskResults.push({
          agent: `${shouldRelayBack ? ctx.currentRelay!.originInstance : mention.instance}/${result.agent}`,
          agentKey: instanceLabel,
          response: result.response,
        });
      } catch (err: unknown) {
        const errMsg = formatError(err);
        logger.error(`[processor] Remote delegation ${instanceLabel} failed: ${errMsg}`);
        if (ctx.config.traces && traceId && eventId) {
          ctx.config.traces.failEvent(eventId, errMsg);
        }
        subtaskResults.push({
          agent: instanceLabel,
          agentKey: instanceLabel,
          response: `[Error: Remote delegation to ${instanceLabel} failed: ${errMsg}]`,
        });
      } finally {
        ctx.activeDelegations.delete(delegationKey);
      }
      return;
    }

    // Local agent dispatch
    const agentConfig = ctx.getAgent(mention.agent);
    if (!agentConfig) return null;

    logger.info(`[processor] Actor delegation: ${mention.agent} — "${mention.task.slice(0, 80)}"`);

    // Track actual delegation
    ctx.config.registry?.recordDelegationActual(mention.agent);

    // Track in-flight delegation for status awareness
    const delegationKey = `${convId}:${mention.agent}`;
    // Flooding cap: reject if this agent already has too many active delegations
    const localAgentActiveDelegations = [...ctx.activeDelegations.values()].filter(d => d.agent === mention.agent).length;
    if (localAgentActiveDelegations >= MAX_CONCURRENT_DELEGATIONS_PER_AGENT) {
      logger.warn(`[processor] Delegation flood cap hit for ${mention.agent} (${localAgentActiveDelegations}/${MAX_CONCURRENT_DELEGATIONS_PER_AGENT} active) — skipping`);
      return null;
    }
    ctx.activeDelegations.set(delegationKey, {
      agent: mention.agent,
      task: mention.task.slice(0, 200),
      dispatchedAt: Date.now(),
      convId,
      fromAgent: agentKey,
    });

    // Start trace event for subtask
    let eventId: number | null = null;
    if (ctx.config.traces && traceId) {
      eventId = ctx.config.traces.startEvent(traceId, mention.agent, mention.task, parentEventId ?? undefined);
    }

    // Log routing decision for learned routing
    let routingDecisionId: number | null = null;
    if (ctx.config.routing && traceId) {
      routingDecisionId = ctx.config.routing.logDecision({
        traceId,
        fromAgent: agentKey,
        toAgent: mention.agent,
        taskType: mention.contract?.outputType ?? "unknown",
        taskExcerpt: mention.task,
        modelUsed: agentConfig.model,
      });
    }

    // Emit delegation trace event via SSE
    if (traceId) {
      ctx.emit("trace:delegation", {
        trace_id: traceId,
        message_id: originMessageId,
        channel,
        from: agentKey,
        to: mention.agent,
        agent: mention.agent,
        action: mention.task.substring(0, 100),
        task: mention.task.substring(0, 200),
      });
    }

    let delegationRun: DelegationRun | null = null;
    const runFilesTouched: DelegationRunFileTouch[] = [];

    try {
      const actorOverrideKey = `${senderId}:${mention.agent}`;
      // Priority: user model override > orchestrator model hint > agent default
      let effectiveConfig = agentConfig;
      let modelHintApplied = false;
      if (ctx.modelOverrides.has(actorOverrideKey)) {
        const override = ctx.modelOverrides.get(actorOverrideKey)!;
        effectiveConfig = {
          ...agentConfig,
          model: override.model,
          ...(override.provider ? { provider: override.provider } : {}),
          ...(override.cli_fallback ? { cli_fallback: override.cli_fallback } : {}),
          ...(override.provider ? { always_cli: override.provider === "openai" || override.provider === "anthropic" } : {}),
        };
      } else if (mention.modelHint) {
        const resolved = resolveModelHint(mention.modelHint);
        if (resolved) {
          // Try to clamp hint against soul's model_capabilities range
          const tierHint = hintToModelTier(mention.modelHint);
          const soul = loadAndCompileSoul(mention.agent, undefined, ctx.config.instanceSoulsDir);
          if (tierHint && soul) {
            const clampedModelId = resolveModel(soul, undefined, tierHint);
            const clampedProvider = clampedModelId !== resolved.model ? agentConfig.provider : resolved.provider;
            if (clampedModelId !== resolved.model) {
              logger.warn(`[delegation] Model hint "${mention.modelHint}" clamped by soul bounds for @${mention.agent}: ${resolved.model} → ${clampedModelId}`);
            }
            effectiveConfig = { ...agentConfig, model: clampedModelId, provider: clampedProvider };
          } else {
            effectiveConfig = { ...agentConfig, model: resolved.model, provider: resolved.provider };
          }
          modelHintApplied = true;
          logger.info(`[delegation] Model hint "${mention.modelHint}" → ${effectiveConfig.provider}/${effectiveConfig.model} for @${mention.agent}`);
        } else {
          logger.warn(`[delegation] Unknown model hint "${mention.modelHint}" for @${mention.agent}, using default`);
        }
      }

      // Extract task context for knowledge ranking and briefing injection
      const taskKeywords = mention.task
        .split(/\s+/)
        .filter((w: string) => w.length > 3 && !/^(the|and|for|with|that|this|from|have|been|will|should|could|would|into|each|when|then|also|just|more|some|what|make|like|only|over|such|they|them|than)$/i.test(w))
        .slice(0, 10);
      const taskContext = {
        filePaths: mention.filePaths ?? mention.contract?.inputFiles,
        taskType: mention.contract?.outputType === "code-change" ? "code" : mention.contract?.outputType === "review" ? "review" : undefined,
        keywords: taskKeywords,
      };

      const taskKnowledge = ctx.isOrchestratorAgent(mention.agent)
        ? { context: null, chunkIds: [], chunkSnippets: new Map(), trace: undefined }
        : await ctx.searchKnowledge(mention.task, undefined, taskContext);
      const knowledgeContext = ctx.mergeKnowledgeContext(broadKnowledge.context, taskKnowledge.context);
      const knowledgeTrace = mergeRetrievalTraces(
        [broadKnowledge.trace, taskKnowledge.trace],
        `delegation:${mention.agent}`,
      );
      const delegateMode = effectiveConfig.always_cli ? "cli" as const : "sdk" as const;
      const systemPromptResult = ctx.buildSystemPrompt(
        mention.agent,
        effectiveConfig.system_prompt,
        knowledgeContext,
        channel,
        taskContext,
        delegateMode,
        knowledgeTrace,
      );
      ctx.config.memory?.saveContextTrace(convId, mention.agent, systemPromptResult.trace);
      // Delegated agents: at depth 0, use full conversation history; at depth > 0, use compressed parent context
      let conversationHistory: Array<{ role: "user" | "assistant"; content: string }>;
      let conversationContext: string | undefined;
      if (depth > 0) {
        conversationHistory = [];
        conversationContext = ctx.buildParentContext(convId, 2000) ?? undefined;
        logger.info(`[processor] actor ${mention.agent} — compressed parent context (delegated, depth=${depth}, ${conversationContext ? conversationContext.length : 0} chars)`);
      } else {
        const { messages, metrics: ctxMetrics } = ctx.getConversationHistory(convId, effectiveConfig.model, systemPromptResult.prompt.length, mention.agent);
        conversationHistory = messages;
        logger.info(`[processor] actor ${mention.agent} — context: ${ctxMetrics.messageCount} msgs, ${ctxMetrics.tokenCount}/${ctxMetrics.budgetTokens} tokens (${ctxMetrics.utilizationPct}%)`);
      }

      // Notify channel that a delegated agent is working
      if (originMessageId) {
        ctx.emit("response:delta", {
          message_id: originMessageId,
          text_delta: `\n\n*${agentConfig.name} is working on this...*`,
          text_so_far: `\n\n*${agentConfig.name} is working on this...*`,
          agent: mention.agent,
          channel,
        });
      }

      const delegationProgress = (info: CLIProgress) => {
        info.agent = mention.agent;
        info.delegationDepth = depth + 1;
        if (delegationRun) {
          ctx.config.runs?.updateProgress(delegationRun.run_id, {
            status: "running",
            usage: {
              tokens_in: info.tokensIn,
              tokens_out: info.tokensOut,
              duration_ms: Math.round(info.elapsed * 1000),
            },
          });
        }

        if (info.phase === "responding" && info.textDelta && originMessageId) {
          ctx.emit("response:delta", {
            message_id: originMessageId,
            text_delta: info.textDelta,
            text_so_far: info.textSoFar || "",
            agent: mention.agent,
            channel,
          });
        }

        // Pipe to channel's onProgress (Discord, iOS, etc.)
        onProgress?.(info);

        // Emit delegation working progress
        if (info.phase === "working" && originMessageId) {
          ctx.emit("agent:progress", {
            message_id: originMessageId,
            agent: mention.agent,
            channel,
            turns: info.turns,
            tokensIn: info.tokensIn,
            tokensOut: info.tokensOut,
            elapsed: info.elapsed,
            activity: info.activity,
            delegationDepth: depth + 1,
            parentAgent: agentKey,
          });
        }
      };

      // Skip work log for agents with fresh_context (avoids context bleed from prior tasks)
      const skipWorkLog = (() => {
        try {
          const soul = loadAndCompileSoul(mention.agent, undefined, ctx.config.instanceSoulsDir);
          return soul?.capabilities?.context_strategy?.fresh_context === true;
        } catch { return false; }
      })();
      const recentWork = skipWorkLog ? [] : (ctx.config.memory?.getWorkLog(mention.agent, 3) ?? []);
      const workContext = recentWork?.length
        ? `\n[Recent Work by ${mention.agent}]\n${recentWork.map(w => `- ${w.task.slice(0, 200)} → ${w.result.slice(0, 300)}`).join("\n")}\n\n`
        : "";

      const delegationTimeoutMs = effectiveConfig.timeout_ms ?? AGENT_TIMEOUT_MS;

      // Resolve CWD override from file paths in delegation (must happen before envelope building)
      let cwdOverride: string | undefined;
      const contractFilePaths = [
        ...(mention.contract?.inputFiles ?? []),
        ...(mention.contract?.outputFiles ?? []),
        ...(mention.filePaths ?? []),
        ...(mention.task.match(/(?:src|souls|plans|tests?)\/[\w\/.+-]+/g) ?? []),
      ];
      if (contractFilePaths.length > 0) {
        const projects = ctx.config.nyxhiveConfig?.daemon?.projects;
        if (projects) {
          for (const proj of projects) {
            const hasMatch = contractFilePaths.some(f => {
              try { return existsSync(join(proj.repo_path, f)); } catch { return false; }
            });
            if (hasMatch) {
              cwdOverride = proj.repo_path;
              break;
            }
          }
          // Fallback: default project if files look like repo-relative paths
          if (!cwdOverride && contractFilePaths.some(f => f.startsWith("src/"))) {
            const defaultProj = projects.find(p => p.default) ?? projects[0];
            if (defaultProj) cwdOverride = defaultProj.repo_path;
          }
        }
      }
      if (cwdOverride) {
        logger.info(`[delegation] CWD override for ${mention.agent}: ${cwdOverride}`);
      }

      delegationRun = ctx.config.runs?.createRun({
        parent_run_id: ctx.currentRun?.run_id ?? null,
        task_id: ctx.taskId ?? null,
        message_id: originMessageId ?? null,
        trace_id: traceId ?? null,
        task_description: mention.task,
        agent: mention.agent,
        brain: resolveRunBrain(effectiveConfig),
        status: "running",
        environment: buildDelegationRunEnvironment(effectiveConfig, cwdOverride ?? null),
      }) ?? null;

      // Build envelope with CWD hint so file content can be inlined (not raw paths)
      const patternContext = getPatternContext(ctx, mention.agent, mention.contract?.outputFiles);
      const delegationEnvelope = buildDelegationEnvelope(userMsg, orchestratorReasoning, mention, patternContext, cwdOverride);
      const runContext = delegationRun ? buildRunContextNote(delegationRun.run_id, delegationRun.scratchpad_dir) : "";
      const enrichedTask = workContext + runContext + delegationEnvelope + mention.task;

      // Inject per-model context into system prompt (not cached — applied per invocation)
      const modelAwarePrompt = injectModelContext(systemPromptResult.prompt, effectiveConfig.model);

      const invokeOpts = {
        baseDir: ctx.config.baseDir,
        messageId: originMessageId,
        channel,
        cwdOverride,
        systemPrompt: modelAwarePrompt,
        knowledgeContext: knowledgeContext ?? undefined,
        conversationHistory,
        conversationContext: depth > 0 ? conversationContext : undefined,
        router: ctx.config.router,
        config: ctx.config.nyxhiveConfig,
        agentKey: mention.agent,
        cliEscalationTasks: ctx.config.cliEscalationTasks,
        modelOverride: ctx.modelOverrides.has(actorOverrideKey) || modelHintApplied,
        sandbox: ctx.config.sandbox,
        registry: ctx.config.registry,
        scheduler: ctx._scheduler,
        memory: ctx.config.memory,
        knowledge: ctx.config.knowledge,
        embedder: ctx.config.embedder,
        onProgress: delegationProgress,
        vault: ctx.config.vault,
        instanceSoulsDir: ctx.config.instanceSoulsDir,
        onFileChange: (change: { filePath: string; operation: string; linesAdded: number; linesRemoved: number; diffSummary?: string }) => {
          if (!delegationRun) return;
          const normalizedPath = change.filePath.trim();
          if (!normalizedPath) return;
          runFilesTouched.push({ path: normalizedPath, action: change.operation || "edit" });
          ctx.config.runs?.recordScratchpadFile(
            delegationRun.run_id,
            normalizedPath,
            mention.agent,
            `Recorded via ${change.operation || "edit"}`,
          );
        },
      };
      const result = await Promise.race([
        invokeAgent(effectiveConfig, enrichedTask, invokeOpts),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Agent ${mention.agent} timed out after ${Math.round(delegationTimeoutMs / 1000)}s`)), delegationTimeoutMs),
        ),
      ]);

      // Auto-continue if agent hit max-turns cap — fresh context each time
      const MAX_CONTINUATIONS = 3;
      for (let cont = 0; cont < MAX_CONTINUATIONS && result.hitMaxTurns; cont++) {
        // Cost ceiling pre-check: stop BEFORE spending more, not after
        if ((result.cost ?? 0) >= DELEGATION_COST_CEILING_USD) {
          logger.warn(`[delegation] ${mention.agent} hit cost ceiling $${(result.cost ?? 0).toFixed(2)} >= $${DELEGATION_COST_CEILING_USD} before continuation ${cont + 1} — stopping`);
          ctx.emit("delegation:cost-ceiling", {
            agent: mention.agent,
            cost: result.cost,
            ceiling: DELEGATION_COST_CEILING_USD,
            continuation: cont,
            trace_id: traceId,
            channel,
          });
          result.hitMaxTurns = false;
          break;
        }

        logger.info(`[delegation] ${mention.agent} hit max-turns cap, continuation ${cont + 1}/${MAX_CONTINUATIONS}`);

        if (originMessageId) {
          ctx.emit("agent:progress", {
            message_id: originMessageId,
            agent: mention.agent,
            channel,
            activity: `Continuing work (${cont + 1}/${MAX_CONTINUATIONS})`,
            delegationDepth: depth + 1,
            parentAgent: agentKey,
          });
        }

        let contEventId: number | null = null;
        if (ctx.config.traces && traceId) {
          contEventId = ctx.config.traces.startEvent(traceId, mention.agent, `[continuation ${cont + 1}]`, parentEventId ?? undefined);
        }

        const contPrompt = buildContinuationPrompt(mention.task, result.response);
        try {
          const contResult = await Promise.race([
            invokeAgent(effectiveConfig, contPrompt, {
              ...invokeOpts,
              conversationHistory: [],          // Fresh context — no accumulated noise
              conversationContext: undefined,
            }),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error(`Agent ${mention.agent} continuation ${cont + 1} timed out`)), delegationTimeoutMs),
            ),
          ]);

          if (ctx.config.traces && contEventId) {
            ctx.config.traces.completeEvent(contEventId, {
              responseExcerpt: contResult.response.slice(0, 500),
              tokensIn: contResult.tokens_in,
              tokensOut: contResult.tokens_out,
              cost: contResult.cost,
              durationMs: contResult.duration_ms,
              model: contResult.model ?? effectiveConfig.model,
              taskType: contResult.task_type,
              billingType: getBillingType(contResult.method, contResult.model ?? effectiveConfig.model),
            });
          }

          // Merge continuation results into the primary result
          result.response += `\n\n---\n[Continuation ${cont + 1}]\n\n${contResult.response}`;
          result.tokens_in = (result.tokens_in ?? 0) + (contResult.tokens_in ?? 0);
          result.tokens_out = (result.tokens_out ?? 0) + (contResult.tokens_out ?? 0);
          result.cost = (result.cost ?? 0) + (contResult.cost ?? 0);
          result.duration_ms += contResult.duration_ms;
          result.hitMaxTurns = contResult.hitMaxTurns;
          if (contResult.toolsUsed) {
            const merged = new Set(result.toolsUsed ?? []);
            for (const t of contResult.toolsUsed) merged.add(t);
            result.toolsUsed = [...merged];
          }

          // Cost ceiling post-check (in case this continuation itself pushed over)
          if ((result.cost ?? 0) >= DELEGATION_COST_CEILING_USD) {
            result.hitMaxTurns = false;
          }
        } catch (contErr) {
          const contErrMsg = formatError(contErr);
          logger.error(`[delegation] ${mention.agent} continuation ${cont + 1} failed: ${contErrMsg}`);
          if (ctx.config.traces && contEventId) {
            ctx.config.traces.failEvent(contEventId, contErrMsg);
          }
          result.hitMaxTurns = false; // Stop continuation loop on error
        }
      }

      if (result.hitMaxTurns) {
        logger.warn(`[delegation] ${mention.agent} still incomplete after ${MAX_CONTINUATIONS} continuations — returning partial result`);
        result.response += "\n\n> **Note:** This task did not complete within the turn limit. Some work may be incomplete.";
      }

      if (delegationRun) {
        ctx.config.runs?.completeRun(delegationRun.run_id, {
          status: "completed",
          result: deriveRunResult({
            response: result.response,
            status: "completed",
            scratchpadDir: delegationRun.scratchpad_dir,
            scratchpadFiles: ctx.config.runs?.getScratchpadFiles(delegationRun.run_id),
            filesTouched: runFilesTouched,
            invocation: result,
          }),
          usage: {
            tokens_in: result.tokens_in ?? 0,
            tokens_out: result.tokens_out ?? 0,
            tool_uses: result.toolsUsed ?? [],
            duration_ms: result.duration_ms ?? 0,
            cost_usd: result.cost ?? 0,
          },
          trace_id: traceId,
        });
      }

      // Record invocation stats in registry (accumulated across continuations)
      ctx.config.registry?.recordInvocation(mention.agent, {
        tokensIn: result.tokens_in ?? 0,
        tokensOut: result.tokens_out ?? 0,
        success: true,
        costCents: Math.round((result.cost ?? 0) * 100),
      });

      // Resolve routing decision with success outcome
      if (ctx.config.routing && routingDecisionId) {
        ctx.config.routing.resolveDecision(routingDecisionId, "success", Math.round((result.cost ?? 0) * 100), result.duration_ms);
      }

      // Record classifier feedback for the feedback loop
      if (ctx.config.classifierFeedback && taskKeywords.length > 0) {
        try {
          ctx.config.classifierFeedback.record({
            keywords: taskKeywords,
            selectedTier: modelHintApplied ? "max" : "default", // approximate: hint = explicit tier, default = classifier chose
            actualCost: result.cost ?? 0,
            success: true,
            agent: mention.agent,
            taskType: result.task_type,
          });
        } catch { /* non-critical */ }
      }

      // Flag unverified coding work
      if (result.method === "cli" && result.toolsUsed) {
        const ranBash = result.toolsUsed.includes("Bash");
        if (!ranBash) {
          logger.warn(`[processor] ${mention.agent} completed coding task without any Bash calls (no tests/builds)`);
          result.response += "\n\n> **Note:** This task completed without running tests or type-checking. Consider verifying manually.";
        }
      }

      // Review gate: automated LLM review of coder agent output
      if (ctx.config.nyxhiveConfig?.review_gate?.enabled) {
        const reviewCtx: ReviewGateContext = {
          router: ctx.config.router,
          config: ctx.config.nyxhiveConfig.review_gate,
          baseDir: ctx.config.baseDir,
          traces: ctx.config.traces,
          traceId: traceId ?? undefined,
          parentEventId: eventId ?? undefined,
        };
        const reviewResult = await runReviewGate(reviewCtx, agentConfig, mention.task, result);
        if (reviewResult) {
          // Link review outcome back to routing decision for learned routing
          if (ctx.config.routing && traceId) {
            ctx.config.routing.logReviewOutcome(traceId, reviewResult.verdict);
          }
          result.response += formatReviewAnnotation(reviewResult);
          ctx.emit("delegation:review-gate", {
            agent: mention.agent,
            verdict: reviewResult.verdict,
            summary: reviewResult.summary,
            issues: reviewResult.issues,
            trace_id: traceId,
            channel,
          });
        }
      }

      // Persist work log entry for subagent memory continuity
      ctx.config.memory?.saveWorkLog(
        mention.agent,
        mention.task.slice(0, 500),
        result.response.slice(0, 4000),
        channel,
        result.duration_ms,
      );

      // Complete trace event with model routing data
      if (ctx.config.traces && eventId) {
        ctx.config.traces.completeEvent(eventId, {
          responseExcerpt: result.response.slice(0, 500),
          tokensIn: result.tokens_in,
          tokensOut: result.tokens_out,
          cost: result.cost,
          durationMs: result.duration_ms,
          model: result.model ?? effectiveConfig.model,
          taskType: result.task_type,
          modelHint: mention.modelHint,
          billingType: getBillingType(result.method, result.model ?? effectiveConfig.model),
        });
      }

      // Delegation cost tracking: warn if individual call is expensive
      if (result.cost && result.cost > 0.10) {
        logger.warn(`[processor] Expensive delegation: @${mention.agent} cost $${result.cost.toFixed(4)} for task "${mention.task.slice(0, 60)}"`);
        ctx.emit("delegation:cost-warning", {
          agent: mention.agent,
          cost: result.cost,
          task: mention.task.slice(0, 200),
          trace_id: traceId,
          channel,
        });
      }

      // Detect plan-instead-of-code: coding agent wrote plans instead of implementing
      if (effectiveConfig.always_cli || effectiveConfig.cli_fallback) {
        const isCodingDelegation = /\b(implement|execute|fix|add|create|write|build|refactor)\b/i.test(mention.task);
        const mentionsPlanWritten = /wrote.*plan|written.*plan|plan file|plans\/[\w-]+\.md/i.test(result.response);
        const mentionsCodeWritten = /\b(committed|commit |edited|created|wrote)\b.*\.(ts|tsx|yaml|swift|rs|json)\b/i.test(result.response);

        if (isCodingDelegation && mentionsPlanWritten && !mentionsCodeWritten) {
          logger.warn(`[delegation] ${mention.agent} wrote plan instead of code — flagging for re-delegation`);
          ctx.emit("delegation:plan-not-code", {
            agent: mention.agent,
            task: mention.task.slice(0, 200),
            response: result.response.slice(0, 500),
          });
          result.response += "\n\n[SYSTEM: This agent wrote a plan file instead of implementing code. The delegation requested implementation. Instruct the agent to implement the changes directly — do not accept plan files as implementation.]";
        }
      }

      // Emit agent_complete trace event via SSE
      if (traceId) {
        ctx.emit("trace:agent_complete", {
          trace_id: traceId,
          message_id: originMessageId,
          channel,
          agent: mention.agent,
          from: agentKey,
          result: result.response ? result.response.substring(0, 150) : "completed",
          tokens_in: result.tokens_in,
          tokens_out: result.tokens_out,
          cost: result.cost,
          duration_ms: result.duration_ms,
        });
      }

      // Recurse — subtask response may contain further mentions (sequential per-result)
      const childCtx = delegationRun ? { ...ctx, currentRun: delegationRun } : ctx;
      const subtaskResponse = await processWithActorModel(
        result, traceId, eventId, convId, channel, senderId, depth + 1, messageCount, childCtx, originMessageId, onProgress, originalUserMessage, broadKnowledge.context,
      );

      // Clear in-flight delegation tracking
      ctx.activeDelegations.delete(delegationKey);

      return { agent: agentConfig.name, agentKey: mention.agent, response: subtaskResponse };
    } catch (err) {
      const errorMsg = formatError(err);
      logger.error(`[processor] Actor subtask ${mention.agent} failed: ${errorMsg}`);
      if (typeof delegationRun !== "undefined" && delegationRun) {
        const status: DelegationRunStatus = err instanceof Error && err.name === "AbortError" ? "killed" : "failed";
        ctx.config.runs?.completeRun(delegationRun.run_id, {
          status,
          result: deriveRunResult({
            response: "",
            status,
            scratchpadDir: delegationRun.scratchpad_dir,
            scratchpadFiles: ctx.config.runs?.getScratchpadFiles(delegationRun.run_id),
            filesTouched: runFilesTouched,
            error: errorMsg,
          }),
          usage: {
            tokens_in: 0,
            tokens_out: 0,
            tool_uses: [],
            duration_ms: 0,
            cost_usd: 0,
          },
          trace_id: traceId,
        });
      }
      // Clear in-flight delegation on failure too
      ctx.activeDelegations.delete(delegationKey);
      if (ctx.config.traces && eventId) {
        ctx.config.traces.failEvent(eventId, errorMsg);
      }
      // Resolve routing decision with failure outcome
      if (ctx.config.routing && routingDecisionId) {
        ctx.config.routing.resolveDecision(routingDecisionId, "failed");
      }

      // Record classifier feedback for failure
      if (ctx.config.classifierFeedback) {
        try {
          const failKeywords = mention.task
            .toLowerCase()
            .split(/\s+/)
            .filter((w: string) => w.length > 3)
            .slice(0, 10);
          if (failKeywords.length > 0) {
            ctx.config.classifierFeedback.record({
              keywords: failKeywords,
              selectedTier: mention.modelHint ? "max" : "default",
              actualCost: 0,
              success: false,
              agent: mention.agent,
            });
          }
        } catch { /* non-critical */ }
      }
      return { agent: agentConfig.name, agentKey: mention.agent, response: `[error: ${errorMsg}]` };
    }
  });

  // Await all parallel delegations, collect results in original mention order
  const settled = await Promise.allSettled(promises);
  for (const result of settled) {
    if (result.status === "fulfilled" && result.value) {
      subtaskResults.push(result.value);
    }
  }

  return { cleanedResponse, mentions: trimmedMentions, subtaskResults, actionResults, unknownErrors, followupsQueued };
}

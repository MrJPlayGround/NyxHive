/**
 * Persistent task scheduler with cron and one-shot support.
 * SQLite-backed, survives restarts.
 */

import type { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { parseCron, nextOccurrence } from "./cron.js";
import type { QueueProcessor } from "../queue/processor.js";
import type { NyxHiveConfig } from "../types.js";
import type { TrustOrigin } from "../security/input-sanitizer.js";
import type { ProviderRouter } from "../providers/router.js";
import type { AgentRegistry } from "../agents/registry.js";
import { logger } from "../utils/logger.js";
import { formatError } from "../utils/error.js";
import { extractPrUrl, proposalBranchName, checkPrState, checkPrMergeable } from "../proposals/pr-utils.js";
import { DEFAULT_PROPOSAL_EXECUTION_MODEL } from "../proposals/model-policy.js";
import { autoAdvanceReviewedProposal } from "../proposals/review-autopilot.js";
import { runVerification, resolveVerifyConfig } from "../proposals/verification.js";
import { distillPatterns } from "../learning/distill.js";
import { resolveNotificationTargets } from "../notifications/routing.js";
import { gatherHeartbeatContext, gatherBriefingContext } from "./context-providers.js";
import { loadConfigTasks, loadDefaultHeartbeat } from "./bootstrap.js";
import { adjustScheduleFrequency } from "./adaptive.js";
import { initAgentPresenceStateSchema, isPresenceHeartbeatTask, recordPresenceHeartbeat } from "./presence-state.js";
import type { CrawlIngestBridge, CrawlService, CrawlSourceStore } from "../crawl/index.js";
import { emitActivity } from "../activity/ring-buffer.js";
import type { HiveStores, TaskDefinition } from "../framework/types.js";
import { validateOutboundHttpUrl } from "../security/url-boundary.js";
import { inferModelTrust, type ModelTrustTier } from "../runtime/model-trust.js";

/**
 * Detect trivial/empty responses from heartbeat and scout tasks.
 * Matches: "ok", "HEARTBEAT_OK", "No drift detected", "no updates needed",
 * "nothing to report", and similar short all-clear responses.
 * Threshold: responses under 80 chars that don't contain action tags.
 */
const EMPTY_RESPONSE_PATTERNS = [
  /^\s*ok\.?\s*$/i,
  /^\s*heartbeat.ok\s*$/i,
  /no\s+(drift|issues?|findings?|updates?|changes?|problems?)\s+(detected|found|needed|to report)/i,
  /everything\s+(is\s+)?(fine|healthy|ok|good|normal|stable)/i,
  /vault\s+documentation\s+is\s+current/i,
  /nothing\s+(noteworthy|to\s+report|actionable)/i,
  /all\s+(clear|good|systems?\s+(healthy|nominal|ok))/i,
];

export function isEmptyResponse(response: string | undefined | null): boolean {
  if (!response) return true;
  const trimmed = response.trim();
  if (trimmed.length === 0) return true;
  // Short responses matching known all-clear patterns
  if (trimmed.length < 80) {
    for (const pattern of EMPTY_RESPONSE_PATTERNS) {
      if (pattern.test(trimmed)) return true;
    }
  }
  return false;
}

export function getMinuteStep(cronExpression: string | null | undefined): number | null {
  if (!cronExpression) return null;
  const [minuteField] = cronExpression.trim().split(/\s+/);
  const match = minuteField?.match(/^\*\/(\d+)$/);
  if (!match) return null;
  const step = Number.parseInt(match[1], 10);
  return Number.isFinite(step) && step > 1 && step < 60 ? step : null;
}

export function stableSchedulerPhaseOffsetMinutes(seed: string, stepMinutes: number): number {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return Math.abs(hash >>> 0) % stepMinutes;
}

function phasedMinuteSet(stepMinutes: number, offsetMinutes: number): Set<number> {
  const minutes = new Set<number>();
  for (let minute = offsetMinutes; minute < 60; minute += stepMinutes) {
    minutes.add(minute);
  }
  return minutes;
}

/**
 * Evaluate chain only_if condition against source result.
 *
 * Supported forms:
 * - undefined / "has_findings" — chain only if response is non-empty (default)
 * - "always" — always chain
 * - "contains:PATTERN" — chain if result contains PATTERN (case-insensitive)
 * - "matches:REGEX" — regex match against source result
 * - ["contains:ACTION", "contains:ESCALATE"] — chain if ANY condition matches (OR)
 */
export function evaluateChainCondition(
  condition: string | string[] | undefined,
  sourceResult: string,
  isEmpty: boolean,
): boolean {
  if (!condition) return !isEmpty; // default: has_findings

  if (typeof condition === "string") {
    return evaluateSingleCondition(condition, sourceResult, isEmpty);
  }

  // Array form: any condition matching is enough (OR)
  if (Array.isArray(condition)) {
    return condition.some(c => evaluateSingleCondition(c, sourceResult, isEmpty));
  }

  return !isEmpty; // fallback
}

function evaluateSingleCondition(condition: string, sourceResult: string, isEmpty: boolean): boolean {
  if (condition === "always") return true;
  if (condition === "has_findings") return !isEmpty;

  // "contains:PATTERN" — case-insensitive substring match
  if (condition.startsWith("contains:")) {
    const pattern = condition.slice("contains:".length);
    return sourceResult.toLowerCase().includes(pattern.toLowerCase());
  }

  // "matches:REGEX" — regex match against source result
  if (condition.startsWith("matches:")) {
    try {
      const regex = new RegExp(condition.slice("matches:".length), "i");
      return regex.test(sourceResult);
    } catch {
      return false;
    }
  }

  return !isEmpty; // unknown condition — safe default
}

// Re-export for backwards compatibility
export { gatherHeartbeatContext, gatherBriefingContext } from "./context-providers.js";
export { loadConfigTasks, loadDefaultHeartbeat, resolveHeartbeatModel } from "./bootstrap.js";
export { formatAgentPresenceStateForHeartbeat, formatNyxPresenceStateForHeartbeat, getAgentPresenceState, getNyxPresenceState, initAgentPresenceStateSchema, initNyxPresenceStateSchema, recordPresenceHeartbeat } from "./presence-state.js";
export type { ContextProviderDeps } from "./context-providers.js";
export type { BootstrapDeps } from "./bootstrap.js";

export interface ScheduledTask {
  id: string;
  name: string;
  description: string | null;
  cron_expression: string | null;
  run_at: number | null;
  agent: string;
  prompt: string;
  channel: string;
  recipient: string | null;
  enabled: number;
  last_run_at: number | null;
  next_run_at: number;
  last_status: string | null;
  last_error: string | null;
  last_result: string | null;
  category: string | null;
  run_count: number;
  consecutive_failures: number;
  created_by: string | null;
  notify_channels: string | null;
  /** If set, reply to this message ID when delivering notifications (Telegram reply_to_message_id / Discord message_reference). */
  notify_thread_id: string | null;
  /** Last result signature that was sent to operator notification channels. */
  last_notification_signature?: string | null;
  /** Timestamp for the last operator notification. */
  last_notified_at?: number | null;
  /** If set, POST a completion webhook to this URL when the task finishes (success or failure). */
  webhook_url: string | null;
  /** Optional per-task execution timeout override in milliseconds. */
  timeout_ms?: number | null;
  /** Scheduler execution authority boundary. Defaults to reduced scheduled authority. */
  authority_profile?: SchedulerAuthorityProfile | null;
  /** JSON: { task_name: string, inject_result?: boolean, only_if?: "has_findings" | "always" } */
  chain_to: string | null;
  created_at: number;
  updated_at: number;
}

export type SchedulerAuthorityProfile = "scheduled" | "system" | "interactive";

interface ExecuteTaskOptions {
  force?: boolean;
}

interface ScheduledRepoPreflightResult {
  ok: boolean;
  reason?: string;
}

const DEFAULT_SCHEDULER_AUTHORITY_PROFILE: SchedulerAuthorityProfile = "scheduled";
const SCHEDULER_AUTHORITY_PROFILES = new Set<SchedulerAuthorityProfile>(["scheduled", "system", "interactive"]);
const MIN_SCHEDULER_TIMEOUT_MS = 30_000;
const MAX_SCHEDULER_TIMEOUT_MS = 6 * 60 * 60_000;
const BASE_REPO_BRANCHES = new Set(["main", "master"]);

function normalizeSchedulerTimeoutMs(value: number | null | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.min(Math.max(Math.trunc(value), MIN_SCHEDULER_TIMEOUT_MS), MAX_SCHEDULER_TIMEOUT_MS);
}

function normalizeAuthorityProfile(value: string | null | undefined): SchedulerAuthorityProfile {
  if (value && SCHEDULER_AUTHORITY_PROFILES.has(value as SchedulerAuthorityProfile)) {
    return value as SchedulerAuthorityProfile;
  }
  return DEFAULT_SCHEDULER_AUTHORITY_PROFILE;
}

function resolveSchedulerExecutionBoundary(task: ScheduledTask): { channel: string; trust: TrustOrigin } {
  const profile = normalizeAuthorityProfile(task.authority_profile);
  if (profile === "system") return { channel: task.channel, trust: "system" };
  if (profile === "interactive") return { channel: task.channel, trust: "user" };
  return {
    channel: task.channel === "api" ? "scheduler" : task.channel,
    trust: "agent",
  };
}

function decodeSpawnOutput(output: Uint8Array | undefined): string {
  return output ? new TextDecoder().decode(output).trim() : "";
}

function runGit(repoPath: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = Bun.spawnSync(["git", ...args], { cwd: repoPath });
  return {
    ok: result.exitCode === 0,
    stdout: decodeSpawnOutput(result.stdout),
    stderr: decodeSpawnOutput(result.stderr),
  };
}

function isScheduledSelfImprovementTask(task: ScheduledTask): boolean {
  const name = task.name.toLowerCase();
  const category = task.category?.toLowerCase();
  return category === "evolution" || name.startsWith("evolution:") || name.includes("self-improvement");
}

function schedulerQuestionForTask(task: ScheduledTask): string {
  if (isScheduledSelfImprovementTask(task)) {
    return "What is the one highest-leverage bounded improvement NyxHive should make this run?";
  }
  if (isPresenceHeartbeatTask(task.name)) {
    return "Is there a real signal User needs to know, or should this heartbeat stay quiet?";
  }
  if (task.name.startsWith("heartbeat:") || task.name.startsWith("sentinel:") || task.category === "heartbeat") {
    return "Is there a meaningful runtime signal to notify, or should this scheduled check stay quiet?";
  }
  if (task.name.startsWith("briefing:")) {
    return "What does User need surfaced in this scheduled briefing?";
  }
  return `What is the bounded decision for scheduled task ${task.name}?`;
}

function schedulerDecisionForResult(task: ScheduledTask, outcome: "completed" | "failed" | "deferred", result: string | null | undefined, suppressed: boolean): string {
  if (outcome === "failed") return "failed";
  if (outcome === "deferred") return "deferred";
  if (suppressed) return "quiet";
  if (result?.includes("[@propose:")) return "proposal";
  if (isScheduledSelfImprovementTask(task)) return "reported";
  return "reported";
}

export function scheduledNotificationSignature(task: ScheduledTask, outcome: "completed" | "failed", result: string): string {
  const normalized = result.trim().replace(/\s+/g, " ").slice(0, 4000);
  return createHash("sha256")
    .update(JSON.stringify({ task: task.name, outcome, normalized }))
    .digest("hex");
}

function scheduledNotificationLimit(channelName: string): number {
  const normalized = channelName.toLowerCase();
  if (normalized === "discord") return 1900;
  return 3900;
}

function boundScheduledNotificationContent(content: string, channelName: string): string {
  const limit = scheduledNotificationLimit(channelName);
  if (content.length <= limit) return content;
  const suffix = "\n\n[truncated; full report is in NyxHive scheduler artifacts]";
  return `${content.slice(0, Math.max(0, limit - suffix.length))}${suffix}`;
}

function isSignatureSuppressionEligible(task: ScheduledTask): boolean {
  return task.category === "heartbeat" || task.name.startsWith("heartbeat:") || task.name.startsWith("sentinel:");
}

function shouldSuppressDuplicateNotification(task: ScheduledTask, signature: string | null, previousSignature: string | null | undefined): boolean {
  return isSignatureSuppressionEligible(task)
    && !!signature
    && !!previousSignature
    && signature === previousSignature;
}

export class Scheduler {
  private db: Database;
  private processor: QueueProcessor;
  private config: NyxHiveConfig;
  private running = false;
  private tickTimer: ReturnType<typeof setInterval> | null = null;
  private router?: ProviderRouter;
  private registry?: AgentRegistry;
  private _proposalStore?: import("../proposals/store.js").ProposalStore;
  private crawlService?: CrawlService;
  private crawlSources?: CrawlSourceStore;
  private crawlIngest?: CrawlIngestBridge;
  private _batcher?: import("../notifications/batcher.js").NotificationBatcher;
  /** Tasks currently executing — prevents concurrent runs of the same task */
  private runningTasks = new Set<string>();
  private extensionTasks = new Map<string, TaskDefinition>();
  private extensionTaskStores?: HiveStores;

  constructor(db: Database, processor: QueueProcessor, config: NyxHiveConfig, router?: ProviderRouter, registry?: AgentRegistry) {
    this.db = db;
    this.processor = processor;
    this.config = config;
    this.router = router;
    this.registry = registry;
    this.initSchema();
  }

  private initSchema(): void {
    // Check if table exists with wrong schema (stale from earlier version)
    // If so, drop and recreate — scheduler data is ephemeral, no migration needed
    try {
      const cols = this.db.query("PRAGMA table_info(scheduled_tasks)").all() as Array<{ name: string }>;
      if (cols.length > 0) {
        const colNames = new Set(cols.map(c => c.name));
        const required = ["cron_expression", "next_run_at", "created_by", "run_count", "last_result", "category"];
        const missing = required.filter(c => !colNames.has(c));
        if (missing.length > 0) {
          logger.warn(`[scheduler] Stale scheduled_tasks table (missing: ${missing.join(", ")}), recreating`);
          this.db.exec("DROP TABLE IF EXISTS scheduled_tasks");
          this.db.exec("DROP INDEX IF EXISTS idx_scheduled_next");
        }
      }
    } catch { /* table doesn't exist yet, fine */ }

    const schema = readFileSync(join(import.meta.dir, "schema.sql"), "utf-8");
    const statements: string[] = [];
    let current = "";
    for (const line of schema.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("--") || trimmed === "") continue;
      current += `${line}\n`;
      if (trimmed.endsWith(";")) {
        statements.push(current.trim());
        current = "";
      }
    }
    if (current.trim()) statements.push(current.trim());
    for (const stmt of statements) {
      try {
        this.db.exec(stmt);
      } catch (err) {
        const msg = formatError(err);
        if (!msg.includes("already exists")) {
          throw new Error(`[scheduler] Schema error: ${msg}\nStatement: ${stmt.substring(0, 120)}`);
        }
      }
    }

    try {
      this.db.exec("ALTER TABLE scheduled_tasks ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0");
    } catch (err) {
      const msg = String(err);
      if (!msg.includes("already exists") && !msg.includes("duplicate column")) throw err;
    }

    try {
      this.db.exec("ALTER TABLE scheduled_tasks ADD COLUMN notify_channels TEXT");
    } catch (err) {
      const msg = String(err);
      if (!msg.includes("already exists") && !msg.includes("duplicate column")) throw err;
    }

    // Adaptive scheduling columns
    try { this.db.exec("ALTER TABLE scheduled_tasks ADD COLUMN original_cron TEXT"); } catch {}
    try { this.db.exec("ALTER TABLE scheduled_tasks ADD COLUMN adjusted_cron TEXT"); } catch {}
    try { this.db.exec("ALTER TABLE scheduled_tasks ADD COLUMN consecutive_empty INTEGER DEFAULT 0"); } catch {}
    // Task chaining column
    try { this.db.exec("ALTER TABLE scheduled_tasks ADD COLUMN chain_to TEXT"); } catch {}
    // Reply threading column
    try { this.db.exec("ALTER TABLE scheduled_tasks ADD COLUMN notify_thread_id TEXT"); } catch {}
    try { this.db.exec("ALTER TABLE scheduled_tasks ADD COLUMN last_notification_signature TEXT"); } catch {}
    try { this.db.exec("ALTER TABLE scheduled_tasks ADD COLUMN last_notified_at INTEGER"); } catch {}
    // Per-task webhook URL for completion callbacks
    try { this.db.exec("ALTER TABLE scheduled_tasks ADD COLUMN webhook_url TEXT"); } catch {}
    try { this.db.exec("ALTER TABLE scheduled_tasks ADD COLUMN timeout_ms INTEGER"); } catch {}
    try { this.db.exec("ALTER TABLE scheduled_tasks ADD COLUMN authority_profile TEXT DEFAULT 'scheduled'"); } catch {}
    this.db.run("UPDATE scheduled_tasks SET authority_profile = 'scheduled' WHERE authority_profile IS NULL");
    initAgentPresenceStateSchema(this.db);
    // Backfill original_cron from cron_expression where not yet set
    this.db.run("UPDATE scheduled_tasks SET original_cron = cron_expression WHERE original_cron IS NULL");
  }

  async start(): Promise<void> {
    this.running = true;
    this.loadConfigTasks();
    this.loadDefaultHeartbeat();
    this.repairPersistedSchedules();
    this.recalculateNextRuns();
    const tickMs = this.config.scheduler?.tick_interval_ms ?? 60_000;
    this.tickTimer = setInterval(() => this.tick(), tickMs);
    const count = this.getTaskCount();
    logger.info(`[scheduler] Started (tick every ${tickMs}ms, ${count} tasks)`);
  }

  stop(): void {
    this.running = false;
    if (this.tickTimer) clearInterval(this.tickTimer);
    logger.info("[scheduler] Stopped");
  }

  setProposalStore(store: import("../proposals/store.js").ProposalStore): void {
    this._proposalStore = store;
  }

  setBatcher(batcher: import("../notifications/batcher.js").NotificationBatcher): void {
    this._batcher = batcher;
  }

  setCrawlRuntime(runtime: {
    service?: CrawlService;
    sources?: CrawlSourceStore;
    ingest?: CrawlIngestBridge;
  }): void {
    this.crawlService = runtime.service;
    this.crawlSources = runtime.sources;
    this.crawlIngest = runtime.ingest;
  }

  registerTaskDefinitions(definitions: TaskDefinition[], stores: HiveStores): void {
    this.extensionTaskStores = stores;
    this.extensionTasks.clear();

    const activeNames = new Set<string>();

    for (const definition of definitions) {
      this.extensionTasks.set(definition.name, definition);
      activeNames.add(definition.name);

      const enabled = typeof definition.enabled === "function"
        ? definition.enabled(this.config)
        : definition.enabled !== false;
      const existing = this.getTaskByName(definition.name);

      if (existing) {
        this.updateTask(existing.id, {
          name: definition.name,
          description: `Extension task: ${definition.name}`,
          cron_expression: definition.schedule,
          agent: "extension",
          prompt: `[extension:${definition.name}]`,
          enabled,
        });
        continue;
      }

      const id = this.addTask({
        name: definition.name,
        description: `Extension task: ${definition.name}`,
        cron_expression: definition.schedule,
        agent: "extension",
        prompt: `[extension:${definition.name}]`,
        created_by: "extension",
      });

      if (!enabled) {
        this.updateTask(id, { enabled: false });
      }
    }

    const staleTasks = this.db.query(
      "SELECT id, name FROM scheduled_tasks WHERE created_by = 'extension'",
    ).all() as Array<{ id: string; name: string }>;

    for (const task of staleTasks) {
      if (activeNames.has(task.name)) continue;
      this.deleteTask(task.id);
      logger.info(`[scheduler] Removed stale extension task: ${task.name}`);
    }
  }

  private async executeExtensionTask(task: ScheduledTask, definition: TaskDefinition, now: number): Promise<void> {
    if (!this.extensionTaskStores) {
      throw new Error(`Extension task "${task.name}" has no store context`);
    }
    if (!this.router) {
      throw new Error(`Extension task "${task.name}" requires a provider router`);
    }

    await definition.handler({
      processor: this.processor.getPublicAPI(),
      config: this.config,
      stores: this.extensionTaskStores,
      router: this.router,
    });

    const result = `[extension] ${task.name} completed`;
    this.db.run(
      `UPDATE scheduled_tasks SET
        last_run_at = ?, last_status = 'completed', last_error = NULL,
        last_result = ?, run_count = run_count + 1, next_run_at = ?, consecutive_failures = 0, updated_at = ?
      WHERE id = ?`,
      [now, result, this.computeNextRun(task), now, task.id],
    );
    logger.info(`[scheduler] Extension task completed: ${task.name}`);
    this.processor.emitEvent("scan:completed", {
      task_id: task.id,
      task_name: task.name,
      agent: task.agent,
      status: "completed",
      result_preview: result,
    });
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    const now = Date.now();
    this.repairPersistedSchedules(now);
    const dueTasks = this.db.query(
      "SELECT * FROM scheduled_tasks WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at ASC",
    ).all(now) as ScheduledTask[];

    for (const task of dueTasks) {
      await this.executeTask(task);
    }

    // Proposal maintenance: expire stale + nudge pending
    if (this._proposalStore) {
      const expired = this._proposalStore.expireStale();
      if (expired > 0) {
        logger.info(`[scheduler] Expired ${expired} stale proposals`);
      }

      // Archive old completed/failed proposals
      const archiveDays = this.config.proposals?.archive_after_days ?? 30;
      const archived = this._proposalStore.archiveStale(archiveDays);
      if (archived > 0) {
        logger.info(`[scheduler] Archived ${archived} stale completed/failed proposals (>${archiveDays}d)`);
      }

      // Nudge: proposals pending > 48h, not yet nudged — now with actual delivery
      const nudgeable = this._proposalStore.listNudgeable();
      for (const p of nudgeable) {
        this._proposalStore.markNudged(p.proposal_id);
        logger.info(`[scheduler] Nudged proposal ${p.proposal_id}: "${p.title}"`);

        // Send nudge notification to owner — route through batcher if available
        const proposalTargets = resolveNotificationTargets(this.config, "proposals");
        for (const proposalTarget of proposalTargets) {
          if (this._batcher) {
            await this._batcher.queueProposal(proposalTarget, p);
          } else {
            const channels = this.processor.getChannels();
            const ch = channels?.find(c => c.name.toLowerCase() === proposalTarget.channel.toLowerCase());
            if (ch?.sendProposalNotification) {
              try {
                await ch.sendProposalNotification(proposalTarget.recipient, p);
              } catch (err) {
                logger.debug(`[scheduler] Nudge notification failed for ${p.proposal_id}: ${err}`);
              }
            } else if (ch?.sendOutbound) {
              try {
                const { formatNudgePlainText } = await import("../proposals/notifications.js");
                await ch.sendOutbound(proposalTarget.recipient, formatNudgePlainText(p));
              } catch (err) {
                logger.debug(`[scheduler] Nudge notification failed for ${p.proposal_id}: ${err}`);
              }
            }
          }
        }
      }
    }
  }

  private gatherHeartbeatContext(task?: ScheduledTask): Promise<string> {
    return gatherHeartbeatContext({ db: this.db, processor: this.processor, config: this.config, proposalStore: this._proposalStore, agent: task?.agent });
  }

  private gatherBriefingContext(): string {
    return gatherBriefingContext({ db: this.db, processor: this.processor, config: this.config, proposalStore: this._proposalStore });
  }

  private resolveDefaultProjectRepoPath(): string {
    const defaultProject = this.config.daemon.projects?.find(project => project.default) ?? this.config.daemon.projects?.[0];
    return resolve(defaultProject?.repo_path ?? resolve(import.meta.dir, "../.."));
  }

  private checkScheduledEvolutionRepoPreflight(task: ScheduledTask): ScheduledRepoPreflightResult {
    if (!isScheduledSelfImprovementTask(task)) return { ok: true };

    const repoPath = this.resolveDefaultProjectRepoPath();
    const branch = runGit(repoPath, ["branch", "--show-current"]);
    if (!branch.ok) {
      return {
        ok: false,
        reason: `Repo preflight deferred: cannot read branch for default repo ${repoPath}: ${branch.stderr || branch.stdout || "git branch failed"}`,
      };
    }

    const branchName = branch.stdout.trim();
    if (!BASE_REPO_BRANCHES.has(branchName)) {
      return {
        ok: false,
        reason: `Repo preflight deferred: default repo ${repoPath} is on branch "${branchName || "detached HEAD"}", expected main/master.`,
      };
    }

    const dirty = runGit(repoPath, ["status", "--porcelain"]);
    if (!dirty.ok) {
      return {
        ok: false,
        reason: `Repo preflight deferred: cannot inspect working tree for default repo ${repoPath}: ${dirty.stderr || dirty.stdout || "git status failed"}`,
      };
    }
    if (dirty.stdout.length > 0) {
      const firstChange = dirty.stdout.split("\n")[0];
      return {
        ok: false,
        reason: `Repo preflight deferred: default repo ${repoPath} has dirty working tree changes (${firstChange}).`,
      };
    }

    const divergence = runGit(repoPath, ["rev-list", "--left-right", "--count", "@{u}...HEAD"]);
    if (!divergence.ok) {
      return {
        ok: false,
        reason: `Repo preflight deferred: cannot compare default repo ${repoPath} with upstream: ${divergence.stderr || divergence.stdout || "git rev-list failed"}`,
      };
    }

    const [, aheadText] = divergence.stdout.split(/\s+/);
    const ahead = Number.parseInt(aheadText ?? "0", 10);
    if (Number.isFinite(ahead) && ahead > 0) {
      return {
        ok: false,
        reason: `Repo preflight deferred: default repo ${repoPath} has ${ahead} unpushed local commit(s).`,
      };
    }

    return { ok: true };
  }

  private deferScheduledTaskForRepoPreflight(task: ScheduledTask, now: number, reason: string): void {
    this.db.run(
      `UPDATE scheduled_tasks SET
        last_run_at = ?, last_status = 'deferred', last_error = ?, last_result = ?,
        next_run_at = ?, updated_at = ?
      WHERE id = ?`,
      [now, reason.substring(0, 2000), reason.substring(0, 5000), this.computeNextRun(task, now), now, task.id],
    );
    logger.warn(`[scheduler] Deferred ${task.name}: ${reason}`);
    this.processor.getTraces?.()?.recordScheduledRunArtifact({
      taskId: task.id,
      taskName: task.name,
      traceId: null,
      question: schedulerQuestionForTask(task),
      decision: schedulerDecisionForResult(task, "deferred", reason, true),
      outcome: "deferred",
      evidence: {
        reason: reason.slice(0, 1000),
        authorityProfile: normalizeAuthorityProfile(task.authority_profile),
      },
      artifacts: [{ kind: "scheduled_task", ref: task.id }],
      notified: false,
      suppressionReason: "repo_preflight",
      notificationSignature: null,
      modelTrustTier: "tier_0_no_model",
      startedAt: now,
      completedAt: Date.now(),
    });
    this.processor.emitEvent("scan:completed", {
      task_id: task.id,
      task_name: task.name,
      agent: task.agent,
      status: "deferred",
      error: reason.substring(0, 500),
    });
  }

  private async executeTask(task: ScheduledTask, options: ExecuteTaskOptions = {}): Promise<void> {
    // Prevent concurrent execution of the same task (e.g. cron tick + manual trigger)
    if (this.runningTasks.has(task.id)) {
      logger.debug(`[scheduler] Skipping ${task.name} — already running`);
      return;
    }

    // Re-check next_run_at from DB — the task snapshot may be stale if a previous task in the
    // same tick loop took a long time and this task already ran in a subsequent tick interval.
    const fresh = this.db.query(
      "SELECT enabled, next_run_at FROM scheduled_tasks WHERE id = ?",
    ).get(task.id) as { enabled: number; next_run_at: number } | null;
    if (!fresh) {
      logger.debug(`[scheduler] Skipping ${task.name} — task no longer exists`);
      return;
    }
    if (!options.force && fresh.enabled !== 1) {
      logger.debug(`[scheduler] Skipping ${task.name} — task is disabled`);
      return;
    }
    if (fresh.next_run_at > task.next_run_at) {
      logger.debug(`[scheduler] Skipping ${task.name} — already ran (stale tick snapshot)`);
      return;
    }

    // Budget gate — defer non-critical tasks when budget is tight
    if (!this.processor.shouldRunAutonomousTask(task.name)) {
      return;
    }

    // Inflight guard — defer heartbeat/sentinel tasks when an invocation is active.
    // These tasks hit ollama/cheap models and can cause resource contention or race
    // with shutdown if fired during a heavy Opus turn.
    const isLowPriorityCron = task.category === "heartbeat" || task.name.startsWith("heartbeat:") || task.name.startsWith("sentinel:");
    if (isLowPriorityCron && this.processor.getInflightCount() > 0) {
      logger.debug(`[scheduler] Deferring ${task.name} — ${this.processor.getInflightCount()} invocation(s) in-flight`);
      return;
    }

    this.runningTasks.add(task.id);

    const now = Date.now();
    logger.info(`[scheduler] Executing: ${task.name} (agent: ${task.agent})`);

    this.processor.emitEvent("scan:started", {
      task_id: task.id,
      task_name: task.name,
      agent: task.agent,
    });

    try {
      const extensionTask = this.extensionTasks.get(task.name);
      if (extensionTask) {
        try {
          await this.executeExtensionTask(task, extensionTask, now);
        } catch (err) {
          this.db.run(
            `UPDATE scheduled_tasks SET
              last_run_at = ?, last_status = 'failed', last_error = ?,
              run_count = run_count + 1, next_run_at = ?, consecutive_failures = consecutive_failures + 1, updated_at = ?
            WHERE id = ?`,
            [now, String(err), this.computeNextRun(task), now, task.id],
          );
          logger.error(`[scheduler] Extension task failed: ${task.name}: ${err}`);
          this.processor.emitEvent("scan:completed", {
            task_id: task.id,
            task_name: task.name,
            agent: task.agent,
            status: "failed",
            error: String(err).substring(0, 500),
          });
        }
        if (!task.cron_expression) {
          this.db.run("UPDATE scheduled_tasks SET enabled = 0, updated_at = ? WHERE id = ?", [now, task.id]);
        }
        return;
      }

      // System tasks run server-side functions, not LLM prompts
      if (task.agent === "system") {
        try {
          const response = await this.executeSystemTask(task);
          this.db.run(
            `UPDATE scheduled_tasks SET
              last_run_at = ?, last_status = 'completed', last_error = NULL,
              last_result = ?, run_count = run_count + 1, next_run_at = ?, consecutive_failures = 0, updated_at = ?
            WHERE id = ?`,
            [now, response.substring(0, 5000), this.computeNextRun(task), now, task.id],
          );
          logger.info(`[scheduler] System task completed: ${task.name} — ${response.slice(0, 100)}`);
          this.processor.emitEvent("scan:completed", { task_id: task.id, task_name: task.name, agent: task.agent, status: "completed", result_preview: response.slice(0, 1000) });
          await this.deliverToNotifyChannels(task, response, "completed");
        } catch (err) {
          this.db.run(
            `UPDATE scheduled_tasks SET
              last_run_at = ?, last_status = 'failed', last_error = ?,
              run_count = run_count + 1, next_run_at = ?, consecutive_failures = consecutive_failures + 1, updated_at = ?
            WHERE id = ?`,
            [now, String(err), this.computeNextRun(task), now, task.id],
          );
          logger.error(`[scheduler] System task failed: ${task.name}: ${err}`);
          this.processor.emitEvent("scan:completed", { task_id: task.id, task_name: task.name, agent: task.agent, status: "failed", error: String(err).substring(0, 500) });
        }
        if (!task.cron_expression) {
          this.db.run("UPDATE scheduled_tasks SET enabled = 0, updated_at = ? WHERE id = ?", [now, task.id]);
        }
        return;
      }

      // Sentinel tasks are stateless — use a unique sender per execution
      // so they get a fresh context window instead of accumulating history
      const isSentinel = task.name.startsWith("sentinel:") || (task.agent === "sentinel");
      const senderKey = isSentinel ? `scheduler:${task.id}:${Date.now()}` : `scheduler:${task.id}`;
      const executionBoundary = resolveSchedulerExecutionBoundary(task);
      const timeoutMs = normalizeSchedulerTimeoutMs(task.timeout_ms);
      const repoPreflight = this.checkScheduledEvolutionRepoPreflight(task);
      if (!repoPreflight.ok) {
        this.deferScheduledTaskForRepoPreflight(task, now, repoPreflight.reason ?? "Repo preflight deferred.");
        return;
      }

      try {
        // Pre-fetch data for tasks that can't (or shouldn't) query APIs themselves.
        // Heartbeat/sentinel tasks: cheap SDK model with no tools. Briefing: read-only tools, can't curl localhost.
        let message = task.prompt;
        const needsHealthData = task.category === "heartbeat" || task.name.startsWith("heartbeat:") || task.name.startsWith("sentinel:");
        if (needsHealthData) {
          message = `${await this.gatherHeartbeatContext(task)}\n---\n\n${task.prompt}`;
        } else if (task.name === "briefing:daily") {
          const today = new Date().toISOString().split("T")[0];
          message = `${this.gatherBriefingContext()}\n---\n\n${task.prompt.replace("{date}", today)}`;
        }

        const result = await this.processor.processImmediate({
          channel: executionBoundary.channel,
          sender: senderKey,
          sender_id: task.recipient ?? senderKey,
          task_id: task.id,
          message,
          agent: task.agent,
          trust: executionBoundary.trust,
          timeout_ms: timeoutMs,
        });

        // Count proposals created during this scan (by matching scout_source)
        const proposalsCreated = this._proposalStore?.countBySource(`scout:${task.name}`, now) ?? 0;

        // Detect empty/trivial responses for suppression. Self-improvement
        // runs still need their full no-op report delivered to User.
        const isEmpty = isEmptyResponse(result.response) && proposalsCreated === 0;
        const suppressEmptyResult = isEmpty && !isScheduledSelfImprovementTask(task);
        const isScheduledCron = !!task.cron_expression;
        const notificationSignature = result.response
          ? scheduledNotificationSignature(task, "completed", result.response)
          : null;
        const previousNotification = this.db
          .query("SELECT last_notification_signature FROM scheduled_tasks WHERE id = ?")
          .get(task.id) as { last_notification_signature: string | null } | null;
        const suppressDuplicateNotification = shouldSuppressDuplicateNotification(
          task,
          notificationSignature,
          previousNotification?.last_notification_signature,
        );
        const notificationSuppressionReason = suppressEmptyResult
          ? "empty_result"
          : suppressDuplicateNotification
            ? "duplicate_signature"
            : null;
        const shouldNotifyResult = Boolean(result.response && task.notify_channels && !notificationSuppressionReason);
        const resultModel = (result as { model?: string }).model ?? null;
        const modelTrust = inferModelTrust(resultModel);

        this.db.run(
          `UPDATE scheduled_tasks SET
            last_run_at = ?, last_status = 'completed', last_error = NULL,
            last_result = ?, run_count = run_count + 1, next_run_at = ?, consecutive_failures = 0, updated_at = ?
          WHERE id = ?`,
          [now, suppressEmptyResult ? "[suppressed — nothing to report]" : result.response?.substring(0, 5000) ?? null, this.computeNextRun(task), now, task.id],
        );

        // Scheduled tasks are one-shot — prune CLI session immediately so
        // they don't accumulate as zombie entries across restarts.
        this.processor.clearCliSessionsByConvId?.(executionBoundary.channel, task.recipient ?? senderKey);

        // Adaptive scheduling: adjust cron frequency based on findings
        if (isScheduledCron) {
          const hadFindings = !isEmpty;
          // Determine priority from proposals created
          const findingPriority = proposalsCreated > 0 ? "high" : undefined;
          adjustScheduleFrequency(this.db, task.name, hadFindings, findingPriority);
        }

        // Suppress delivery for empty heartbeat/scout responses
        if (isPresenceHeartbeatTask(task.name)) {
          recordPresenceHeartbeat(this.db, result.response, isEmpty, now, task.agent);
        }

        let notificationDelivered = false;
        let artifactSuppressionReason = notificationSuppressionReason;

        if (notificationSuppressionReason) {
          logger.debug(`[scheduler] Suppressed ${notificationSuppressionReason} response from ${task.name}`);
        } else {
          // Deliver to iOS channel if task targets ios:* channel
          if (task.channel?.startsWith("ios:") && result.response) {
            const iosChannel = this.processor.getChannels()?.find(c => c.name === "ios");
            if (iosChannel?.sendOutbound) {
              try {
                await iosChannel.sendOutbound(task.channel, result.response, task.agent);
                this.processor.emitEvent("agent:outbound", {
                  channel: task.channel,
                  agent: task.agent,
                  message: result.response.substring(0, 200),
                  source: "scheduler",
                  task_name: task.name,
                });
              } catch (err) {
                logger.warn(`[scheduler] iOS delivery failed for ${task.name}: ${err}`);
              }
            }
          }

          if (result.response) {
            notificationDelivered = await this.deliverToNotifyChannels(task, result.response, "completed");
            if (shouldNotifyResult && !notificationDelivered) {
              artifactSuppressionReason = "delivery_failed";
            }
            if (notificationDelivered && task.notify_channels && notificationSignature) {
              this.db.run(
                "UPDATE scheduled_tasks SET last_notification_signature = ?, last_notified_at = ?, updated_at = ? WHERE id = ?",
                [notificationSignature, Date.now(), Date.now(), task.id],
              );
            }
          }
        }

        this.processor.getTraces?.()?.recordScheduledRunArtifact({
          taskId: task.id,
          taskName: task.name,
          traceId: result.trace_id ?? null,
          question: schedulerQuestionForTask(task),
          decision: schedulerDecisionForResult(task, "completed", result.response, Boolean(notificationSuppressionReason)),
          outcome: "completed",
          evidence: {
            proposalsCreated,
            empty: isEmpty,
            authorityProfile: normalizeAuthorityProfile(task.authority_profile),
            channel: executionBoundary.channel,
            notificationSuppressionReason: artifactSuppressionReason,
            responseExcerpt: result.response?.slice(0, 500) ?? null,
          },
          artifacts: [
            ...(result.trace_id ? [{ kind: "trace", ref: result.trace_id }] : []),
            { kind: "scheduled_task", ref: task.id },
          ],
          notified: notificationDelivered,
          suppressionReason: artifactSuppressionReason,
          notificationSignature,
          modelTrustTier: modelTrust.tier as ModelTrustTier,
          startedAt: now,
          completedAt: Date.now(),
        });

        // Persist briefing output to Obsidian vault
        if (task.name === "briefing:daily" && result.response && !isEmpty) {
          try {
            const vaultPath = this.config.vault?.path;
            if (vaultPath) {
              const { writeFileSync, mkdirSync } = await import("node:fs");
              const { join } = await import("node:path");
              const date = new Date().toISOString().split("T")[0];
              const dailyDir = join(vaultPath, "Daily");
              mkdirSync(dailyDir, { recursive: true });
              writeFileSync(join(dailyDir, `${date}-briefing.md`), `# Daily Briefing — ${date}\n\n${result.response}\n`);
              logger.info(`[scheduler] Briefing persisted to ${dailyDir}/${date}-briefing.md`);
            }
          } catch (err) {
            logger.warn(`[scheduler] Failed to persist briefing to vault: ${err}`);
          }
        }

        logger.info(`[scheduler] Completed: ${task.name}${suppressEmptyResult ? " (suppressed)" : ` — ${result.response?.slice(0, 100) ?? "(no response)"}`}`);

        this.processor.emitEvent("scan:completed", {
          task_id: task.id,
          task_name: task.name,
          agent: task.agent,
          status: "completed",
          proposals_created: proposalsCreated,
          suppressed: suppressEmptyResult,
          result_preview: suppressEmptyResult ? null : result.response?.slice(0, 1000) ?? null,
        });

        // Task chaining: trigger next task if configured
        if (task.chain_to) {
          const chainRunId = randomUUID().slice(0, 8);
          this.triggerChain(task, result.response ?? "", isEmpty, chainRunId).catch(err =>
            logger.warn(`[scheduler] Chain from ${task.name} failed: ${err}`),
          );
        }
      } catch (err) {
        const consecutiveFailures = (task.consecutive_failures ?? 0) + 1;
        const tickInterval = this.config.scheduler?.tick_interval_ms ?? 60_000;
        const backoffMs = Math.min(tickInterval * 2 ** consecutiveFailures, 24 * 60 * 60 * 1000);
        const nextRunAt = now + backoffMs;
        const errorText = String(err);

        if (consecutiveFailures >= 10) {
          logger.error(`[scheduler] Task "${task.name}" auto-disabled after 10 consecutive failures`);
          this.db.run(
            `UPDATE scheduled_tasks SET
              last_run_at = ?, last_status = 'failed', last_error = ?,
              run_count = run_count + 1, next_run_at = ?, consecutive_failures = ?, enabled = 0, updated_at = ?
            WHERE id = ?`,
            [now, errorText, nextRunAt, consecutiveFailures, now, task.id],
          );
        } else {
          logger.error(`[scheduler] Task ${task.name} failed: ${err}`);
          this.db.run(
            `UPDATE scheduled_tasks SET
              last_run_at = ?, last_status = 'failed', last_error = ?,
              run_count = run_count + 1, next_run_at = ?, consecutive_failures = ?, updated_at = ?
            WHERE id = ?`,
            [now, errorText, nextRunAt, consecutiveFailures, now, task.id],
          );
        }

        const failureSignature = scheduledNotificationSignature(task, "failed", errorText);
        this.processor.getTraces?.()?.recordScheduledRunArtifact({
          taskId: task.id,
          taskName: task.name,
          traceId: null,
          question: schedulerQuestionForTask(task),
          decision: schedulerDecisionForResult(task, "failed", errorText, false),
          outcome: "failed",
          evidence: {
            error: errorText.slice(0, 1000),
            consecutiveFailures,
            nextRunAt,
            authorityProfile: normalizeAuthorityProfile(task.authority_profile),
          },
          artifacts: [{ kind: "scheduled_task", ref: task.id }],
          notified: Boolean(task.notify_channels),
          suppressionReason: null,
          notificationSignature: failureSignature,
          modelTrustTier: "tier_0_no_model",
          startedAt: now,
          completedAt: Date.now(),
        });

        this.processor.emitEvent("scan:completed", {
          task_id: task.id,
          task_name: task.name,
          agent: task.agent,
          status: "failed",
          error: errorText.substring(0, 200),
        });

        await this.deliverToNotifyChannels(task, errorText, "failed").catch(() => {});

        // Prune CLI session on failure too — no point resuming into a failed context
        this.processor.clearCliSessionsByConvId?.(task.channel, task.recipient ?? senderKey);
      }

      // Disable one-shot tasks after execution
      if (!task.cron_expression) {
        this.db.run("UPDATE scheduled_tasks SET enabled = 0, updated_at = ? WHERE id = ?", [now, task.id]);
      }
    } finally {
      this.runningTasks.delete(task.id);
    }
  }

  /**
   * Trigger a chained task after successful completion.
   * chain_to JSON: { task_name: string, inject_result?: boolean, only_if?: "has_findings" | "always" }
   */
  private async triggerChain(sourceTask: ScheduledTask, sourceResult: string, isEmpty: boolean, chainRunId: string): Promise<void> {
    if (!sourceTask.chain_to) return;

    let chain: { task_name: string; inject_result?: boolean; only_if?: string | string[] };
    try {
      chain = JSON.parse(sourceTask.chain_to);
    } catch {
      logger.warn(`[scheduler] [chain:${chainRunId}] Invalid chain_to JSON on ${sourceTask.name}: ${sourceTask.chain_to}`);
      return;
    }

    // Evaluate only_if condition(s)
    const conditionMet = this.evaluateChainCond(chain.only_if, sourceResult, isEmpty);
    if (!conditionMet) {
      logger.info(`[scheduler] [chain:${chainRunId}] ${sourceTask.name} → ${chain.task_name} SKIPPED (condition: ${JSON.stringify(chain.only_if ?? "has_findings")})`);
      return;
    }

    // Find the target task by name
    const target = this.db.query(
      "SELECT * FROM scheduled_tasks WHERE name = ? LIMIT 1",
    ).get(chain.task_name) as ScheduledTask | null;

    if (!target) {
      logger.warn(`[scheduler] [chain:${chainRunId}] ${sourceTask.name} → "${chain.task_name}" — target not found`);
      return;
    }

    if (this.runningTasks.has(target.id)) {
      logger.info(`[scheduler] [chain:${chainRunId}] ${sourceTask.name} → "${chain.task_name}" — target already running, skipping`);
      return;
    }
    if (target.enabled !== 1) {
      logger.info(`[scheduler] [chain:${chainRunId}] ${sourceTask.name} → "${chain.task_name}" — target disabled, skipping`);
      return;
    }

    logger.info(`[scheduler] [chain:${chainRunId}] ${sourceTask.name} → ${chain.task_name} TRIGGERED`);

    this.processor.emitEvent("chain:triggered", {
      chain_run_id: chainRunId,
      source_task: sourceTask.name,
      target_task: chain.task_name,
      condition: chain.only_if ?? "has_findings",
      inject_result: chain.inject_result !== false,
    });

    // Inject structured context packet if configured
    if (chain.inject_result !== false) {
      const packet = [
        "## Context Packet",
        "",
        "| Field | Value |",
        "|-------|-------|",
        `| Chain run | ${chainRunId} |`,
        `| Source task | ${sourceTask.name} |`,
        `| Category | ${sourceTask.category ?? "unknown"} |`,
        `| Agent | ${sourceTask.agent} |`,
        `| Run # | ${sourceTask.run_count} |`,
        `| Timestamp | ${new Date().toISOString()} |`,
        "",
        "### Source Output",
        "",
        sourceResult.slice(0, 3000),
        "",
        "---",
        "",
      ].join("\n");
      const chainedTask: ScheduledTask = {
        ...target,
        prompt: packet + target.prompt,
      };
      await this.executeTask(chainedTask);
    } else {
      await this.executeTask(target);
    }
  }

  /** Delegates to exported evaluateChainCondition for testability. */
  private evaluateChainCond(
    condition: string | string[] | undefined,
    sourceResult: string,
    isEmpty: boolean,
  ): boolean {
    return evaluateChainCondition(condition, sourceResult, isEmpty);
  }

  /**
   * Deliver task result to configured notify_channels.
   * Format: JSON array of "channel:recipientId" or plain "channel" strings.
   * Plain channel names fall back to daemon.owner_id as recipient.
   * Notification format: "[task.name] outcome: summary (truncated to 200 chars)"
   * except for digest-like tasks (briefings, heartbeats, self-improvement),
   * which send the full completed report directly.
   */
  private async deliverToNotifyChannels(task: ScheduledTask, result: string, outcome: "completed" | "failed"): Promise<boolean> {
    let delivered = false;
    if (task.notify_channels) {
      let targets: string[];
      try {
        targets = JSON.parse(task.notify_channels);
        if (!Array.isArray(targets)) targets = [];
      } catch {
        logger.warn(`[scheduler] Invalid notify_channels JSON for ${task.name}: ${task.notify_channels}`);
        targets = [];
      }

      const channels = this.processor.getChannels();
      if (!channels || channels.length === 0) {
        logger.warn(`[scheduler] No channels available — cannot deliver ${task.name} notifications to ${task.notify_channels}`);
      } else {
        // Briefings, heartbeats, and self-improvement reports are already
        // operator-facing digests — send the full completed text directly.
        // Other task results route through batcher if available.
        const isDigestTask = task.name.startsWith("briefing:") || task.name.startsWith("heartbeat:") || isScheduledSelfImprovementTask(task);
        const summary = result.substring(0, 200);
        const content = isDigestTask && outcome === "completed"
          ? result
          : `[${task.name}] ${outcome}: ${summary}${result.length > 200 ? "..." : ""}`;

        for (const target of targets) {
          const colonIdx = target.indexOf(":");
          let channelName: string;
          let recipientId: string | undefined;

          if (colonIdx !== -1) {
            channelName = target.substring(0, colonIdx);
            recipientId = target.substring(colonIdx + 1);
          } else {
            // Plain channel name — fall back to configured owner_id
            channelName = target;
            recipientId = this.config.daemon?.owner_id;
          }

          if (!recipientId) {
            logger.debug(`[scheduler] No recipient for channel "${channelName}" and no daemon.owner_id configured — skipping notification for ${task.name}`);
            continue;
          }

          const replyToId = task.notify_thread_id ?? undefined;
          const targetContent = boundScheduledNotificationContent(content, channelName);

          // Route through batcher for non-briefing results
          if (!isDigestTask && this._batcher) {
            const { defaultPriorityForType } = await import("../notifications/batcher.js");
            await this._batcher.queue(
              { channel: channelName, recipient: recipientId },
              { type: "reports", priority: defaultPriorityForType("reports"), content: targetContent, replyToId, queuedAt: Date.now() },
            );
            delivered = true;
            continue;
          }

          const ch = channels.find(c => c.name.toLowerCase() === channelName.toLowerCase());
          if (!ch?.sendOutbound) {
            logger.debug(`[scheduler] No sendOutbound for channel "${channelName}" — skipping notification for ${task.name}`);
            continue;
          }

          try {
            await ch.sendOutbound(recipientId, targetContent, undefined, replyToId);
            logger.info(`[scheduler] Delivered ${task.name} result to ${channelName}:${recipientId}`);
            delivered = true;
          } catch (err) {
            logger.warn(`[scheduler] Failed to deliver ${task.name} to ${channelName}:${recipientId}: ${err}`);
          }
        }
      }
    }

    // Fire per-task webhook if configured (fire-and-forget)
    if (task.webhook_url) {
      const webhookError = validateOutboundHttpUrl(task.webhook_url);
      if (webhookError) {
        logger.warn(`[scheduler] Skipping webhook for ${task.name}: ${webhookError}`);
        return delivered;
      }
      const payload = JSON.stringify({
        task_name: task.name,
        outcome,
        summary: result.substring(0, 500),
        completed_at: new Date().toISOString(),
      });
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      const secret = (this.config as any).daemon?.webhook_secret as string | undefined;
      if (secret) headers["Authorization"] = `Bearer ${secret}`;
      fetch(task.webhook_url, { method: "POST", headers, body: payload })
        .then(() => logger.info(`[scheduler] Webhook delivered for ${task.name} → ${task.webhook_url}`))
        .catch(err => logger.warn(`[scheduler] Webhook failed for ${task.name}: ${err}`));
    }
    return delivered;
  }

  private computeNextRun(task: ScheduledTask, afterMs = Date.now()): number {
    if (task.cron_expression) {
      const expr = parseCron(task.cron_expression);
      const stepMinutes = getMinuteStep(task.cron_expression);
      if (stepMinutes) {
        const seed = `${this.config.daemon?.name ?? "nyxhive"}:${task.id}:${task.agent}`;
        expr.minutes = phasedMinuteSet(stepMinutes, stableSchedulerPhaseOffsetMinutes(seed, stepMinutes));
      }
      return nextOccurrence(expr, new Date(afterMs)).getTime();
    }
    return Number.MAX_SAFE_INTEGER; // One-shot, won't run again
  }

  private repairPersistedSchedules(now = Date.now()): number {
    const tasks = this.db.query(
      "SELECT * FROM scheduled_tasks WHERE enabled = 1",
    ).all() as ScheduledTask[];
    const tickMs = this.config.scheduler?.tick_interval_ms ?? 60_000;
    const stalePastThresholdMs = Math.max(tickMs * 2, 5 * 60_000);
    let repaired = 0;

    for (const task of tasks) {
      const nextRunAt = Number(task.next_run_at);
      const invalidNextRun = !Number.isFinite(nextRunAt) || nextRunAt <= 0;

      if (task.cron_expression) {
        if (invalidNextRun || nextRunAt < now - stalePastThresholdMs) {
          try {
            const nextRun = this.computeNextRun(task, now);
            this.db.run(
              "UPDATE scheduled_tasks SET next_run_at = ?, last_error = NULL, updated_at = ? WHERE id = ?",
              [nextRun, now, task.id],
            );
            logger.warn(`[scheduler] Repaired next_run_at for ${task.name} → ${new Date(nextRun).toISOString()}`);
            repaired++;
          } catch (err) {
            this.db.run(
              `UPDATE scheduled_tasks SET
                enabled = 0, last_status = 'failed', last_error = ?, updated_at = ?
              WHERE id = ?`,
              [`Invalid cron expression during schedule repair: ${String(err)}`, now, task.id],
            );
            logger.warn(`[scheduler] Disabled ${task.name} during schedule repair: ${err}`);
            repaired++;
          }
        }
        continue;
      }

      if (invalidNextRun) {
        const runAt = Number(task.run_at);
        if (Number.isFinite(runAt) && runAt > 0) {
          this.db.run(
            "UPDATE scheduled_tasks SET next_run_at = ?, updated_at = ? WHERE id = ?",
            [runAt, now, task.id],
          );
        } else {
          this.db.run(
            `UPDATE scheduled_tasks SET
              enabled = 0, last_status = 'failed', last_error = ?, updated_at = ?
            WHERE id = ?`,
            ["Invalid one-shot schedule: next_run_at and run_at are missing or invalid", now, task.id],
          );
        }
        repaired++;
      }
    }

    return repaired;
  }

  private loadConfigTasks(): void {
    loadConfigTasks({ db: this.db, config: this.config, router: this.router, registry: this.registry, proposalStore: this._proposalStore });
  }

  private loadDefaultHeartbeat(): void {
    loadDefaultHeartbeat({ db: this.db, config: this.config, router: this.router, registry: this.registry, proposalStore: this._proposalStore });
  }

  private recalculateNextRuns(): void {
    const cronTasks = this.db.query(
      "SELECT * FROM scheduled_tasks WHERE enabled = 1 AND cron_expression IS NOT NULL",
    ).all() as ScheduledTask[];

    for (const task of cronTasks) {
      try {
        const nextRun = this.computeNextRun(task);
        this.db.run("UPDATE scheduled_tasks SET next_run_at = ?, last_error = NULL WHERE id = ?", [nextRun, task.id]);
      } catch (err) {
        this.db.run(
          `UPDATE scheduled_tasks SET
            enabled = 0, last_status = 'failed', last_error = ?, updated_at = ?
          WHERE id = ?`,
          [`Invalid cron expression during schedule recalculation: ${String(err)}`, Date.now(), task.id],
        );
        logger.warn(`[scheduler] Disabled ${task.name} during schedule recalculation: ${err}`);
      }
    }
  }

  private getTaskCount(): number {
    const row = this.db.query("SELECT COUNT(*) as count FROM scheduled_tasks WHERE enabled = 1").get() as { count: number };
    return row.count;
  }

  // --- CRUD for API ---

  addTask(task: {
    name: string;
    description?: string;
    cron_expression?: string;
    run_at?: number;
    agent: string;
    prompt: string;
    channel?: string;
    recipient?: string;
    created_by?: string;
    notify_channels?: string[];
    notify_thread_id?: string;
    webhook_url?: string;
    timeout_ms?: number;
    authority_profile?: SchedulerAuthorityProfile;
  }): string {
    const id = randomUUID();
    const now = Date.now();
    const nextRun = task.cron_expression
      ? nextOccurrence(parseCron(task.cron_expression)).getTime()
      : (task.run_at ?? now);

    this.db.run(
      `INSERT INTO scheduled_tasks
        (id, name, description, cron_expression, run_at, agent, prompt, channel, recipient, notify_channels, notify_thread_id, webhook_url, timeout_ms, authority_profile, enabled, next_run_at, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      [
        id,
        task.name,
        task.description ?? null,
        task.cron_expression ?? null,
        task.run_at ?? null,
        task.agent,
        task.prompt,
        task.channel ?? "api",
        task.recipient ?? null,
        task.notify_channels ? JSON.stringify(task.notify_channels) : null,
        task.notify_thread_id ?? null,
        task.webhook_url ?? null,
        normalizeSchedulerTimeoutMs(task.timeout_ms) ?? null,
        normalizeAuthorityProfile(task.authority_profile),
        nextRun,
        task.created_by ?? "api",
        now,
        now,
      ],
    );

    return id;
  }

  updateTask(id: string, updates: Partial<{
    name: string;
    description: string;
    cron_expression: string;
    agent: string;
    prompt: string;
    channel: string;
    recipient: string;
    enabled: boolean;
    notify_channels: string[];
    notify_thread_id: string;
    webhook_url: string;
    timeout_ms: number;
    authority_profile: SchedulerAuthorityProfile;
  }>): void {
    const sets: string[] = [];
    const values: (string | number | null)[] = [];

    if (updates.name !== undefined) { sets.push("name = ?"); values.push(updates.name); }
    if (updates.description !== undefined) { sets.push("description = ?"); values.push(updates.description); }
    if (updates.cron_expression !== undefined) { sets.push("cron_expression = ?"); values.push(updates.cron_expression); }
    if (updates.agent !== undefined) { sets.push("agent = ?"); values.push(updates.agent); }
    if (updates.prompt !== undefined) { sets.push("prompt = ?"); values.push(updates.prompt); }
    if (updates.channel !== undefined) { sets.push("channel = ?"); values.push(updates.channel); }
    if (updates.recipient !== undefined) { sets.push("recipient = ?"); values.push(updates.recipient); }
    if (updates.enabled !== undefined) { sets.push("enabled = ?"); values.push(updates.enabled ? 1 : 0); }
    if (updates.notify_channels !== undefined) { sets.push("notify_channels = ?"); values.push(JSON.stringify(updates.notify_channels)); }
    if (updates.notify_thread_id !== undefined) { sets.push("notify_thread_id = ?"); values.push(updates.notify_thread_id); }
    if (updates.webhook_url !== undefined) { sets.push("webhook_url = ?"); values.push(updates.webhook_url); }
    if (updates.timeout_ms !== undefined) { sets.push("timeout_ms = ?"); values.push(normalizeSchedulerTimeoutMs(updates.timeout_ms) ?? null); }
    if (updates.authority_profile !== undefined) { sets.push("authority_profile = ?"); values.push(normalizeAuthorityProfile(updates.authority_profile)); }

    if (sets.length === 0) return;

    sets.push("updated_at = ?");
    values.push(Date.now());
    values.push(id);

    this.db.run(`UPDATE scheduled_tasks SET ${sets.join(", ")} WHERE id = ?`, values);

    // Recalculate next run if cron changed
    if (updates.cron_expression !== undefined) {
      const task = this.getTask(id);
      if (task) {
        const nextRun = this.computeNextRun(task);
        this.db.run("UPDATE scheduled_tasks SET next_run_at = ? WHERE id = ?", [nextRun, id]);
      }
    }
  }

  deleteTask(id: string): void {
    this.db.run("DELETE FROM scheduled_tasks WHERE id = ?", [id]);
  }

  getTask(id: string): ScheduledTask | null {
    return this.db.query("SELECT * FROM scheduled_tasks WHERE id = ?").get(id) as ScheduledTask | null;
  }

  getTaskByName(name: string): ScheduledTask | null {
    return this.db.query("SELECT * FROM scheduled_tasks WHERE name = ?").get(name) as ScheduledTask | null;
  }

  listTasks(includeDisabled = false): ScheduledTask[] {
    if (includeDisabled) {
      return this.db.query("SELECT * FROM scheduled_tasks ORDER BY next_run_at ASC").all() as ScheduledTask[];
    }
    return this.db.query("SELECT * FROM scheduled_tasks WHERE enabled = 1 ORDER BY next_run_at ASC").all() as ScheduledTask[];
  }

  async triggerTask(id: string, options: ExecuteTaskOptions = {}): Promise<void> {
    const task = this.getTask(id);
    if (!task) throw new Error(`Task ${id} not found`);
    await this.executeTask(task, options);
  }

  private async executeSystemTask(task: ScheduledTask): Promise<string> {
    switch (task.name) {
      case "briefing:auto-review": {
        const { reviewed } = await this.autoReviewPendingProposals();
        return `Auto-reviewed ${reviewed} pending proposals`;
      }
      case "dev:execute-approved": {
        const { executed, failed, skipped } = await this.executeApprovedProposals();
        return `Executed ${executed}, failed ${failed}, skipped ${skipped}`;
      }
      case "proposals:sync-merged": {
        const synced = await this.syncMergedProposals();
        return `Synced ${synced} merged proposals`;
      }
      case "proposals:reset-stale-reviewing": {
        if (!this._proposalStore) return "No proposal store configured";
        const reset = this._proposalStore.resetStaleReviewing();
        return `Reset ${reset} stale reviewing proposals`;
      }
      case "memory:maintenance": {
        const results: string[] = [];

        const graphMemory = this.processor.getGraphMemory();
        if (graphMemory) {
          graphMemory.decayImportance();
          const pruned = graphMemory.pruneExpired();
          const prunedLow = graphMemory.pruneByImportance(0.05);
          results.push(`Graph: decayed importance, pruned ${pruned} expired + ${prunedLow} low-importance nodes`);
        }

        const knowledge = this.processor.getKnowledge();
        if (knowledge) {
          const pruned = knowledge.pruneStale(90);
          const stats = knowledge.getStats();
          results.push(`Knowledge: pruned ${pruned} stale chunks. Tiers: ${JSON.stringify(stats.tiers ?? {})}`);
        }

        const routing = this.processor.getRouting();
        if (routing) {
          const pruned = routing.prune(90);
          results.push(`Routing: pruned ${pruned} old decisions`);
        }

        const traces = this.processor.getTraces();
        if (traces) {
          const pruned = traces.pruneOldTraces(30);
          results.push(`Traces: pruned ${pruned.traces} traces + ${pruned.events} events older than 30d`);
          if (pruned.traces + pruned.events > 500) {
            try {
              this.db.exec("VACUUM");
              results.push("VACUUM completed");
            } catch (err) {
              results.push(`VACUUM failed: ${err}`);
            }
          }
        }

        const classifierFeedback = this.processor.getClassifierFeedback();
        if (classifierFeedback) {
          const pruned = classifierFeedback.prune(90);
          results.push(`Classifier feedback: pruned ${pruned} entries older than 90d`);
        }

        return results.join(". ") || "No memory stores configured";
      }
      case "learning:distill-patterns": {
        const outcomesStore = this.processor.getOutcomes();
        const patternStore = this.processor.getPatterns();
        if (!outcomesStore || !patternStore) return "Outcome or pattern store not configured";
        if (!this.router) return "Router not configured for distillation";

        const result = await distillPatterns({
          outcomes: outcomesStore,
          patterns: patternStore,
          router: this.router,
        });

        return `Distilled ${result.patterns_extracted} patterns from ${result.agents_processed} agents. Pruned: ${result.patterns_pruned} old + ${result.expired_pruned} expired`;
      }
      case "crawl:run-sources": {
        if (!this.crawlService || !this.crawlSources || !this.crawlIngest) return "Crawl pipeline not configured";
        const dueSources = this.crawlSources.getDue();
        if (dueSources.length === 0) return "No crawl sources due";

        const summaries: string[] = [];
        for (const source of dueSources) {
          try {
            const results = await this.crawlService.crawlSite(source.url, {
              depth: source.depth,
              limit: source.pageLimit,
              pathGlob: source.pathGlob ?? undefined,
              modifiedSince: source.lastCrawlAt ?? undefined,
            });
            const stats = await this.crawlIngest.ingestCrawlResults(results, source);
            this.crawlSources.updateAfterCrawl(source.id, "completed", {
              pagesFound: results.length,
              chunksCreated: stats.chunksCreated,
            });
            summaries.push(`${source.name}: ${stats.pagesProcessed} pages, ${stats.chunksCreated} chunks`);
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.crawlSources.updateAfterCrawl(source.id, "failed", { lastError: message });
            summaries.push(`${source.name}: failed (${message})`);
          }
        }

        return summaries.join("; ");
      }
      case "crawl:cleanup-stale": {
        if (!this.crawlSources) return "Crawl source store not configured";
        const knowledge = this.processor.getKnowledge();
        if (!knowledge) return "Knowledge store not configured";

        const inactiveSources = this.crawlSources.getInactive();
        if (inactiveSources.length === 0) return "No inactive crawl sources";

        let deleted = 0;
        for (const source of inactiveSources) {
          deleted += knowledge.deleteBySourceAgent(`crawl:${source.name}`);
        }

        return `Removed ${deleted} crawl chunks from ${inactiveSources.length} inactive sources`;
      }
      case "routing:cleanup-stale": {
        const routing = this.processor.getRouting();
        if (!routing) return "Routing store not configured";

        const stale = routing.getStale(120); // unresolved for >2 hours
        let resolved = 0;
        for (const decision of stale) {
          routing.resolveDecision(decision.id, "abandoned");
          resolved++;
        }

        return resolved > 0
          ? `Resolved ${resolved} stale routing decisions as abandoned`
          : "ok";
      }
      case "learning:scout-effectiveness": {
        if (!this._proposalStore) return "Proposal store not configured";

        const { generateScoutReport, persistScoutReport } = await import("../learning/analysis.js");
        const knowledge = this.processor.getKnowledge();
        const embedder = this.processor.getEmbedder();
        if (!knowledge || !embedder) return "Knowledge or embedding store not configured";

        const since = Date.now() - 7 * 24 * 60 * 60 * 1000; // last 7 days
        const report = generateScoutReport(this._proposalStore, since);
        await persistScoutReport(report, knowledge, embedder, this.config.vault?.path);

        return `Scout report: ${report.totalProposed} proposals, ${report.stats.length} sources analyzed`;
      }
      case "watchdog:stuck-detection": {
        if (!this.registry) return "No registry configured";
        const defaultThreshold = 30 * 60 * 1000; // 30 minutes
        const stuck = this.registry.getStuckAgents(defaultThreshold);
        if (stuck.length === 0) return "No stuck agents";

        const results: string[] = [];
        for (const [agentKey, entry] of stuck) {
          const duration = Math.round((Date.now() - entry.heartbeatAt) / 60_000);

          // Kill the process
          if (entry.pid) {
            try { process.kill(entry.pid, "SIGTERM"); } catch { /* already dead */ }
          }
          entry.abortController?.abort();

          // Record failure
          this.registry.markIdle(agentKey);
          this.registry.recordInvocation(agentKey, { tokensIn: 0, tokensOut: 0, success: false, costCents: 0 });

          // Update consecutive_stuck in DB
          this.db.run(
            "UPDATE agent_registry SET consecutive_stuck = consecutive_stuck + 1 WHERE key = ?",
            [agentKey],
          );

          const consecutiveStuck = (this.db.query("SELECT consecutive_stuck FROM agent_registry WHERE key = ?").get(agentKey) as { consecutive_stuck: number } | null)?.consecutive_stuck ?? 0;

          // Broadcast event
          this.processor.emitEvent("agent:status", { agent: agentKey, status: "error", task: null });
          emitActivity({
            type: "watchdog",
            agent: agentKey,
            action: "stuck",
            subject: `${agentKey} stuck for ${duration}m`,
            detail: consecutiveStuck >= 3 ? "Auto-disabled" : "Process killed",
          });

          if (consecutiveStuck >= 3) {
            const disableResult = this.registry.disable(agentKey);
            if (!disableResult.success) {
              results.push(`${agentKey}: stuck ${duration}m — config-protected, cannot disable (${consecutiveStuck} consecutive)`);
            } else {
              results.push(`${agentKey}: stuck ${duration}m — DISABLED (${consecutiveStuck} consecutive)`);
            }
          } else {
            results.push(`${agentKey}: stuck ${duration}m — process killed`);
          }
        }
        return results.join("\n");
      }
      case "docs:sync": {
        const vaultPath = this.config.vault?.path;
        if (!vaultPath) return "No vault configured, skipping docs:sync";

        const { writeFileSync, mkdirSync } = await import("node:fs");
        const { join } = await import("node:path");
        const sections: string[] = [
          "# NyxHive System State",
          `Generated: ${new Date().toISOString()}`,
          "",
        ];

        // Agent roster
        sections.push("## Agents\n");
        const agents = Object.entries(this.config.agents ?? {});
        for (const [key, agent] of agents) {
          sections.push(`- **${agent.name}** (\`${key}\`): ${agent.model} via ${agent.provider}, role: ${agent.role ?? "worker"}`);
        }

        // Scheduled tasks
        sections.push("\n## Scheduled Tasks\n");
        const tasks = this.db.prepare(
          "SELECT name, cron_expression, agent, last_status, run_count FROM scheduled_tasks WHERE enabled = 1 ORDER BY name",
        ).all() as Array<{ name: string; cron_expression: string | null; agent: string; last_status: string | null; run_count: number }>;
        for (const t of tasks) {
          sections.push(`- **${t.name}** (${t.agent}): \`${t.cron_expression ?? "one-shot"}\` | runs: ${t.run_count} | last: ${t.last_status ?? "never"}`);
        }

        // Learned patterns
        const patterns = this.processor.getPatterns();
        if (patterns) {
          const all = patterns.getAll();
          if (all.length > 0) {
            sections.push("\n## Learned Patterns\n");
            for (const p of all.slice(-20)) {
              sections.push(`- [${p.category}] ${p.pattern} (confidence: ${p.confidence})`);
            }
          }
        }

        // Routing skill matrix
        const routing = this.processor.getRouting();
        if (routing) {
          const matrix = routing.getSkillMatrix?.();
          if (matrix && matrix.length > 0) {
            sections.push("\n## Routing Skill Matrix\n");
            for (const entry of matrix.slice(0, 20)) {
              sections.push(`- ${entry.agent} / ${entry.task_type}: ${entry.success_rate}% success (${entry.total} tasks)`);
            }
          }
        }

        // Cost summary (last 7 days)
        const traces = this.processor.getTraces();
        if (traces) {
          const history = traces.getDailyCostHistory(7);
          if (history.length > 0) {
            sections.push("\n## Cost History (7 days)\n");
            for (const d of history) {
              sections.push(`- ${d.date}: $${d.cost.toFixed(2)}`);
            }
          }
        }

        const docsDir = join(vaultPath, "System");
        mkdirSync(docsDir, { recursive: true });
        const content = sections.join("\n");
        writeFileSync(join(docsDir, "system-state.md"), content);
        return `Docs synced: ${agents.length} agents, ${tasks.length} tasks, written to ${docsDir}/system-state.md`;
      }
      default: {
        // Shell task: name must start with "shell:" — runs task.prompt as a shell command
        if (task.name.startsWith("shell:")) {
          const proc = Bun.spawn(["sh", "-c", task.prompt], {
            stdout: "pipe",
            stderr: "pipe",
          });
          const [stdout, stderr] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
          ]);
          await proc.exited;
          const output = (stdout + stderr).trim();
          return output.slice(0, 2000) || "Done (no output)";
        }
        throw new Error(`Unknown system task: ${task.name}`);
      }
    }
  }

  private async executeApprovedProposals(): Promise<{ executed: number; failed: number; skipped: number }> {
    if (!this._proposalStore) return { executed: 0, failed: 0, skipped: 0 };

    const approved = this._proposalStore.list({ status: "approved" });
    if (approved.length === 0) return { executed: 0, failed: 0, skipped: 0 };

    // Sort by priority: high → medium → low
    const priorityOrder: Record<string, number> = { high: 0, medium: 1, low: 2 };
    approved.sort((a, b) => (priorityOrder[a.priority] ?? 1) - (priorityOrder[b.priority] ?? 1));

    // Concurrency limit: only process top N per batch, rest stay approved for next tick
    const maxConcurrent = this.config.proposals?.max_concurrent_executions ?? 2;
    const batch = approved.slice(0, maxConcurrent);
    const skippedCount = approved.length - batch.length;
    if (skippedCount > 0) {
      logger.info(`[scheduler] Capped execution batch to ${maxConcurrent} (${skippedCount} deferred to next tick)`);
    }

    logger.info(`[scheduler] Executing ${batch.length} approved proposals`);
    let executed = 0;
    let failed = 0;
    let skipped = skippedCount;

    for (const proposal of batch) {
      const agent = this.processor.resolveProposalAgent(proposal.category, proposal.files_affected);
      const repoPath = this.processor.resolveProposalRepoPath(proposal.files_affected);
      const branch = proposalBranchName(proposal.proposal_id);
      const filesInfo = proposal.files_affected.length > 0
        ? `Files to modify:\n${proposal.files_affected.map(f => `- ${repoPath}/${f}`).join("\n")}`
        : "No specific files listed.";

      // Inject learned patterns relevant to this execution
      let patternsContext = "";
      const patternStore = this.processor.getPatterns();
      if (patternStore) {
        const patterns = patternStore.searchRelevant({
          agent,
          taskType: proposal.category,
          filePaths: proposal.files_affected,
        });
        const formatted = patternStore.formatForInjection(patterns);
        if (formatted) patternsContext = `\n\n${formatted}`;
      }

      const claimed = this._proposalStore.markExecuting(proposal.proposal_id, `exec-${proposal.proposal_id}`);
      if (!claimed) {
        logger.warn(`[scheduler] Proposal ${proposal.proposal_id} no longer approved — skipping execution`);
        skipped++;
        continue;
      }
      logger.info(`[scheduler] Executing proposal ${proposal.proposal_id}: "${proposal.title}" via ${agent}`);

      try {
        // System categories (new_instance, configuration) go to orchestrator — use delegation prompt.
        // Code categories go directly to coder — use direct implementation prompt.
        const isOrchestratorRoute = ["new_instance", "configuration"].includes(proposal.category);
        const message = isOrchestratorRoute
          ? `Execute this approved proposal by delegating to the appropriate agent. Do NOT do the work yourself — delegate it.\n\n[Approved proposal ${proposal.proposal_id}]\nTitle: ${proposal.title}\nCategory: ${proposal.category}\nEffort: ${proposal.effort}\n\n${proposal.description}\n\n${filesInfo}${patternsContext}\n\nWorking directory: ${repoPath}\nGit branch: ${branch}\n\nThe agent should:\n1. cd ${repoPath}\n2. git checkout main || git checkout master && git pull\n3. git checkout -b ${branch}\n4. Implement the changes\n5. Commit and push\n6. gh pr create --title "${proposal.title}" --body "Implements proposal ${proposal.proposal_id}"\n\nDo NOT merge the PR.`
          : `[Auto-approved proposal ${proposal.proposal_id}]\n\n${proposal.description}\n\n${filesInfo}${patternsContext}\n\nWorking directory: ${repoPath}\n\n## Git Workflow — follow these steps:\n1. cd ${repoPath}\n2. git checkout main || git checkout master && git pull\n3. git checkout -b ${branch}\n4. Make the changes\n5. Commit (feat/fix/chore as appropriate)\n6. git push -u origin ${branch}\n7. gh pr create --title "${proposal.title}" --body "Implements proposal ${proposal.proposal_id}"\n\nDo NOT merge the PR. Create it and report the PR URL.`;

        const result = await this.processor.processImmediate({
          channel: "system",
          sender: `proposal-exec:${proposal.proposal_id}`,
          message,
          agent,
          trust: "system",
          modelOverride: DEFAULT_PROPOSAL_EXECUTION_MODEL,
        });

        // Run verification (test/build) if configured for this project
        const projects = this.config.daemon?.projects;
        const verifyConfig = resolveVerifyConfig(repoPath, projects);
        if (verifyConfig) {
          const verification = await runVerification(repoPath, verifyConfig);
          if (!verification.passed) {
            const failedSteps = verification.steps.filter(s => !s.passed);
            const summary = failedSteps.map(s => `${s.name}: ${s.output.slice(0, 500)}`).join("\n\n");
            this._proposalStore.markFailed(proposal.proposal_id, `Verification failed:\n${summary}`, result.agent);
            logger.warn(`[scheduler] Proposal ${proposal.proposal_id} verification failed: ${failedSteps.map(s => s.name).join(", ")}`);
            failed++;
            continue;
          }
          logger.info(`[scheduler] Proposal ${proposal.proposal_id} verification passed`);
        }

        let prUrl = extractPrUrl(result.response);
        this._proposalStore.markCompleted(proposal.proposal_id, result.response, result.agent, prUrl);

        // Auto-create PR if agent didn't
        if (!prUrl) {
          const { createPrForBranch } = await import("../proposals/pr-utils.js");
          const createdPrUrl = createPrForBranch(branch, proposal.title, proposal.proposal_id, repoPath);
          if (createdPrUrl) {
            prUrl = createdPrUrl;
            this._proposalStore.setPrUrl(proposal.proposal_id, createdPrUrl);
            logger.info(`[scheduler] Auto-created PR for ${proposal.proposal_id}: ${createdPrUrl}`);
          }
        }

        // Emit proposal:completed for learning listeners
        this.processor.emitEvent("proposal:completed", {
          proposal_id: proposal.proposal_id,
          title: proposal.title,
          category: proposal.category,
          description: proposal.description,
          files_affected: proposal.files_affected,
          executed_by: result.agent,
          response_excerpt: result.response.slice(0, 2000),
          pr_url: prUrl ?? null,
        });

        logger.info(`[scheduler] Proposal ${proposal.proposal_id} completed${prUrl ? ` — PR: ${prUrl}` : ""}`);
        executed++;
      } catch (err) {
        this._proposalStore.markFailed(proposal.proposal_id, String(err), agent);
        logger.error(`[scheduler] Proposal ${proposal.proposal_id} failed: ${err}`);
        failed++;

        // Notify owner about failure
        const failedProposal = this._proposalStore.get(proposal.proposal_id);
        if (failedProposal) {
          this.notifyProposalEvent(failedProposal, "failed").catch(() => {});
        }
      }
    }

    return { executed, failed, skipped };
  }

  private async autoReviewPendingProposals(): Promise<{ reviewed: number }> {
    if (!this._proposalStore) return { reviewed: 0 };
    const pending = this._proposalStore.list().filter((p) => p.status === "proposed");
    if (pending.length === 0) {
      logger.info("[scheduler] Auto-review: no pending proposals");
      return { reviewed: 0 };
    }

    logger.info(`[scheduler] Auto-review: ${pending.length} proposals to review`);
    let reviewed = 0;
    const reviewAgent = this.processor.resolveReviewAgent(["nyx", "analyst"]);

    for (const proposal of pending) {
      const reviewSender = `proposal-review:${proposal.proposal_id}`;
      try {
        if (!this._proposalStore.markReviewing(proposal.proposal_id)) {
          logger.info(`[scheduler] Auto-review skipped for ${proposal.proposal_id}: already reviewing or no longer reviewable`);
          continue;
        }

        const reviewPrompt = `You are reviewing a proposal from a less experienced agent. User trusts YOUR judgment — give a clear verdict. Read the affected files in the codebase before judging.

Title: ${proposal.title}
Category: ${proposal.category}
Priority: ${proposal.priority}
Effort: ${proposal.effort}
Description: ${proposal.description}
Files affected: ${proposal.files_affected?.join(", ") || "none listed"}
Proposed by: ${proposal.proposed_by}

Do your analysis, then END your review with this exact format:

---
**Verdict: APPROVE** (or REJECT)
**Why:** 1-2 sentences explaining your reasoning in plain language.
**Effort:** Your corrected estimate (trivial/small/medium/large) if different from proposed.
---

If the proposal has minor issues, fix them yourself and approve with corrections. Only REJECT if fundamentally wrong or not worth doing. There is no "needs modification".`;

        const result = await this.processor.processImmediate({
          channel: "system",
          sender: reviewSender,
          message: reviewPrompt,
          agent: reviewAgent,
          trust: "system",
          modelOverride: this.processor.resolveProposalReviewModel(["nyx", "analyst"]),
        });

        this._proposalStore.saveReview(proposal.proposal_id, result.response, result.agent);
        const reviewed2 = this._proposalStore.get(proposal.proposal_id);
        if (reviewed2) {
          this.processor.emitEvent("proposal:reviewed", {
            proposalId: proposal.proposal_id,
            status: reviewed2.status,
            verdict: reviewed2.verdict,
          });

          const autoAdvance = autoAdvanceReviewedProposal(this._proposalStore, proposal.proposal_id, result.agent);
          if (autoAdvance.advanced && autoAdvance.proposal) {
            this.processor.emitEvent("proposal:approved", {
              proposal_id: proposal.proposal_id,
              title: autoAdvance.proposal.title,
              category: autoAdvance.proposal.category,
              proposed_by: autoAdvance.proposal.proposed_by,
              approved_by: result.agent,
              auto_advanced: true,
              reason: autoAdvance.reason,
            });
            this.processor.getProposalExecutor()?.onApproved(proposal.proposal_id, "auto").catch((err) =>
              logger.error(`[scheduler] Auto-advance execution failed for ${proposal.proposal_id}: ${err}`),
            );
          }
        }
        this.processor.clearConversation("system", reviewSender);
        reviewed++;
        logger.info(`[scheduler] Auto-reviewed: ${proposal.title}`);
      } catch (err) {
        logger.error(`[scheduler] Auto-review failed for ${proposal.proposal_id}: ${err}`);
        this._proposalStore.saveReview(proposal.proposal_id, `Review failed: ${err}`, "system");
        this.processor.emitEvent("proposal:reviewed", { proposalId: proposal.proposal_id, status: "reviewed", verdict: null });
        this.processor.clearConversation("system", reviewSender);
      }
    }

    return { reviewed };
  }

  private async syncMergedProposals(): Promise<number> {
    if (!this._proposalStore) return 0;
    const completed = this._proposalStore.listCompletedWithPR();
    if (completed.length === 0) return 0;

    let synced = 0;
    for (const proposal of completed) {
      const prNumber = proposal.pr_url?.match(/\/pull\/(\d+)/)?.[1];
      if (!prNumber) continue;

      const repoPath = this.processor.resolveProposalRepoPath(proposal.files_affected);
      const state = checkPrState(prNumber, repoPath);

      if (state === "MERGED") {
        this._proposalStore.markMerged(proposal.proposal_id, "auto-sync");
        logger.info(`[scheduler] Auto-synced merged PR for ${proposal.proposal_id}`);
        synced++;
        emitActivity({ type: "system", agent: "system", action: "merged", subject: proposal.title, detail: proposal.pr_url ?? undefined });

        // Notify owner about merge
        const mergedProposal = this._proposalStore.get(proposal.proposal_id);
        if (mergedProposal) {
          this.notifyProposalEvent(mergedProposal, "merged").catch(() => {});
        }
      } else if (state === "CLOSED") {
        // PR was closed without merge — mark as failed so it surfaces
        this._proposalStore.markFailed(proposal.proposal_id, "PR closed without merge", "auto-sync");
        logger.warn(`[scheduler] PR closed without merge for ${proposal.proposal_id}`);

        const closedProposal = this._proposalStore.get(proposal.proposal_id);
        if (closedProposal) {
          this.notifyProposalEvent(closedProposal, "closed").catch(() => {});
        }
      } else if (state === "OPEN") {
        // Check mergeability for open PRs
        const mergeable = checkPrMergeable(prNumber, repoPath);
        if (mergeable) {
          this._proposalStore.setPrMergeable(proposal.proposal_id, mergeable);
          if (mergeable === "CONFLICTING") {
            logger.info(`[scheduler] PR has conflicts for ${proposal.proposal_id}`);
          }
        }
      }
    }
    return synced;
  }

  /** Send a proposal event notification to all configured channels */
  private async notifyProposalEvent(proposal: import("../proposals/store.js").Proposal, event: "failed" | "merged" | "closed"): Promise<void> {
    const proposalTargets = resolveNotificationTargets(this.config, "proposals");
    const channels = this.processor.getChannels();
    if (proposalTargets.length === 0 || !channels) return;

    const id = proposal.proposal_id.replace("proposal-", "");
    let message: string;
    if (event === "failed") {
      const reason = proposal.execution_result?.slice(0, 200) ?? "unknown error";
      message = `Proposal #${id} failed: "${proposal.title}"\nReason: ${reason}\nRetry: approve ${id}`;
    } else if (event === "merged") {
      message = `Proposal #${id} merged: "${proposal.title}"${proposal.pr_url ? `\nPR: ${proposal.pr_url}` : ""}`;
    } else {
      message = `Proposal #${id} PR closed without merge: "${proposal.title}"${proposal.pr_url ? `\nPR: ${proposal.pr_url}` : ""}`;
    }

    for (const target of proposalTargets) {
      const ch = channels.find(c => c.name.toLowerCase() === target.channel.toLowerCase());
      if (!ch?.sendOutbound) continue;
      try {
        await ch.sendOutbound(target.recipient, message);
      } catch (err) {
        logger.debug(`[scheduler] ${event} notification failed for ${proposal.proposal_id} on ${target.channel}: ${err}`);
      }
    }
  }

  getTaskResult(id: string): { task_name: string; agent: string; last_status: string | null; last_result: string | null; last_run_at: number | null } | null {
    const task = this.getTask(id) ?? this.getTaskByName(id);
    if (!task) return null;
    return {
      task_name: task.name,
      agent: task.agent,
      last_status: task.last_status,
      last_result: task.last_result,
      last_run_at: task.last_run_at,
    };
  }

  getStats(): { total: number; enabled: number; upcoming: ScheduledTask[]; totalRuns: number; failures: number } {
    const total = (this.db.query("SELECT COUNT(*) as c FROM scheduled_tasks").get() as { c: number }).c;
    const enabled = (this.db.query("SELECT COUNT(*) as c FROM scheduled_tasks WHERE enabled = 1").get() as { c: number }).c;
    const upcoming = this.db.query(
      "SELECT * FROM scheduled_tasks WHERE enabled = 1 ORDER BY next_run_at ASC LIMIT 5",
    ).all() as ScheduledTask[];
    const totalRuns = (this.db.query("SELECT SUM(run_count) as c FROM scheduled_tasks").get() as { c: number }).c ?? 0;
    const failures = (this.db.query("SELECT COUNT(*) as c FROM scheduled_tasks WHERE last_status = 'failed'").get() as { c: number }).c;

    return { total, enabled, upcoming, totalRuns, failures };
  }
}

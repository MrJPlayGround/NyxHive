import { logger } from "../../utils/logger.js";
import { withRetry } from "../../utils/retry.js";
import { toRelativePath, stripAbsolutePaths } from "../../utils/paths.js";
import type { ParsedChannelInputRequest } from "../../types.js";
import { humanStatusFromActivity } from "../tool-activity.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SlackPhase =
  | "planning"
  | "running_commands"
  | "editing_files"
  | "reviewing"
  | "waiting_approval"
  | "waiting_input"
  | "completing"
  | "completed"
  | "failed";

const PHASE_LABELS: Record<SlackPhase, string> = {
  planning: ":thought_balloon: Nyx is thinking...",
  running_commands: ":terminal: Nyx is working...",
  editing_files: ":pencil2: Nyx is working...",
  reviewing: ":mag: Nyx is checking context...",
  waiting_approval: ":raised_hand: Waiting for approval",
  waiting_input: ":question: Waiting for input",
  completing: ":hourglass_flowing_sand: Nyx is thinking...",
  completed: ":white_check_mark: Completed",
  failed: ":x: Failed",
};

export interface ApprovalRequestData {
  proposalId: string;
  title: string;
  description?: string;
  category?: string;
  effort?: string;
  filesAffected?: string[];
}

export type InputRequestData = ParsedChannelInputRequest;

export interface ChangeSummaryData {
  files: Array<{ path: string; added: number; removed: number; operation?: string }>;
  summary?: string;
  verified?: boolean;
  threadId?: string;
}

export interface CompletionSummaryData {
  text: string;
  agent?: string;
  durationMs?: number;
  tokensIn?: number;
  tokensOut?: number;
  cost?: number;
  threadId?: string;
}

export interface FailureSummaryData {
  error: string;
  threadId?: string;
}

export interface DeliveryOpts {
  client: any;
  channelId: string;
  threadTs: string;
  gatewayBaseUrl?: string;
}

// ---------------------------------------------------------------------------
// Rate limiter — per-channel token bucket
// ---------------------------------------------------------------------------

interface BucketState {
  tokens: number;
  lastRefill: number;
}

const channelBuckets = new Map<string, BucketState>();
const BUCKET_BURST = 5;
const BUCKET_REFILL_RATE = 1; // tokens per second

function acquireToken(channelId: string): boolean {
  const now = Date.now();
  let bucket = channelBuckets.get(channelId);
  if (!bucket) {
    bucket = { tokens: BUCKET_BURST, lastRefill: now };
    channelBuckets.set(channelId, bucket);
  }

  const elapsed = (now - bucket.lastRefill) / 1000;
  bucket.tokens = Math.min(BUCKET_BURST, bucket.tokens + elapsed * BUCKET_REFILL_RATE);
  bucket.lastRefill = now;

  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return true;
  }
  return false;
}

/** Reset rate limiter state (test-only). */
export function _resetBuckets(): void {
  channelBuckets.clear();
}

// ---------------------------------------------------------------------------
// Truncation helpers
// ---------------------------------------------------------------------------

const SLACK_BLOCK_TEXT_LIMIT = 3000;
const MAX_FILES_SHOWN = 10;

function truncateText(text: string, limit: number, suffix = ""): string {
  if (text.length <= limit) return text;
  const room = limit - suffix.length;
  return text.slice(0, Math.max(0, room)) + suffix;
}

function gatewayThreadLink(baseUrl: string | undefined, threadId: string | undefined): string | null {
  if (!baseUrl || !threadId) return null;
  return `${baseUrl.replace(/\/$/, "")}/#/threads/${threadId}`;
}

function gatewayChangesLink(baseUrl: string | undefined, threadId: string | undefined): string | null {
  if (!baseUrl || !threadId) return null;
  return `${baseUrl.replace(/\/$/, "")}/#/threads/${threadId}?tab=changes`;
}

// ---------------------------------------------------------------------------
// Block Kit builders
// ---------------------------------------------------------------------------

function mrkdwnSection(text: string): any {
  return { type: "section", text: { type: "mrkdwn", text: truncateText(text, SLACK_BLOCK_TEXT_LIMIT) } };
}

function divider(): any {
  return { type: "divider" };
}

function contextBlock(text: string): any {
  return {
    type: "context",
    elements: [{ type: "mrkdwn", text: truncateText(text, SLACK_BLOCK_TEXT_LIMIT) }],
  };
}

function buildApprovalBlocks(data: ApprovalRequestData): any[] {
  const effortLabel = data.effort ?? "unknown";
  const fileList = data.filesAffected?.length
    ? data.filesAffected.slice(0, MAX_FILES_SHOWN).map((f) => `\`${toRelativePath(f)}\``).join(", ") +
      (data.filesAffected.length > MAX_FILES_SHOWN ? ` +${data.filesAffected.length - MAX_FILES_SHOWN} more` : "")
    : "none specified";

  const header =
    `:sparkles: *Approval needed: ${data.title}*\n` +
    (data.category ? `Category: \`${data.category}\` | ` : "") +
    `Effort: \`${effortLabel}\`\n` +
    `Files: ${fileList}` +
    (data.description ? `\n\n${data.description}` : "");

  return [
    mrkdwnSection(header),
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Approve" },
          style: "primary",
          action_id: `nyxhive:proposal_approve:${data.proposalId}`,
          value: data.proposalId,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Reject" },
          style: "danger",
          action_id: `nyxhive:proposal_reject:${data.proposalId}`,
          value: data.proposalId,
        },
      ],
    },
    contextBlock("_If buttons don't work, reply with `approve` or `reject`._"),
  ];
}

function buildInputBlocks(data: InputRequestData): any[] {
  const blocks: any[] = [];
  const headerText = `:question: *${data.question}*`;
  blocks.push(mrkdwnSection(headerText));

  if (data.options.length) {
    blocks.push({
      type: "actions",
      elements: data.options.map((option) => ({
        type: "button",
        text: { type: "plain_text", text: (option.description || option.key).slice(0, 75) },
        action_id: `nyxhive:input_choice:${data.messageId}:${option.key}`,
        value: option.key,
      })),
    });
  }

  if (!data.options.length) {
    blocks.push(contextBlock("_Reply in this thread to respond._"));
  }

  return blocks;
}

function buildChangeSummaryBlocks(data: ChangeSummaryData, gatewayUrl: string | undefined): any[] {
  const blocks: any[] = [];
  const totalAdded = data.files.reduce((s, f) => s + f.added, 0);
  const totalRemoved = data.files.reduce((s, f) => s + f.removed, 0);
  const shown = data.files.slice(0, MAX_FILES_SHOWN);
  const overflow = data.files.length - shown.length;
  const hasLineCounts = totalAdded > 0 || totalRemoved > 0;

  let text = `:page_facing_up: *${data.files.length} file${data.files.length !== 1 ? "s" : ""} changed*`;
  if (hasLineCounts) text += ` (+${totalAdded} -${totalRemoved})`;
  text += "\n";
  text += shown.map((f) => {
    const displayPath = `\`${toRelativePath(f.path)}\``;
    if (f.added === 0 && f.removed === 0) {
      return f.operation ? `${displayPath} (${f.operation})` : displayPath;
    }
    return `${displayPath} +${f.added} -${f.removed}`;
  }).join("\n");
  if (overflow > 0) text += `\n_+${overflow} more_`;
  if (data.summary) text += `\n\n${data.summary}`;

  const verified = data.verified != null
    ? (data.verified ? "\n:white_check_mark: Verified" : "\n:warning: Unverified")
    : "";
  text += verified;

  const link = gatewayChangesLink(gatewayUrl, data.threadId);
  if (link) text += `\n<${link}|View full diff in gateway>`;

  blocks.push(mrkdwnSection(text));
  return blocks;
}

function buildCompletionBlocks(data: CompletionSummaryData, gatewayUrl: string | undefined): any[] {
  const blocks: any[] = [];
  let text = `:white_check_mark: *Done*`;
  if (data.agent) text += ` (${data.agent})`;
  text += `\n${data.text}`;

  const meta: string[] = [];
  if (data.durationMs != null) meta.push(`${(data.durationMs / 1000).toFixed(1)}s`);

  blocks.push(mrkdwnSection(text));

  const metaParts: string[] = [];
  if (meta.length) metaParts.push(meta.join(" | "));
  const link = gatewayThreadLink(gatewayUrl, data.threadId);
  if (link) metaParts.push(`<${link}|Open in gateway>`);
  if (metaParts.length) blocks.push(contextBlock(metaParts.join(" | ")));

  return blocks;
}

function buildFailureBlocks(data: FailureSummaryData, gatewayUrl: string | undefined): any[] {
  let text = `:x: *Failed*\n${data.error}`;
  const link = gatewayThreadLink(gatewayUrl, data.threadId);
  if (link) text += `\n<${link}|View details in gateway>`;
  return [mrkdwnSection(text)];
}

// ---------------------------------------------------------------------------
// SlackDeliveryManager
// ---------------------------------------------------------------------------

export class SlackDeliveryManager {
  private client: any;
  private channelId: string;
  private threadTs: string;
  private gatewayBaseUrl?: string;

  // Mutable state
  private progressTs: string | null = null;
  private currentPhase: SlackPhase | null = null;
  private lastUpdateMs = 0;
  private phaseDetail: string | null = null;
  private lastRenderedText: string | null = null;

  private static readonly MIN_UPDATE_INTERVAL_MS = 2000;

  constructor(opts: DeliveryOpts) {
    this.client = opts.client;
    this.channelId = opts.channelId;
    this.threadTs = opts.threadTs;
    this.gatewayBaseUrl = opts.gatewayBaseUrl;
  }

  /** Post or edit the progress message. Debounced at 2s. */
  async updatePhase(phase: SlackPhase, detail?: string): Promise<void> {
    const now = Date.now();
    const samePhase = phase === this.currentPhase && detail === this.phaseDetail;

    this.currentPhase = phase;
    this.phaseDetail = detail ?? null;

    const text = detail
      ? `${PHASE_LABELS[phase]}\n${truncateText(detail, 200)}`
      : PHASE_LABELS[phase];

    if (this.progressTs && text === this.lastRenderedText) {
      return;
    }

    // Debounce: skip if same phase/detail and less than 2s since last update
    if (samePhase && now - this.lastUpdateMs < SlackDeliveryManager.MIN_UPDATE_INTERVAL_MS) {
      return;
    }

    if (!acquireToken(this.channelId)) {
      // Rate limited — skip this update silently
      return;
    }

    try {
      if (this.progressTs) {
        // Edit existing progress message
        await this.safeUpdate(text);
      } else {
        // Post new progress message
        const result = await this.safePost(text);
        if (result?.ts) this.progressTs = result.ts;
      }
      this.lastRenderedText = text;
      this.lastUpdateMs = Date.now();
    } catch (err) {
      logger.debug(`[slack:delivery] Phase update failed: ${err}`);
    }
  }

  /** Post a Block Kit approval card as a new message in the thread. */
  async postApprovalRequest(data: ApprovalRequestData): Promise<void> {
    const blocks = buildApprovalBlocks(data);
    await this.safePostBlocks(`:sparkles: Approval needed: ${data.title}`, blocks);
  }

  /** Post a structured input request card. */
  async postInputRequest(data: InputRequestData): Promise<void> {
    const blocks = buildInputBlocks(data);
    await this.safePostBlocks(`:question: ${data.question}`, blocks);
  }

  /** Post a compact change summary. */
  async postChangeSummary(data: ChangeSummaryData): Promise<void> {
    const blocks = buildChangeSummaryBlocks(data, this.gatewayBaseUrl);
    const count = data.files.length;
    await this.safePostBlocks(`:page_facing_up: ${count} file${count !== 1 ? "s" : ""} changed`, blocks);
  }

  /** Post a completion summary and clean up the progress message. */
  async postCompletionSummary(data: CompletionSummaryData): Promise<void> {
    const blocks = buildCompletionBlocks(data, this.gatewayBaseUrl);
    await this.safePostBlocks(`:white_check_mark: Done`, blocks);
    await this.deleteProgressMessage();
  }

  /** Post a failure summary and clean up the progress message. */
  async postFailureSummary(data: FailureSummaryData): Promise<void> {
    const blocks = buildFailureBlocks(data, this.gatewayBaseUrl);
    await this.safePostBlocks(`:x: Failed`, blocks);
    await this.deleteProgressMessage();
  }

  /** Clean up: delete progress message if still present. */
  async finalize(): Promise<void> {
    await this.deleteProgressMessage();
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async safePost(text: string): Promise<any> {
    try {
      return await withRetry(
        () => this.client.chat.postMessage({
          channel: this.channelId,
          text,
          blocks: [mrkdwnSection(text)],
          thread_ts: this.threadTs,
        }),
        { baseDelayMs: 500 },
      );
    } catch (err) {
      logger.warn(`[slack:delivery] Post failed: ${err}`);
      return null;
    }
  }

  private async safeUpdate(text: string): Promise<void> {
    if (!this.progressTs) return;
    try {
      await withRetry(
        () => this.client.chat.update({
          channel: this.channelId,
          ts: this.progressTs!,
          text,
          blocks: [mrkdwnSection(text)],
        }),
        { baseDelayMs: 500 },
      );
    } catch (err) {
      logger.warn(`[slack:delivery] Update failed: ${err}`);
      // If update fails (e.g. message deleted), clear the ts so next update posts fresh
      this.progressTs = null;
      this.lastRenderedText = null;
    }
  }

  private async safePostBlocks(fallbackText: string, blocks: any[]): Promise<void> {
    try {
      await withRetry(
        () => this.client.chat.postMessage({
          channel: this.channelId,
          text: fallbackText,
          blocks,
          thread_ts: this.threadTs,
        }),
        { baseDelayMs: 500 },
      );
    } catch (err) {
      // Block Kit failed — try plain text fallback
      logger.warn(`[slack:delivery] Block post failed, trying text fallback: ${err}`);
      try {
        await this.client.chat.postMessage({
          channel: this.channelId,
          text: fallbackText,
          thread_ts: this.threadTs,
        });
      } catch (err2) {
        logger.warn(`[slack:delivery] Text fallback also failed: ${err2}`);
      }
    }
  }

  private async deleteProgressMessage(): Promise<void> {
    if (!this.progressTs) return;
    try {
      await this.client.chat.delete({ channel: this.channelId, ts: this.progressTs });
    } catch {
      // Ignore — message may already be deleted
    }
    this.progressTs = null;
    this.lastRenderedText = null;
  }
}

// ---------------------------------------------------------------------------
// Phase inference from CLIProgress
// ---------------------------------------------------------------------------

export function inferPhase(activity: string | undefined, phase: "working" | "responding"): SlackPhase {
  if (phase === "responding") return "completing";
  if (!activity) return "planning";

  const lower = activity.toLowerCase();

  if (lower.includes("read") || lower.includes("search") || lower.includes("glob") || lower.includes("grep") || lower.includes("plan")) {
    return "planning";
  }
  if (lower.includes("bash") || lower.includes("command") || lower.includes("test") || lower.includes("running") || lower.includes("terminal")) {
    return "running_commands";
  }
  if (lower.includes("edit") || lower.includes("write") || lower.includes("creat") || lower.includes("delet")) {
    return "editing_files";
  }
  if (lower.includes("review") || lower.includes("lint") || lower.includes("check")) {
    return "reviewing";
  }
  return "planning";
}

/** Extract a short human-readable detail from a CLIProgress activity string. */
export function activityDetail(activity: string | undefined): string | undefined {
  if (!activity) return undefined;
  return truncateText(humanStatusFromActivity(stripAbsolutePaths(activity)), 100);
}

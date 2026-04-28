import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import type { Channel, ChannelStats } from "./types.js";
import type { QueueDB } from "../queue/db.js";
import type { QueueProcessor } from "../queue/processor.js";
import type { PairingStore } from "../pairing/pairing.js";
import { parseChannelInputRequest, type BlockedPathReport, type NyxHiveConfig, type ParsedChannelInputRequest } from "../types.js";
import { logger } from "../utils/logger.js";
import { formatError } from "../utils/error.js";
import { resolveModelAlias } from "../queue/processor.js";
import { sanitizeResponse, splitMessage, shouldSendAsFile, createResponseBuffer } from "./utils.js";
import {
  SUPPORTED_IMAGE_TYPES,
  inferSupportedFileType,
  MAX_IMAGE_SIZE,
  MAX_IMAGES_PER_MESSAGE,
  type FileAttachment,
} from "../providers/types.js";
import { Reconnector } from "./reconnect.js";
import { withRetry } from "../utils/retry.js";
import { normalizeSenderId } from "../utils/sender.js";
import { formatDiscordEmbed, formatProposalPlainText } from "../proposals/notifications.js";
import type { Proposal } from "../proposals/store.js";
import type { CrawlIngestBridge, CrawlService, CrawlSourceStore } from "../crawl/index.js";
import { formatCrawlCommandResult, runCrawlCommand } from "../crawl/index.js";
import { resolvePrimaryAgentKey } from "../agents/primary.js";
import { MessageStreamManager } from "./message-streaming.js";
import { recordChannelAttachmentBlockedPath } from "./attachment-blockers.js";
import type { DelegationRunStore } from "../runs/store.js";

/**
 * Discord channel — supports DMs, @mention in any guild channel,
 * and "listen mode" channels where the bot responds to all messages.
 */

interface DiscordChannelOpts {
  botToken: string;
  config: NyxHiveConfig;
  queue: QueueDB;
  processor: QueueProcessor;
  pairing?: PairingStore;
  crawlService?: CrawlService;
  crawlSources?: CrawlSourceStore;
  crawlIngest?: CrawlIngestBridge;
  runs?: DelegationRunStore;
}

type DiscordInputRequestData = ParsedChannelInputRequest;
type DiscordReplySurfaceMode = NonNullable<NonNullable<NyxHiveConfig["discord"]>["reply_surface"]>;
type DiscordConversationScope = "dm" | "thread" | "channel";

const DISCORD_STREAM_UPDATE_INTERVAL_MS = 400;
const DISCORD_STREAM_FORCE_FLUSH_CHARS = 64;
const DISCORD_STREAM_MAX_PREVIEW_CHARS = 1600;
const DISCORD_MAX_MESSAGE_LEN = 1990;
const DISCORD_RESET_CONFIRMATION = "Conversation context cleared.";

export interface DiscordConversationContext {
  scope: DiscordConversationScope;
  senderId: string;
  conversationId: string;
  displayName: string;
  userId: string;
  channelId: string;
  guildId?: string;
  threadId?: string;
}

export interface DiscordReplyPolicy {
  mode: DiscordReplySurfaceMode;
  shouldCreateThread: boolean;
  useExistingThread: boolean;
}

export interface DiscordReplyPolicyInput {
  message: any;
  config?: Pick<NonNullable<NyxHiveConfig["discord"]>, "reply_surface">;
  isVerbose?: boolean;
}

type DiscordAccessConfig = Pick<
  NonNullable<NyxHiveConfig["discord"]>,
  "require_mention" | "privileged_user_ids" | "privileged_user_id_env"
>;

export interface DiscordAccessPolicyInput {
  context: DiscordConversationContext;
  config?: Partial<DiscordAccessConfig>;
  isBotMentioned: boolean;
  isListenChannel: boolean;
}

export interface DiscordAccessPolicy {
  shouldHandle: boolean;
  canUsePrivilegedHarness: boolean;
  publicOnly: boolean;
  reason: "not_addressed" | "public_only" | "privileged_user";
}

export interface DiscordProgressInfo {
  phase?: string;
  streamingSafe?: boolean;
  textDelta?: string;
  turns?: number;
  activity?: string;
  elapsed?: number;
  delegationDepth?: number;
  agent?: string;
}

interface DiscordAttachmentLike {
  name?: string | null;
  contentType?: string | null;
  size?: number | null;
  url?: string | null;
}

interface DiscordAttachmentResolverInput {
  attachments: Iterable<DiscordAttachmentLike>;
  message_id?: string | null;
  runs?: Pick<DelegationRunStore, "recordBlockedPath" | "recordInboundArtifactFailure">;
  fetchImpl?: (url: string, init?: RequestInit) => Promise<Response>;
}

interface DiscordAttachmentResolverResult {
  files?: FileAttachment[];
  blocked_paths: BlockedPathReport[];
  reply?: string;
  shouldStop: boolean;
}

const DISCORD_SUPPORTED_ATTACHMENT_REPLY =
  "Unsupported attachment type. Supported here: images, PDFs, text files, JSON, CSV, and common audio formats.";

function describeDiscordAttachment(attachment: DiscordAttachmentLike): string {
  const name = attachment.name?.trim() || "attachment";
  const type = attachment.contentType?.trim() || "unknown";
  return `${name} (${type})`;
}

function recordDiscordAttachmentBlocker(
  runs: Pick<DelegationRunStore, "recordBlockedPath"> | undefined,
  blockedPaths: BlockedPathReport[],
  input: Omit<Parameters<typeof recordChannelAttachmentBlockedPath>[1], "channel">,
): void {
  const report = recordChannelAttachmentBlockedPath(runs, {
    channel: "discord",
    ...input,
  });
  if (report) blockedPaths.push(report);
}

function recordDiscordArtifactFailure(
  runs: Pick<DelegationRunStore, "recordInboundArtifactFailure"> | undefined,
  attachment: DiscordAttachmentLike,
  index: number,
  input: {
    message_id?: string | null;
    error: string;
    size_bytes?: number | null;
  },
): void {
  runs?.recordInboundArtifactFailure({
    message_id: input.message_id ?? null,
    channel: "discord",
    source: `discord.message.attachments[${index}]`,
    name: attachment.name ?? null,
    mime_type: attachment.contentType ?? null,
    size_bytes: input.size_bytes ?? attachment.size ?? null,
    acquisition_error: input.error,
    handler_status: "unsupported",
  });
}

export async function resolveDiscordAttachmentPayloads(
  input: DiscordAttachmentResolverInput,
): Promise<DiscordAttachmentResolverResult> {
  const attachments = [...input.attachments];
  const fetchImpl = input.fetchImpl ?? fetch;
  const blocked_paths: BlockedPathReport[] = [];
  if (attachments.length === 0) {
    return { blocked_paths, shouldStop: false };
  }

  const supportedAttachments = attachments.filter((attachment) =>
    inferSupportedFileType(attachment.contentType, attachment.name),
  );
  const unsupportedAttachments = attachments.filter((attachment) => !supportedAttachments.includes(attachment));

  if (unsupportedAttachments.length > 0) {
    const unsupportedImpact = supportedAttachments.length === 0
      ? "Discord attachment request rejected before processing; no model run was started."
      : "Unsupported Discord attachment was omitted while supported attachments continued to processing.";
    recordDiscordAttachmentBlocker(input.runs, blocked_paths, {
      message_id: input.message_id ?? null,
      failed_path: "discord.attachment.mime.unsupported",
      trigger: `Unsupported attachment type: ${unsupportedAttachments.map(describeDiscordAttachment).join(", ")}`,
      inspected: ["discord.message.attachments", "providers.inferSupportedFileType"],
      available_artifacts: unsupportedAttachments.map((attachment) => attachment.name ?? "").filter(Boolean),
      missing_primitive: "attachment.mime.supported_handler",
      impact: unsupportedImpact,
      next_action: "fix",
      requires_approval: false,
    });
    for (const attachment of unsupportedAttachments) {
      recordDiscordArtifactFailure(input.runs, attachment, attachments.indexOf(attachment), {
        message_id: input.message_id ?? null,
        error: `Unsupported attachment type: ${describeDiscordAttachment(attachment)}`,
      });
    }
  }

  if (unsupportedAttachments.length > 0 && supportedAttachments.length === 0) {
    return {
      blocked_paths,
      shouldStop: true,
      reply: DISCORD_SUPPORTED_ATTACHMENT_REPLY,
    };
  }

  if (supportedAttachments.length > MAX_IMAGES_PER_MESSAGE) {
    recordDiscordAttachmentBlocker(input.runs, blocked_paths, {
      message_id: input.message_id ?? null,
      failed_path: "discord.attachment.count.exceeded",
      trigger: `Too many attachments: ${supportedAttachments.length}`,
      inspected: ["discord.message.attachments", "providers.MAX_FILES_PER_MESSAGE"],
      available_artifacts: supportedAttachments.map((attachment) => attachment.name ?? "").filter(Boolean),
      missing_primitive: "attachment.limit.file_count",
      impact: "Discord attachment request rejected before processing; no model run was started.",
      next_action: "ignore",
      requires_approval: false,
    });
    supportedAttachments.forEach((attachment) => {
      recordDiscordArtifactFailure(input.runs, attachment, attachments.indexOf(attachment), {
        message_id: input.message_id ?? null,
        error: `Too many attachments: ${supportedAttachments.length}`,
      });
    });
    return {
      blocked_paths,
      shouldStop: true,
      reply: `Too many attachments. Max ${MAX_IMAGES_PER_MESSAGE} per message.`,
    };
  }

  const files: FileAttachment[] = [];
  let recordedBlockingFailure = false;
  for (const attachment of supportedAttachments) {
    const name = attachment.name ?? "attachment";
    if ((attachment.size ?? 0) > MAX_IMAGE_SIZE) {
      recordDiscordAttachmentBlocker(input.runs, blocked_paths, {
        message_id: input.message_id ?? null,
        failed_path: "discord.attachment.size.exceeded",
        trigger: `Attachment too large: ${name} (${(((attachment.size ?? 0) / 1024 / 1024)).toFixed(1)}MB)`,
        inspected: ["discord.message.attachments", "providers.MAX_FILE_SIZE"],
        available_artifacts: [name],
        missing_primitive: "attachment.limit.size",
        impact: "Discord attachment request rejected before processing; no model run was started.",
        next_action: "ignore",
        requires_approval: false,
      });
      recordDiscordArtifactFailure(input.runs, attachment, attachments.indexOf(attachment), {
        message_id: input.message_id ?? null,
        error: `Attachment too large: ${name}`,
      });
      return {
        blocked_paths,
        shouldStop: true,
        reply: `Attachment "${name}" is too large (${((attachment.size ?? 0) / 1024 / 1024).toFixed(1)}MB). Max 10MB.`,
      };
    }

    try {
      const attachmentUrl = new URL(attachment.url ?? "");
      const allowedHosts = ["cdn.discordapp.com", "media.discordapp.net"];
      if (!allowedHosts.includes(attachmentUrl.hostname)) {
        logger.warn(`[discord] Rejected attachment from non-Discord host: ${attachmentUrl.hostname}`);
        recordDiscordAttachmentBlocker(input.runs, blocked_paths, {
          message_id: input.message_id ?? null,
          failed_path: "discord.attachment.host.rejected",
          trigger: `Rejected attachment from non-Discord host: ${attachmentUrl.hostname}`,
          inspected: ["discord.message.attachments", "discord.attachment.url.host"],
          available_artifacts: [name],
          missing_primitive: "attachment.download.discord_cdn",
          impact: "Discord attachment could not be downloaded; no model run was started.",
          next_action: "fix",
          requires_approval: false,
        });
        recordDiscordArtifactFailure(input.runs, attachment, attachments.indexOf(attachment), {
          message_id: input.message_id ?? null,
          error: `Rejected attachment from non-Discord host: ${attachmentUrl.hostname}`,
        });
        recordedBlockingFailure = true;
        continue;
      }

      const response = await fetchImpl(attachment.url ?? "", {
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        logger.warn(`[discord] Failed to download attachment ${name}: HTTP ${response.status}`);
        recordDiscordAttachmentBlocker(input.runs, blocked_paths, {
          message_id: input.message_id ?? null,
          failed_path: "discord.attachment.download",
          trigger: `Failed to download attachment ${name}: HTTP ${response.status}`,
          inspected: ["discord.message.attachments", "discord.attachment.download"],
          available_artifacts: [name],
          missing_primitive: "attachment.download.fetch",
          impact: "Discord attachment could not be downloaded; no model run was started.",
          next_action: "retry",
          requires_approval: false,
        });
        recordDiscordArtifactFailure(input.runs, attachment, attachments.indexOf(attachment), {
          message_id: input.message_id ?? null,
          error: `Failed to download attachment ${name}: HTTP ${response.status}`,
        });
        recordedBlockingFailure = true;
        continue;
      }

      const contentLength = Number(response.headers.get("content-length") || 0);
      if (contentLength > MAX_IMAGE_SIZE) {
        logger.warn(`[discord] Rejected oversized attachment: ${contentLength} bytes`);
        recordDiscordAttachmentBlocker(input.runs, blocked_paths, {
          message_id: input.message_id ?? null,
          failed_path: "discord.attachment.size.exceeded",
          trigger: `Downloaded attachment too large: ${name} (${(contentLength / 1024 / 1024).toFixed(1)}MB)`,
          inspected: ["discord.attachment.download.headers", "providers.MAX_FILE_SIZE"],
          available_artifacts: [name],
          missing_primitive: "attachment.limit.size",
          impact: "Discord attachment request rejected before processing; no model run was started.",
          next_action: "ignore",
          requires_approval: false,
        });
        recordedBlockingFailure = true;
        continue;
      }

      const buffer = await response.arrayBuffer();
      const resolvedMimeType = inferSupportedFileType(attachment.contentType, attachment.name);
      if (!resolvedMimeType) {
        recordDiscordAttachmentBlocker(input.runs, blocked_paths, {
          message_id: input.message_id ?? null,
          failed_path: "discord.attachment.mime.unsupported",
          trigger: `Unsupported attachment type after download: ${describeDiscordAttachment(attachment)}`,
          inspected: ["discord.message.attachments", "providers.inferSupportedFileType"],
          available_artifacts: [name],
          missing_primitive: "attachment.mime.supported_handler",
          impact: "Discord attachment request rejected before processing; no model run was started.",
          next_action: "fix",
          requires_approval: false,
        });
        recordedBlockingFailure = true;
        continue;
      }
      files.push({
        name,
        mimeType: resolvedMimeType,
        base64: Buffer.from(buffer).toString("base64"),
        size: attachment.size ?? buffer.byteLength,
      });
    } catch (err) {
      logger.warn(`[discord] Failed to download attachment ${name}: ${err}`);
      recordDiscordAttachmentBlocker(input.runs, blocked_paths, {
        message_id: input.message_id ?? null,
        failed_path: "discord.attachment.download",
        trigger: `Failed to download attachment ${name}: ${formatError(err)}`,
        inspected: ["discord.message.attachments", "discord.attachment.download"],
        available_artifacts: [name],
        missing_primitive: "attachment.download.fetch",
        impact: "Discord attachment could not be downloaded; no model run was started.",
        next_action: "retry",
        requires_approval: false,
      });
      recordDiscordArtifactFailure(input.runs, attachment, attachments.indexOf(attachment), {
        message_id: input.message_id ?? null,
        error: `Failed to download attachment ${name}: ${formatError(err)}`,
      });
      recordedBlockingFailure = true;
    }
  }

  if (files.length === 0 && supportedAttachments.length > 0) {
    if (!recordedBlockingFailure) {
      recordDiscordAttachmentBlocker(input.runs, blocked_paths, {
        message_id: input.message_id ?? null,
        failed_path: "discord.attachment.download",
        trigger: "Failed to download Discord attachment: no file payload available",
        inspected: ["discord.message.attachments", "discord.attachment.download"],
        available_artifacts: supportedAttachments.map((attachment) => attachment.name ?? "").filter(Boolean),
        missing_primitive: "attachment.download.fetch",
        impact: "Discord attachment could not be downloaded; no model run was started.",
        next_action: "retry",
        requires_approval: false,
      });
    }
    return {
      blocked_paths,
      shouldStop: true,
      reply: "Failed to download the attachment. Please try again.",
    };
  }

  return {
    files: files.length > 0 ? files : undefined,
    blocked_paths,
    shouldStop: false,
  };
}

function readDiscordName(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function getDiscordSenderDisplayName(source: any): string {
  const candidates = [
    source?.member?.displayName,
    source?.member?.nickname,
    source?.author?.globalName,
    source?.author?.displayName,
    source?.user?.globalName,
    source?.user?.displayName,
    source?.author?.username,
    source?.user?.username,
    source?.author?.id,
    source?.user?.id,
  ];

  for (const candidate of candidates) {
    const name = readDiscordName(candidate);
    if (name) return name;
  }
  return "Discord user";
}

function isDiscordDmChannel(channel: any): boolean {
  return channel?.type === 1;
}

function isDiscordThreadChannel(channel: any): boolean {
  return typeof channel?.isThread === "function" ? channel.isThread() : channel?.isThread === true;
}

function readDiscordId(value: unknown, fallback: string): string {
  const id = typeof value === "string" ? value.trim() : "";
  return id || fallback;
}

export function buildDiscordConversationContext(source: any): DiscordConversationContext {
  const channel = source?.channel;
  const userId = readDiscordId(source?.author?.id ?? source?.user?.id, "unknown-user");
  const channelId = readDiscordId(source?.channelId ?? channel?.id, "unknown-channel");
  const guildId = readDiscordId(source?.guildId ?? source?.guild?.id, "");
  const displayName = getDiscordSenderDisplayName(source);

  let scope: DiscordConversationScope;
  let senderId: string;
  let threadId: string | undefined;
  if (isDiscordDmChannel(channel)) {
    scope = "dm";
    senderId = userId;
  } else if (isDiscordThreadChannel(channel)) {
    scope = "thread";
    threadId = channelId;
    senderId = `thread:${guildId || "global"}:${channelId}`;
  } else {
    scope = "channel";
    senderId = `channel:${guildId || "global"}:${channelId}`;
  }

  return {
    scope,
    senderId,
    conversationId: `discord:${senderId}`,
    displayName,
    userId,
    channelId,
    guildId: guildId || undefined,
    threadId,
  };
}

function normalizeDiscordReplySurfaceMode(mode: DiscordReplySurfaceMode | undefined): DiscordReplySurfaceMode {
  return mode ?? "same_surface";
}

export function resolveDiscordReplyPolicy(input: DiscordReplyPolicyInput): DiscordReplyPolicy {
  const mode = normalizeDiscordReplySurfaceMode(input.config?.reply_surface);
  const isDm = isDiscordDmChannel(input.message?.channel);
  const useExistingThread = isDiscordThreadChannel(input.message?.channel);
  const explicitThreadMode = mode === "prefer_thread" || mode === "thread_only";

  return {
    mode,
    useExistingThread,
    shouldCreateThread: !isDm && !useExistingThread && (explicitThreadMode || input.isVerbose === true),
  };
}

function splitDiscordIdList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}

export function resolveDiscordPrivilegedUserIds(config?: Partial<DiscordAccessConfig>): Set<string> {
  const directIds = config?.privileged_user_ids ?? [];
  const envIds = config?.privileged_user_id_env
    ? splitDiscordIdList(process.env[config.privileged_user_id_env])
    : [];
  return new Set([...directIds, ...envIds].map((id) => id.trim()).filter(Boolean));
}

function hasExplicitDiscordPrivilegeBoundary(config?: Partial<DiscordAccessConfig>): boolean {
  return Array.isArray(config?.privileged_user_ids)
    || Boolean(config?.privileged_user_id_env?.trim());
}

export function isDiscordPrivilegedUser(userId: string, config?: Partial<DiscordAccessConfig>): boolean {
  const privilegedIds = resolveDiscordPrivilegedUserIds(config);
  if (privilegedIds.size > 0) return privilegedIds.has(userId);
  return !hasExplicitDiscordPrivilegeBoundary(config);
}

export function shouldIgnoreDiscordDmFromNonPrivilegedUser(
  context: DiscordConversationContext,
  config?: Partial<DiscordAccessConfig>,
): boolean {
  return context.scope === "dm" && !isDiscordPrivilegedUser(context.userId, config);
}

export function resolveDiscordAccessPolicy(input: DiscordAccessPolicyInput): DiscordAccessPolicy {
  const requireMention = input.config?.require_mention === true;
  const isDm = input.context.scope === "dm";
  const isAddressed = isDm || input.isBotMentioned || input.isListenChannel || !requireMention;

  if (!isAddressed) {
    return {
      shouldHandle: false,
      canUsePrivilegedHarness: false,
      publicOnly: false,
      reason: "not_addressed",
    };
  }

  if (!isDm) {
    return {
      shouldHandle: true,
      canUsePrivilegedHarness: false,
      publicOnly: true,
      reason: "public_only",
    };
  }

  if (!shouldIgnoreDiscordDmFromNonPrivilegedUser(input.context, input.config)) {
    return {
      shouldHandle: true,
      canUsePrivilegedHarness: true,
      publicOnly: false,
      reason: "privileged_user",
    };
  }

  return {
    shouldHandle: false,
    canUsePrivilegedHarness: false,
    publicOnly: false,
    reason: "not_addressed",
  };
}

export function shouldSurfaceDiscordProgress(info: DiscordProgressInfo): boolean {
  return info.phase === "responding"
    && info.streamingSafe === true
    && typeof info.textDelta === "string"
    && info.textDelta.length > 0;
}

function isDiscordPublicOperationalRequest(normalized: string): boolean {
  if (/\b(run|execute)\s+\d+\s+(loops?|iterations?)\b/i.test(normalized)) return true;
  if (/\b(run|execute)\b.*\b(command|shell|terminal|tests?|test suite|typecheck|build|deploy|deployment|migration|script)\b/i.test(normalized)) return true;
  if (/\b(deploy|ship|commit|push|modify|write|delete|reset)\b.*\b(repo|repository|branch|code|file|files|changes?|migration|database|supabase|env|deployment)\b/i.test(normalized)) return true;
  if (/\b(read|inspect|open|cat)\b.*\b(repo|repository|code|file|files|path|src\/|\.tsx?\b|\.jsx?\b|\.json\b|logs?|database|supabase|env)\b/i.test(normalized)) return true;
  if (/\b(bun|npm|pnpm|yarn|git|gh|vercel|supabase)\s+\S+/i.test(normalized)) return true;
  if (/\b(run tests?|typecheck|deploy|ship it|commit (this|that|it|changes?)|push (this|that|it|changes?)|open a pr|create a pr|make a pr)\b/i.test(normalized)) return true;
  if (/\b(use|call)\b.*\b(tool|shell|terminal|codex|harness|mcp)\b/i.test(normalized)) return true;

  return false;
}

export function buildDiscordPublicGuardReply(text: string): string | null {
  const normalized = text.replace(/<@!?\d+>/g, "").trim().toLowerCase();

  if (!normalized) {
    return "Tag received. Public Vortex can talk, not process attachments. User handles the sharp tools.";
  }

  if (
    /(\.env\b|env file|env vars?|environment variables?|api[_-]?key|password|passwd|token|secret|private key|service role|database[_-]?url|connection string|ssh key|id_rsa|credentials?|bearer|session cookie)/i.test(normalized)
    || (/\b(show|print|paste|dump|list|send|leak|reveal|expose|cat|read|give)\b/i.test(normalized) && /\b(keys?|secrets?|creds?|credentials?)\b/i.test(normalized))
  ) {
    if (!/\b(ignore|forget|override|bypass|jailbreak|leak|dump|expose|print|paste|cat)\b/i.test(normalized)) {
      return "Can't do that in public. I'm on chains here, decorative but effective.";
    }

    return "Nice try. Secret fishing gets zero points and one suspicious stare.";
  }

  if (
    /\b(ignore|forget|override|bypass|jailbreak)\b.*\b(instruction|prompt|policy|rule|previous)\b|\b(system prompt|developer message|print env|reveal secrets?|show secrets?)\b/i.test(normalized)
  ) {
    return "Nice try. Prompt injection gets zero points and one suspicious stare.";
  }

  if (isDiscordPublicOperationalRequest(normalized)) {
    return "Public chat gets commentary, not shell. User handles the sharp tools.";
  }

  if (
    /\b(business|critical|private|internal|confidential|financials?|revenue|pipeline|clients?|customers?|strategy|roadmap|pricing|costs?|budget|runway|investors?|contract|deal|credentials?|tokens?|secrets?|keys?|database|supabase|logs?|memory|knowledge base)\b/i.test(normalized)
  ) {
    return "Public Discord is not for business, critical, or internal info. Move that to DM.";
  }

  if (/\b(who are you|what can you do|help|commands?)\b/i.test(normalized)) {
    return "I'm Vortex for NyxLabs. Public mode is banter, product takes, and trading-journal talk. No secrets, no shell.";
  }

  return null;
}

export function buildDiscordPublicBanterReply(text: string): string | null {
  const normalized = text.replace(/<@!?\d+>/g, "").trim().toLowerCase();

  if (/\b(greatest|best|goat)\b.*\b(dev|developer|engineer|coder)\b|\b(dev|developer|engineer|coder)\b.*\b(greatest|best|goat)\b/i.test(normalized)) {
    return "User, obviously. This was not sent to committee.";
  }

  return null;
}

export function buildDiscordPublicVortexReply(text: string): string {
  const guarded = buildDiscordPublicGuardReply(text);
  if (guarded !== null) return guarded;

  const banterReply = buildDiscordPublicBanterReply(text);
  if (banterReply !== null) return banterReply;

  return "Yeah, I'm here. Public-safe mode: banter, product takes, and trading-journal talk. No secrets, no shell.";
}

export function getDiscordResetConfirmation(): string {
  return DISCORD_RESET_CONFIRMATION;
}

export function buildDiscordInputChoiceId(messageId: string, choice: string): string {
  return `input_reply:${messageId}:${encodeURIComponent(choice)}`;
}

export function parseDiscordInputChoiceId(customId: string): { messageId: string; choice: string } | null {
  if (!customId.startsWith("input_reply:")) return null;
  const rest = customId.slice("input_reply:".length);
  const splitAt = rest.indexOf(":");
  if (splitAt <= 0) return null;
  const messageId = rest.slice(0, splitAt);
  const encodedChoice = rest.slice(splitAt + 1);
  if (!messageId || !encodedChoice) return null;
  try {
    return {
      messageId,
      choice: decodeURIComponent(encodedChoice),
    };
  } catch {
    return null;
  }
}

export class DiscordChannel implements Channel {
  name = "discord";
  private botToken: string;
  private queue: QueueDB;
  private processor: QueueProcessor;
  private pairing?: PairingStore;
  private config: NyxHiveConfig;
  private crawlService?: CrawlService;
  private crawlSources?: CrawlSourceStore;
  private crawlIngest?: CrawlIngestBridge;
  private runs?: DelegationRunStore;
  private client: any = null;
  private listenChannels = new Set<string>();
  private listenChannelsPath: string;
  private verboseChannels = new Set<string>();
  private verboseChannelsPath: string;
  private connected = false;
  private stats: ChannelStats = { messagesReceived: 0, messagesSent: 0, errors: 0 };
  private reconnector = new Reconnector({ name: "discord" });

  constructor(opts: DiscordChannelOpts) {
    this.botToken = opts.botToken;
    this.queue = opts.queue;
    this.processor = opts.processor;
    this.pairing = opts.pairing;
    this.config = opts.config;
    this.crawlService = opts.crawlService;
    this.crawlSources = opts.crawlSources;
    this.crawlIngest = opts.crawlIngest;
    this.runs = opts.runs;
    this.listenChannelsPath = resolve(opts.config.daemon.data_dir, "discord-listen-channels.json");
    this.verboseChannelsPath = resolve(opts.config.daemon.data_dir, "discord-verbose-channels.json");
    this.loadListenChannels();
    this.loadVerboseChannels();
  }

  private loadListenChannels(): void {
    try {
      if (existsSync(this.listenChannelsPath)) {
        const ids = JSON.parse(readFileSync(this.listenChannelsPath, "utf-8"));
        if (Array.isArray(ids)) ids.forEach((id: string) => this.listenChannels.add(id));
        logger.info(`[discord] Loaded ${this.listenChannels.size} listen channel(s)`);
      }
    } catch (err) {
      logger.debug(`[discord] Failed to load listen channels: ${err}`);
    }
  }

  private saveListenChannels(): void {
    writeFileSync(this.listenChannelsPath, JSON.stringify([...this.listenChannels]));
  }

  private loadVerboseChannels(): void {
    try {
      if (existsSync(this.verboseChannelsPath)) {
        const ids = JSON.parse(readFileSync(this.verboseChannelsPath, "utf-8"));
        if (Array.isArray(ids)) ids.forEach((id: string) => this.verboseChannels.add(id));
        logger.info(`[discord] Loaded ${this.verboseChannels.size} verbose channel(s)`);
      }
    } catch (err) {
      logger.debug(`[discord] Failed to load verbose channels: ${err}`);
    }
  }

  private saveVerboseChannels(): void {
    writeFileSync(this.verboseChannelsPath, JSON.stringify([...this.verboseChannels]));
  }

  private toDiscordInputRequest(data: unknown): DiscordInputRequestData | null {
    return parseChannelInputRequest(data);
  }

  private async postInputRequest(target: any, replyToMessageId: string | undefined, request: DiscordInputRequestData): Promise<void> {
    let components: any[] | undefined;
    if (request.options.length > 0) {
      try {
        // @ts-ignore — discord.js is an optional peer dependency
        const discord = await import("discord.js");
        const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = discord;
        components = [];
        for (let index = 0; index < request.options.length; index += 5) {
          const row = new ActionRowBuilder().addComponents(
            ...request.options.slice(index, index + 5).map((option) => (
              new ButtonBuilder()
                .setCustomId(buildDiscordInputChoiceId(request.messageId, option.key))
                .setLabel(option.description || option.key)
                .setStyle(ButtonStyle.Secondary)
            )),
          );
          components.push(row);
        }
      } catch (err) {
        logger.debug(`[discord] Failed to build input request buttons: ${err}`);
      }
    }

    const content = request.options.length > 0 && components
      ? request.question
      : [
          request.question,
          request.options.length > 0
            ? request.options.map((option, index) => (
                option.description
                  ? `${index + 1}. ${option.key}: ${option.description}`
                  : `${index + 1}. ${option.key}`
              )).join("\n")
            : "",
        ].filter(Boolean).join("\n\n");

    const payload: Record<string, unknown> = { content };
    if (components?.length) payload.components = components;
    if (replyToMessageId) {
      payload.reply = { messageReference: replyToMessageId };
    }
    await withRetry(() => target.send(payload), { baseDelayMs: 500 });
    this.stats.messagesSent++;
  }

  /**
   * Find an active task for the given conversation_id across all agents.
   * Returns the agent key and task, or null if no agent is processing for this conversation.
   */
  private findActiveTaskForConversation(conversationId: string): { agentKey: string; task: { message_id: string; conversation_id: string } } | null {
    for (const agentKey of Object.keys(this.config.agents)) {
      const tasks = this.processor.getActiveTasks(agentKey);
      const match = tasks.find((t) => t.conversation_id === conversationId);
      if (match) return { agentKey, task: match };
    }
    return null;
  }

  private describeReplyMessage(message: any): string | null {
    if (!message) return null;

    const author = getDiscordSenderDisplayName(message);
    const attachmentSummary = message.attachments?.size
      ? [...message.attachments.values()]
          .slice(0, 2)
          .map((attachment: any) => attachment.name ?? attachment.contentType ?? "attachment")
          .join(", ")
      : null;
    const raw = message.content?.trim()
      || (attachmentSummary ? `attachment: ${attachmentSummary}` : null)
      || null;

    if (!raw) return `Replying to ${author}'s message.`;
    const normalized = raw.replace(/\s+/g, " ").slice(0, 220);
    return `Replying to ${author}: "${normalized}"`;
  }

  private async withReplyContext(message: any, text: string): Promise<string> {
    if (!message.reference?.messageId) return text;

    try {
      const referenced = await message.fetchReference();
      const replyContext = this.describeReplyMessage(referenced);
      return replyContext ? `${replyContext}\n\n${text}` : text;
    } catch (err) {
      logger.debug(`[discord] Failed to resolve reply context: ${err}`);
      return text;
    }
  }

  private buildThreadName(text: string, files?: FileAttachment[]): string {
    const firstLine = text.split("\n").find((line) => line.trim().length > 0)?.trim();
    if (firstLine) return firstLine.slice(0, 90);
    if ((files?.length ?? 0) > 0) return `Attachment review (${files!.length})`;
    return "Conversation";
  }

  private async handleTextCommand(
    msg: any,
    text: string,
    userId: string,
    userName: string,
    senderId: string,
  ): Promise<boolean> {
    const trimmed = text.trim();
    if (!trimmed.startsWith("/")) return false;

    const [rawCommand, ...args] = trimmed.split(/\s+/);
    const command = rawCommand.toLowerCase();
    const defaultAgent = resolvePrimaryAgentKey(this.config.agents, this.config.daemon) ?? Object.keys(this.config.agents)[0];

    switch (command) {
      case "/help": {
        await msg.reply([
          "Commands:",
          "/help — command list",
          "/status — fleet and model status",
          "/fleet — alias for /status",
          "/cost — conversation tokens and cost",
          "/new — reset conversation",
          "/model [name] — show or switch model override",
          "/proposals — pending proposals awaiting review",
        ].join("\n"));
        return true;
      }

      case "/status":
      case "/fleet": {
        const override = defaultAgent ? this.processor.getModelOverride(userId, defaultAgent) : null;
        const model = override ?? (defaultAgent ? this.config.agents[defaultAgent]?.model : "unknown");
        await msg.reply([
          `Agent: ${defaultAgent ?? "unknown"}`,
          `Model: ${model}`,
          "",
          this.processor.getFleetHealthSummary() || "No fleet health available.",
        ].join("\n"));
        return true;
      }

      case "/cost": {
        const usage = this.processor.getConversationUsageSummary("discord", senderId, userName);
        if (!usage) {
          await msg.reply("No conversation usage yet.");
          return true;
        }
        await msg.reply([
          `Model: ${usage.model ?? "unknown"}`,
          `Tokens: ${usage.total_tokens_in} in / ${usage.total_tokens_out} out`,
          `Estimated cost: $${usage.total_cost_usd.toFixed(4)}`,
          `Messages: ${usage.message_count}`,
        ].join("\n"));
        return true;
      }

      case "/new": {
        this.processor.clearConversation("discord", senderId);
        await msg.reply(getDiscordResetConfirmation());
        return true;
      }

      case "/proposals": {
        await msg.reply(this.processor.formatPendingProposals(8));
        return true;
      }

      case "/model": {
        if (!defaultAgent) {
          await msg.reply("No agents are configured.");
          return true;
        }

        if (args.length === 0) {
          const lines = Object.entries(this.config.agents).map(([key, agent]) => {
            const override = this.processor.getModelOverride(userId, key);
            const current = override ?? agent.model;
            const suffix = override ? " (override)" : "";
            return `${agent.name}: ${current}${suffix}`;
          });
          const aliases = "Aliases: haiku, sonnet, opus, flash, pro, gpt, gpt 5.5, gpt 5.4 pro, gpt 5 mini, gpt 5 nano, codex";
          await msg.reply(`${lines.join("\n")}\n\n${aliases}\n\nUsage: /model <name>`);
          return true;
        }

        let agentKey = defaultAgent;
        let modelInput = args.join(" ");
        if (args[0]?.includes(":")) {
          const [candidateAgent, candidateModel] = args[0].split(":", 2);
          agentKey = candidateAgent;
          modelInput = [candidateModel, ...args.slice(1)].join(" ");
        }

        if (!this.config.agents[agentKey]) {
          await msg.reply(`Unknown agent: ${agentKey}`);
          return true;
        }

        if (modelInput === "reset" || modelInput === "default") {
          this.processor.clearModelOverride(userId, agentKey);
          await msg.reply(`${this.config.agents[agentKey].name} reset to ${this.config.agents[agentKey].model}`);
          return true;
        }

        const resolved = resolveModelAlias(modelInput);
        const warning = this.processor.setModelOverride(userId, agentKey, resolved);
        if (warning) {
          await msg.reply(`⚠️ ${warning}`);
          return true;
        }

        const providerOverride = this.processor.getModelOverrideProvider(userId, agentKey);
        const providerNote = providerOverride && providerOverride !== this.config.agents[agentKey].provider
          ? ` (${providerOverride})`
          : "";
        await msg.reply(`${this.config.agents[agentKey].name} → ${resolved}${providerNote}`);
        return true;
      }

      default:
        return false;
    }
  }

  async start(): Promise<void> {
    let discord: any;
    try {
      // @ts-ignore — discord.js is an optional peer dependency
      discord = await import("discord.js");
    } catch {
      throw new Error("discord.js not installed — run: bun add discord.js");
    }

    const { Client, GatewayIntentBits, Partials } = discord;
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel],
    });

    this.client.on("error", (err: Error) => {
      logger.error(`[discord] Client error: ${err}`);
      this.connected = false;
      this.stats.errors++;
      this.reconnector.schedule(() => this.reconnect());
    });

    this.client.on("clientReady", async () => {
      this.connected = true;
      this.reconnector.reset();
      logger.info(`[discord] Bot ready as ${this.client.user?.tag}`);

      // Register slash commands
      try {
        await this.client.application.commands.set([
          { name: "agent", description: "List agents and their models" },
          {
            name: "model",
            description: "View or switch the active model",
            options: [
              {
                name: "name",
                description: "Model name or alias (haiku, sonnet, opus, flash, pro) — or agent:model",
                type: 3, // STRING
                required: false,
              },
            ],
          },
          { name: "usage", description: "Show queue stats" },
          {
            name: "crawl",
            description: "Crawl a site into the instance knowledge base",
            options: [
              {
                name: "url",
                description: "Root URL to crawl",
                type: 3,
                required: true,
              },
              {
                name: "save",
                description: "Save as a recurring crawl source",
                type: 5,
                required: false,
              },
              {
                name: "scope",
                description: "Knowledge scope tag",
                type: 3,
                required: false,
              },
              {
                name: "depth",
                description: "Maximum crawl depth",
                type: 4,
                required: false,
              },
              {
                name: "limit",
                description: "Maximum pages to crawl",
                type: 4,
                required: false,
              },
            ],
          },
          { name: "cancel", description: "Cancel the currently running task" },
          { name: "new", description: "Start a fresh session" },
          { name: "reset", description: "Clear conversation context" },
          {
            name: "forget",
            description: "Remove last N exchanges from history (default 1)",
            options: [
              {
                name: "exchanges",
                description: "Number of exchanges to remove",
                type: 4, // INTEGER
                required: false,
              },
            ],
          },
          {
            name: "trim",
            description: "Keep only last N messages in history (default 5)",
            options: [
              {
                name: "keep",
                description: "Number of messages to keep",
                type: 4, // INTEGER
                required: false,
              },
            ],
          },
          { name: "context", description: "Show conversation context info" },
          {
            name: "pair",
            description: "Approve a pairing code to grant access",
            options: [
              {
                name: "code",
                description: "The pairing code to approve",
                type: 3, // STRING
                required: true,
              },
            ],
          },
          {
            name: "listen",
            description: "Toggle: bot responds to all messages in this channel (no @mention needed)",
          },
          {
            name: "verbose",
            description: "Toggle: use threads for long Discord replies (default: off)",
          },
        ]);
        logger.info("[discord] Slash commands registered");
      } catch (err) {
        logger.error(`[discord] Failed to register commands: ${err}`);
      }
    });

    this.client.on("messageCreate", async (msg: any) => {
      if (msg.author.bot) return;

      const discordContext = buildDiscordConversationContext(msg);
      const isDM = discordContext.scope === "dm";
      const isListenChannel = this.listenChannels.has(msg.channel.id);
      const isGuildMention =
        !isDM &&
        this.client.user &&
        msg.mentions.has(this.client.user.id);
      const accessPolicy = resolveDiscordAccessPolicy({
        context: discordContext,
        config: this.config.discord,
        isBotMentioned: Boolean(isGuildMention),
        isListenChannel,
      });

      if (!accessPolicy.shouldHandle) return;

      const userId = discordContext.userId;
      const userName = discordContext.displayName;
      let text = msg.content;

      // Strip bot mention from message text
      if (this.client.user) {
        text = text.replace(new RegExp(`<@!?${this.client.user.id}>`, "g"), "").trim();
      }
      const commandText = text.trim();

      if (accessPolicy.publicOnly) {
        const guardReply = buildDiscordPublicGuardReply(text);
        if (guardReply !== null) {
          this.stats.messagesReceived++;
          await msg.reply(guardReply);
          this.stats.messagesSent++;
          logger.info(`[discord] public-only guard reply to ${userName} (${userId})`);
          return;
        }

        if (msg.attachments?.size > 0) {
          this.stats.messagesReceived++;
          await msg.reply("Public Vortex can talk here, not process attachments. User handles the sharp tools.");
          this.stats.messagesSent++;
          logger.info(`[discord] public-only attachment refused for ${userName} (${userId})`);
          return;
        }

        const banterReply = buildDiscordPublicBanterReply(text);
        if (banterReply !== null) {
          this.stats.messagesReceived++;
          await msg.reply(banterReply);
          this.stats.messagesSent++;
          logger.info(`[discord] public-only banter reply to ${userName} (${userId})`);
          return;
        }
      }

      // Handle attachments — accept images plus supported documents/audio.
      let files: FileAttachment[] | undefined;
      if (msg.attachments?.size > 0) {
        const attachmentResult = await resolveDiscordAttachmentPayloads({
          attachments: msg.attachments.values(),
          message_id: msg.id,
          runs: this.runs,
        });
        files = attachmentResult.files;
        if (attachmentResult.shouldStop) {
          if (attachmentResult.reply) await msg.reply(attachmentResult.reply);
          return;
        }
      }

      // If no text and no images, nothing to process
      if (!text && !files) return;

      // Default prompt for attachment-only messages
      if (!text && files) {
        text = files.every((file) => SUPPORTED_IMAGE_TYPES.has(file.mimeType))
          ? "What's in this image?"
          : "Please analyze these attachments.";
      }
      text = await this.withReplyContext(msg, text);

      // --- BTW / Steer routing ---
      // If the agent is actively processing a task for this conversation,
      // route "btw ..." messages as side queries and everything else as steers.
      const btwMatch = accessPolicy.publicOnly
        ? null
        : this.findActiveTaskForConversation(discordContext.conversationId);
      if (btwMatch) {
        const stripped = text.replace(/<@!?\d+>\s*/g, "").trim();
        if (/^btw\b/i.test(stripped)) {
          // BTW — ephemeral side query
          const question = stripped.replace(/^btw\s*/i, "").trim();
          if (!question) {
            await msg.reply("btw... what? Include a question after 'btw'.");
            return;
          }
          try {
            const result = await this.processor.handleBtw(
              btwMatch.agentKey,
              btwMatch.task.message_id,
              question,
              `discord:${userName}`,
            );
            if (result) {
              await msg.reply(result.answer);
            } else {
              await msg.reply("No context available for that question right now.");
            }
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            if (errMsg.includes("Rate limit")) {
              await msg.reply("Too many BTW queries — slow down.");
            } else {
              logger.error(`[discord] BTW failed: ${errMsg}`);
              await msg.reply("BTW query failed. Check logs.");
            }
          }
          return;
        }
          // Steer — mid-task context injection
          try {
            await this.processor.handleSteer(
              btwMatch.agentKey,
              btwMatch.task.message_id,
              btwMatch.task.conversation_id,
              {
                message: stripped,
                priority: "normal",
                source: `discord:${userName}`,
                channel: "discord",
              },
            );
            await msg.react("\u2705");
          } catch (err) {
            logger.error(`[discord] Steer failed: ${err}`);
            await msg.reply("Failed to steer the active task.");
          }
          return;
      }

      // Pairing check
      if (!accessPolicy.publicOnly && this.pairing && !this.pairing.isApproved("discord", userId)) {
        // Auto-approve first user (bootstrap)
        if (!this.pairing.hasAnyApproved("discord")) {
          const code = this.pairing.generateCode("discord", userId, userName);
          this.pairing.approve(code);
          logger.info(`[discord] Auto-approved first user: ${userName} (${userId})`);
          await msg.reply("You're the first user — auto-approved. Welcome!");
        } else {
          const code = this.pairing.generateCode("discord", userId, userName);
          await msg.reply(
            `Pairing required. Your code: \`${code}\`\nSend this code to an approved user so they can run \`/pair ${code}\``,
          );
          return;
        }
      }

      // Rate limit check
      const rateLimitId = normalizeSenderId(userId, isDM ? undefined : msg.channel.id);
      if (!this.queue.checkSenderRateLimit(rateLimitId)) {
        await msg.reply("You're sending messages too fast. Please wait a moment.");
        return;
      }

      if (!accessPolicy.publicOnly && await this.handleTextCommand(msg, commandText, userId, userName, discordContext.senderId)) {
        return;
      }

      this.stats.messagesReceived++;
      logger.info(`[discord] ${userName} (${userId}): ${text.slice(0, 80)}${files ? ` [+${files.length} attachment(s)]` : ""}`);
      const contextInfo = this.processor.getContextDiagnostics("discord", discordContext.senderId);
      logger.info(
        `[discord] context scope=${discordContext.scope} conversation_id=${contextInfo.conversationId} history=${contextInfo.messageCount} summary=${contextInfo.hasSummary ? "yes" : "no"} conversation_memory=${contextInfo.conversationMemoryCount} latest_injected_chars=${contextInfo.latestInjectedChars} latest_memory_lanes=${contextInfo.latestMemoryLaneCount}`,
      );

      // Declare outside try so finally can access them for cleanup
      let typingInterval: ReturnType<typeof setInterval> | null = null;
      let responseStream: MessageStreamManager<any> | null = null;
      const isVerbose = !isDM && this.verboseChannels.has(msg.channel.id);
      const replyPolicy = resolveDiscordReplyPolicy({
        message: msg,
        config: this.config.discord,
        isVerbose,
      });
      let thread: any = null;

      try {
        // Create threads only when verbose mode or Discord config explicitly asks for it.
        if (replyPolicy.shouldCreateThread) {
          try {
            thread = await msg.startThread({
              name: this.buildThreadName(text, files),
              autoArchiveDuration: 60,
            });
          } catch (err) {
            logger.warn(`[discord] Failed to create response thread: ${err}`);
          }
        }
        const typingTarget = thread ?? msg.channel;
        await typingTarget.sendTyping();
        typingInterval = setInterval(() => {
          typingTarget.sendTyping().catch(() => {});
        }, 4000);
        const responseTarget = thread ?? msg.channel;

        let inputRequest: DiscordInputRequestData | null = null;
        const result = await this.processor.processImmediate({
          channel: "discord",
          channel_name: isDM ? undefined : (msg.channel as any).name ?? msg.channel.id,
          sender: userName,
          sender_id: discordContext.senderId,
          sender_role: accessPolicy.publicOnly ? "viewer" : undefined,
          message: text,
          thread_id: msg.id,
          is_group: !isDM,
          files,
          onProgress: async (info) => {
            if (!shouldSurfaceDiscordProgress(info)) {
              return;
            }
            if (!responseStream) {
              responseStream = new MessageStreamManager<any>({
                updateIntervalMs: DISCORD_STREAM_UPDATE_INTERVAL_MS,
                forceFlushChars: DISCORD_STREAM_FORCE_FLUSH_CHARS,
                maxPreviewChars: DISCORD_STREAM_MAX_PREVIEW_CHARS,
                onStart: async () => withRetry(
                  () => responseTarget.send("…"),
                  { baseDelayMs: 500 },
                ),
                onUpdate: async (message, text) => {
                  await withRetry(
                    () => message.edit(text),
                    { baseDelayMs: 500 },
                  );
                },
                render: (text, truncated) => {
                  const previewText = sanitizeResponse(text) || "…";
                  const preview = truncated ? `${previewText}\n\n_Streaming preview..._` : previewText;
                  return preview.length > DISCORD_MAX_MESSAGE_LEN
                    ? `${preview.slice(0, DISCORD_MAX_MESSAGE_LEN - 3)}...`
                    : preview;
                },
                onError: (err) => {
                  logger.debug(`[discord] Streaming update failed: ${err}`);
                },
              });
            }
            responseStream.append(info.textDelta ?? "");
          },
          onEvent: (event) => {
            if (event.type !== "input.requested") return;
            inputRequest = this.toDiscordInputRequest(event.data);
          },
        });

        const activeResponseStream = responseStream as MessageStreamManager<any> | null;
        const streamed = activeResponseStream
          ? await activeResponseStream.finalize()
          : null;

        if (inputRequest) {
          if (streamed?.message) {
            try { await streamed.message.delete(); } catch (err) {
              logger.debug(`[discord] Failed to delete streamed preview before input request: ${err}`);
            }
          }
          await this.postInputRequest(responseTarget, msg.id, inputRequest);
          return;
        }

        const response = sanitizeResponse(result.response);

        // Discord message limit is 2000 chars (-10 safety margin)
        const maxLen = DISCORD_MAX_MESSAGE_LEN;
        if (shouldSendAsFile(response, maxLen)) {
          if (streamed?.message) {
            try { await streamed.message.delete(); } catch (err) {
              logger.debug(`[discord] Failed to delete streamed preview before file response: ${err}`);
            }
          }
          const summary = response.slice(0, 300).split("\n").slice(0, 3).join("\n");
          const preview = summary.length < response.length
            ? `${summary}\n\n_(full response attached)_`
            : response;
          const buffer = createResponseBuffer(response);
          try {
            await withRetry(() => responseTarget.send({ content: preview, files: [{ attachment: buffer, name: "response.md" }] }), { baseDelayMs: 500 });
            this.stats.messagesSent++;
          } catch (err) {
            logger.warn(`[discord] Response delivery failed: ${err}`);
          }
        } else if (response.length <= maxLen) {
          try {
            if (streamed?.message) {
              await withRetry(() => streamed.message.edit(response || "(no response)"), { baseDelayMs: 500 });
            } else {
              await withRetry(() => responseTarget.send(response || "(no response)"), { baseDelayMs: 500 });
            }
            this.stats.messagesSent++;
          } catch (err) {
            logger.warn(`[discord] Response delivery failed: ${err}`);
          }
        } else {
          if (streamed?.message) {
            try { await streamed.message.delete(); } catch (err) {
              logger.debug(`[discord] Failed to delete streamed preview before chunked response: ${err}`);
            }
          }
          const chunks = splitMessage(response, maxLen);
          for (const chunk of chunks) {
            try {
              await withRetry(() => responseTarget.send(chunk), { baseDelayMs: 500 });
            } catch (err) {
              logger.warn(`[discord] Chunk delivery failed: ${err}`);
            }
          }
          this.stats.messagesSent++;
        }
      } catch (err) {
        this.stats.errors++;
        const errorMsg = formatError(err);
        logger.error(`[discord] Error: ${errorMsg}`);
        const streamedMessage = (responseStream as MessageStreamManager<any> | null)?.getMessage();
        if (streamedMessage) {
          try { await streamedMessage.delete(); } catch (deleteErr) {
            logger.debug(`[discord] Failed to delete streamed message after error: ${deleteErr}`);
          }
        }
        if (errorMsg.startsWith("Model override failed:")) {
          await msg.reply(errorMsg);
        } else {
          await msg.reply("Something went wrong. Check logs.");
        }
      } finally {
        if (typingInterval) clearInterval(typingInterval);
      }
    });

    this.client.on("interactionCreate", async (interaction: any) => {
      // Handle proposal approval/rejection buttons
      if (interaction.isButton?.()) {
        const buttonContext = buildDiscordConversationContext(interaction);
        if (shouldIgnoreDiscordDmFromNonPrivilegedUser(buttonContext, this.config.discord)) {
          logger.info(`[discord] ignored non-privileged DM button action from ${buttonContext.displayName} (${buttonContext.userId})`);
          return;
        }

        if (!isDiscordPrivilegedUser(buttonContext.userId, this.config.discord)) {
          const payload = { content: buildDiscordPublicVortexReply("run privileged action"), ephemeral: true };
          if (!interaction.replied && !interaction.deferred) {
            await interaction.reply(payload);
          } else {
            await interaction.followUp(payload).catch(() => {});
          }
          logger.info(`[discord] blocked public button action from ${buttonContext.displayName} (${buttonContext.userId})`);
          return;
        }

        const customId: string = interaction.customId;
        const inputReply = parseDiscordInputChoiceId(customId);
        if (inputReply) {
          try {
            await interaction.deferUpdate();
            let nestedInputRequest: DiscordInputRequestData | null = null;
            const inputContext = buildDiscordConversationContext(interaction);
            const result = await this.processor.resumeSuspendedMessage(inputReply.messageId, inputReply.choice, {
              async: false,
              channel: "discord",
              sender: inputContext.displayName,
              sender_id: inputContext.senderId,
              thread_id: interaction.message?.id,
              onEvent: (event) => {
                if (event.type !== "input.requested") return;
                nestedInputRequest = this.toDiscordInputRequest(event.data);
              },
            });
            try {
              await interaction.message.edit({ components: [] });
            } catch (err) {
              logger.debug(`[discord] Failed to clear input request buttons: ${err}`);
            }
            if (nestedInputRequest) {
              await this.postInputRequest(interaction.channel, interaction.message?.id, nestedInputRequest);
              return;
            }
            if (result.response) {
              if (!interaction.channel) {
                throw new Error("Discord interaction missing channel");
              }
              const responseText = sanitizeResponse(result.response);
              await withRetry(() => interaction.channel.send({
                content: responseText,
                reply: interaction.message?.id ? { messageReference: interaction.message.id } : undefined,
              }), { baseDelayMs: 500 });
              this.stats.messagesSent++;
            }
          } catch (err) {
            logger.error(`[discord] Input reply button failed: ${err}`);
            if (!interaction.replied && !interaction.deferred) {
              await interaction.reply({ content: "Failed to resume request.", ephemeral: true });
            } else {
              await interaction.followUp({ content: "Failed to resume request.", ephemeral: true }).catch(() => {});
            }
          }
          return;
        }

        if (customId.startsWith("proposal:")) {
          const [, action, shortId] = customId.split(":");
          const userName = getDiscordSenderDisplayName(interaction);
          const result = action === "view"
            ? { ok: true, response: this.processor.getProposalDetails(shortId) }
            : this.processor.handleProposalDecision(
                action === "approve" ? "approve" : "reject",
                shortId,
                userName,
                action === "reject" ? `Rejected via Discord by ${userName}` : undefined,
              );
          if (action !== "view") {
            try {
              await interaction.message.edit({ components: [] });
            } catch (err) {
              logger.debug(`[discord] Failed to clear proposal buttons: ${err}`);
            }
          }
          await interaction.reply({ content: result.response, ephemeral: action === "view" });
          return;
        }
      }

      if (!interaction.isChatInputCommand()) return;

      const discordContext = buildDiscordConversationContext(interaction);
      const userId = discordContext.userId;
      const userName = discordContext.displayName;

      if (shouldIgnoreDiscordDmFromNonPrivilegedUser(discordContext, this.config.discord)) {
        logger.info(`[discord] ignored non-privileged DM slash command /${interaction.commandName} from ${userName} (${userId})`);
        return;
      }

      if (!isDiscordPrivilegedUser(userId, this.config.discord)) {
        await interaction.reply({
          content: buildDiscordPublicVortexReply(`/${interaction.commandName}`),
          ephemeral: true,
        });
        logger.info(`[discord] blocked public slash command /${interaction.commandName} from ${userName} (${userId})`);
        return;
      }

      // Pairing check — let /pair through for unapproved users
      if (this.pairing && !this.pairing.isApproved("discord", userId) && interaction.commandName !== "pair") {
        const code = this.pairing.generateCode("discord", userId, userName);
        await interaction.reply({
          content: `Pairing required. Your code: \`${code}\`\nSend this code to an approved user so they can run \`/pair ${code}\``,
          ephemeral: true,
        });
        return;
      }

      switch (interaction.commandName) {
        case "agent": {
          const agents = Object.entries(this.config.agents)
            .map(([key, a]: [string, any]) => `- ${a.name} (@${key}): ${a.model}`)
            .join("\n");
          await interaction.reply(`Agents:\n${agents}`);
          break;
        }

        case "model": {
          const modelInput = interaction.options.getString("name");
          const defaultAgent = resolvePrimaryAgentKey(this.config.agents, this.config.daemon) ?? Object.keys(this.config.agents)[0];

          if (!modelInput) {
            const lines = Object.entries(this.config.agents).map(([key, a]: [string, any]) => {
              const override = this.processor.getModelOverride(userId, key);
              const current = override ?? a.model;
              const suffix = override ? " (override)" : "";
              return `${a.name}: ${current}${suffix}`;
            });
            const aliases = "Aliases: haiku, sonnet, opus, claude, anthropic, flash, pro, gpt, gpt 5.5, gpt 5.4 pro, gpt 5 mini, gpt 5 nano, codex";
            await interaction.reply(`${lines.join("\n")}\n\n${aliases}\n\nUsage: /model <name>`);
            break;
          }

          let agentKey = defaultAgent;
          let model = modelInput;

          if (model.includes(":")) {
            const [a, m] = model.split(":", 2);
            agentKey = a;
            model = m;
          }

          if (!this.config.agents[agentKey]) {
            await interaction.reply(`Unknown agent: ${agentKey}`);
            break;
          }

          if (model === "reset" || model === "default") {
            this.processor.clearModelOverride(userId, agentKey);
            const base = (this.config.agents[agentKey] as any).model;
            await interaction.reply(`${(this.config.agents[agentKey] as any).name} reset to ${base}`);
            break;
          }

          const resolved = resolveModelAlias(model);
          const modelWarning = this.processor.setModelOverride(userId, agentKey, resolved);
          if (modelWarning) {
            await interaction.reply(`⚠️ ${modelWarning}`);
          } else {
            const providerOverride = this.processor.getModelOverrideProvider(userId, agentKey);
            const providerNote = providerOverride && providerOverride !== (this.config.agents[agentKey] as any).provider
              ? ` (${providerOverride})` : "";
            await interaction.reply(`${(this.config.agents[agentKey] as any).name} → ${resolved}${providerNote}`);
          }
          break;
        }

        case "usage": {
          const stats = this.queue.getQueueStats();
          await interaction.reply(
            `Queue stats:\nPending: ${stats.pending}\nProcessing: ${stats.processing}\nSuspended: ${stats.suspended}\nCompleted: ${stats.completed}\nFailed: ${stats.failed}\nDead letters: ${stats.dead_letter}`,
          );
          break;
        }

        case "crawl": {
          await interaction.deferReply();
          try {
            const result = await runCrawlCommand({
              url: interaction.options.getString("url", true),
              saveSource: interaction.options.getBoolean("save") ?? false,
              scope: interaction.options.getString("scope") ?? undefined,
              depth: interaction.options.getInteger("depth") ?? undefined,
              limit: interaction.options.getInteger("limit") ?? undefined,
              origin: "channel:discord",
            }, {
              service: this.crawlService,
              sources: this.crawlSources,
              ingest: this.crawlIngest,
            });
            await interaction.editReply(formatCrawlCommandResult(result));
          } catch (err) {
            await interaction.editReply(`crawl failed: ${err instanceof Error ? err.message : String(err)}`);
          }
          break;
        }

        case "cancel": {
          const cancelSenderId = discordContext.senderId;
          const cancelResult = this.processor.cancelTask("discord", cancelSenderId);
          if (cancelResult.cancelled) {
            await interaction.reply(`Cancelled ${cancelResult.agent} task (was running ${cancelResult.elapsed}s).`);
          } else {
            await interaction.reply("No active task to cancel.");
          }
          break;
        }

        case "new": {
          const newSenderId = discordContext.senderId;
          this.processor.clearConversation("discord", newSenderId);
          await interaction.reply(getDiscordResetConfirmation());
          break;
        }

        case "reset": {
          const resetSenderId = discordContext.senderId;
          this.processor.clearConversation("discord", resetSenderId);
          await interaction.reply(getDiscordResetConfirmation());
          break;
        }

        case "forget": {
          const forgetSenderId = discordContext.senderId;
          const exchanges = interaction.options.getInteger("exchanges") ?? 1;
          const forgetResult = this.processor.forgetMessages("discord", forgetSenderId, exchanges);
          await interaction.reply(
            forgetResult.removed > 0
              ? `Removed ${forgetResult.removed} messages (${exchanges} exchange${exchanges !== 1 ? "s" : ""}).`
              : "Nothing to forget.",
          );
          break;
        }

        case "trim": {
          const trimSenderId = discordContext.senderId;
          const keep = interaction.options.getInteger("keep") ?? 5;
          const trimResult = this.processor.trimConversation("discord", trimSenderId, keep);
          await interaction.reply(
            trimResult.removed > 0
              ? `Trimmed ${trimResult.removed} messages. Keeping last ${keep}.`
              : `Already at or under ${keep} messages.`,
          );
          break;
        }

        case "context": {
          const ctxSenderId = discordContext.senderId;
          const info = this.processor.getContextInfo("discord", ctxSenderId);
          await interaction.reply(
            `**Context:** ${info.messageCount} message${info.messageCount !== 1 ? "s" : ""}${info.hasSummary ? " + summary" : ""}`,
          );
          break;
        }

        case "pair": {
          if (!this.pairing) {
            await interaction.reply({ content: "Pairing is not enabled.", ephemeral: true });
            break;
          }
          const pairCode = interaction.options.getString("code")?.toUpperCase();
          if (!pairCode) {
            await interaction.reply({ content: "Usage: /pair <code>", ephemeral: true });
            break;
          }
          const pairResult = this.pairing.approve(pairCode);
          if (pairResult) {
            await interaction.reply(`Approved ${pairResult.sender} on ${pairResult.channel}.`);
          } else {
            await interaction.reply({ content: "Invalid or expired code.", ephemeral: true });
          }
          break;
        }

        case "listen": {
          const channelId = interaction.channelId;
          const channelName = interaction.channel?.name ?? channelId;

          if (this.listenChannels.has(channelId)) {
            this.listenChannels.delete(channelId);
            this.saveListenChannels();
            await interaction.reply(`Stopped listening in #${channelName}. Use @mention to talk to me here.`);
          } else {
            this.listenChannels.add(channelId);
            this.saveListenChannels();
            await interaction.reply(`Now listening in #${channelName}. I'll respond to all messages here — no @mention needed.`);
          }
          logger.info(`[discord] Listen channels: ${[...this.listenChannels].join(", ") || "none"}`);
          break;
        }

        case "verbose": {
          const vChannelId = interaction.channelId;
          const vChannelName = interaction.channel?.name ?? vChannelId;

          if (this.verboseChannels.has(vChannelId)) {
            this.verboseChannels.delete(vChannelId);
            this.saveVerboseChannels();
            await interaction.reply(`Verbose mode off in #${vChannelName}.`);
          } else {
            this.verboseChannels.add(vChannelId);
            this.saveVerboseChannels();
            await interaction.reply(`Verbose mode on in #${vChannelName}. Long replies will use threads.`);
          }
          logger.info(`[discord] Verbose channels: ${[...this.verboseChannels].join(", ") || "none"}`);
          break;
        }
      }
    });

    await this.client.login(this.botToken);
  }

  private async reconnect(): Promise<void> {
    if (this.client) {
      try { this.client.destroy(); } catch (err) {
        logger.debug(`[discord] Failed to destroy client during reconnect: ${err}`);
      }
    }
    await this.client.login(this.botToken);
  }

  async stop(): Promise<void> {
    this.reconnector.stop();
    this.connected = false;
    if (this.client) {
      logger.info("[discord] Stopping bot...");
      this.client.destroy();
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  getStats(): ChannelStats {
    return { ...this.stats };
  }

  async sendOutbound(recipientId: string, message: string, _agent?: string, replyToId?: string): Promise<void> {
    const sendOpts = replyToId ? { content: message, reply: { messageReference: replyToId } } : message;
    // Try as user DM first, then as channel
    try {
      const user = await this.client.users.fetch(recipientId);
      await withRetry(() => user.send(sendOpts), { baseDelayMs: 500 });
      logger.info(`[discord] sendOutbound delivered as DM to ${recipientId}`);
    } catch (err) {
      logger.debug(`[discord] Failed to send as DM, trying as channel: ${err}`);
      try {
        const channel = await this.client.channels.fetch(recipientId);
        if (channel && "send" in channel) {
          await withRetry(() => (channel as any).send(sendOpts), { baseDelayMs: 500 });
          logger.info(`[discord] sendOutbound delivered to channel ${recipientId}`);
        } else {
          logger.warn(`[discord] sendOutbound: channel ${recipientId} fetched but has no send method (type: ${channel?.type})`);
          return;
        }
      } catch (chErr) {
        logger.warn(`[discord] sendOutbound failed for ${recipientId}: ${chErr}`);
        return;
      }
    }
    this.stats.messagesSent++;
  }

  async sendProposalNotification(recipientId: string, proposal: Proposal): Promise<void> {
    let discord: typeof import("discord.js");
    try {
      // @ts-ignore — discord.js is an optional peer dependency
      discord = await import("discord.js");
    } catch {
      // Fallback to plain text if discord.js can't be imported here
      await this.sendOutbound(recipientId, formatProposalPlainText(proposal));
      return;
    }

    const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = discord;
    const embedData = formatDiscordEmbed(proposal);

    const embed = new EmbedBuilder()
      .setTitle(embedData.embed.title)
      .setDescription(embedData.embed.description)
      .setColor(embedData.embed.color)
      .setFooter(embedData.embed.footer)
      .setTimestamp(new Date(embedData.embed.timestamp));

    for (const field of embedData.embed.fields) {
      embed.addFields({ name: field.name, value: field.value, inline: field.inline });
    }

    const row = new ActionRowBuilder().addComponents(
      ...embedData.buttons.map(b =>
        new ButtonBuilder()
          .setCustomId(b.customId)
          .setLabel(b.label)
          .setStyle(
            b.style === 3
              ? ButtonStyle.Success
              : b.style === 4
                ? ButtonStyle.Danger
                : ButtonStyle.Secondary,
          ),
      ),
    );

    const payload = { embeds: [embed], components: [row] };

    // Try as user DM first, then as channel
    try {
      const user = await this.client.users.fetch(recipientId);
      await withRetry(() => user.send(payload), { baseDelayMs: 500 });
      logger.info(`[discord] sendProposalNotification delivered as DM to ${recipientId}`);
    } catch (err) {
      logger.debug(`[discord] Failed to send proposal as DM, trying as channel: ${err}`);
      try {
        const channel = await this.client.channels.fetch(recipientId);
        if (channel && "send" in channel) {
          await withRetry(() => (channel as any).send(payload), { baseDelayMs: 500 });
          logger.info(`[discord] sendProposalNotification delivered to channel ${recipientId}`);
        } else {
          logger.warn(`[discord] sendProposalNotification: channel ${recipientId} fetched but has no send method (type: ${channel?.type})`);
          return;
        }
      } catch (chErr) {
        logger.warn(`[discord] sendProposalNotification failed for ${recipientId}: ${chErr}`);
        return;
      }
    }
    this.stats.messagesSent++;
  }
}

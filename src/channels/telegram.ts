import { Bot } from "grammy";
import type { Channel, ChannelStats } from "./types.js";
import type { QueueDB } from "../queue/db.js";
import type { QueueProcessor } from "../queue/processor.js";
import type { PairingStore } from "../pairing/pairing.js";
import { parseChannelInputRequest, type NyxHiveConfig, type ParsedChannelInputRequest } from "../types.js";
import { logger } from "../utils/logger.js";
import { formatError } from "../utils/error.js";
import { resolveModelAlias } from "../queue/processor.js";
import {
  buildTelegramHTMLPreview,
  createResponseBuffer,
  markdownToTelegramHTML,
  sanitizeResponse,
  shouldSendAsFile,
  splitTelegramHTML,
} from "./utils.js";
import { InputFile } from "grammy";
import { Reconnector } from "./reconnect.js";
import { type FileAttachment, inferSupportedFileType, MAX_FILE_SIZE } from "../providers/types.js";
import { withRetry } from "../utils/retry.js";
import { normalizeSenderId } from "../utils/sender.js";
import { formatTelegramNotification, formatProposalPlainText } from "../proposals/notifications.js";
import type { Proposal } from "../proposals/store.js";
import type { CrawlIngestBridge, CrawlService, CrawlSourceStore } from "../crawl/index.js";
import { formatCrawlCommandResult, parseCrawlCommandText, runCrawlCommand } from "../crawl/index.js";
import { InflightTracker } from "./inflight.js";
import { resolvePrimaryAgentKey } from "../agents/primary.js";
import { MessageStreamManager } from "./message-streaming.js";
import { chooseTelegramModelTier } from "./telegram-model-routing.js";
import { formatToolLine } from "./tool-activity.js";
import { recordChannelAttachmentBlockedPath } from "./attachment-blockers.js";
import type { DelegationRunStore } from "../runs/store.js";

interface TelegramChannelOpts {
  botToken: string;
  config: NyxHiveConfig;
  queue: QueueDB;
  processor: QueueProcessor;
  pairing?: PairingStore;
  crawlService?: CrawlService;
  crawlSources?: CrawlSourceStore;
  crawlIngest?: CrawlIngestBridge;
  tradingDb?: import("../trading/db.js").TradingDB;
  runs?: DelegationRunStore;
}

type TelegramInputRequestData = ParsedChannelInputRequest;

const TELEGRAM_STREAM_UPDATE_INTERVAL_MS = 300;
const TELEGRAM_STREAM_FORCE_FLUSH_CHARS = 48;
const TELEGRAM_STREAM_MAX_PREVIEW_CHARS = 3000;
const TELEGRAM_MAX_MESSAGE_LEN = 4086;
const TOOL_ACTIVITY_FLUSH_INTERVAL_MS = 3000;
const TOOL_ACTIVITY_MAX_LINES = 8;

export function buildTelegramInputChoiceData(messageId: string, choice: string): string {
  return `input_reply:${messageId}:${encodeURIComponent(choice)}`;
}

export function parseTelegramInputChoiceData(data: string): { messageId: string; choice: string } | null {
  if (!data.startsWith("input_reply:")) return null;
  const rest = data.slice("input_reply:".length);
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

export function isTelegramMessageNotModified(err: unknown): boolean {
  const description = (err as { description?: unknown } | null)?.description;
  const message = err instanceof Error ? err.message : String(err);
  return [description, message].some((text) =>
    typeof text === "string" && text.toLowerCase().includes("message is not modified")
  );
}

async function editTelegramMessageText(fn: () => Promise<unknown>): Promise<void> {
  await withRetry(async () => {
    try {
      await fn();
    } catch (err) {
      if (isTelegramMessageNotModified(err)) return;
      throw err;
    }
  }, { baseDelayMs: 500 });
}

export class TelegramChannel implements Channel {
  name = "telegram";
  private bot: Bot;
  private queue: QueueDB;
  private processor: QueueProcessor;
  private pairing?: PairingStore;
  private config: NyxHiveConfig;
  private crawlService?: CrawlService;
  private crawlSources?: CrawlSourceStore;
  private crawlIngest?: CrawlIngestBridge;
  private tradingDb?: import("../trading/db.js").TradingDB;
  private runs?: DelegationRunStore;
  private pollTimer?: ReturnType<typeof setInterval>;
  private connected = false;
  private stats: ChannelStats = { messagesReceived: 0, messagesSent: 0, errors: 0 };
  private reconnector = new Reconnector({ name: "telegram" });
  private botToken: string;
  private botUsername: string | null = null;
  private readonly inflightHandlers = new InflightTracker();

  constructor(opts: TelegramChannelOpts) {
    this.botToken = opts.botToken;
    this.bot = new Bot(opts.botToken);
    this.queue = opts.queue;
    this.processor = opts.processor;
    this.pairing = opts.pairing;
    this.config = opts.config;
    this.crawlService = opts.crawlService;
    this.crawlSources = opts.crawlSources;
    this.crawlIngest = opts.crawlIngest;
    this.tradingDb = opts.tradingDb;
    this.runs = opts.runs;
    this.setupHandlers();
  }

  private shouldDropReplay(senderId: string, threadId: string): boolean {
    const existing = this.queue.findMessageByThread("telegram", senderId, threadId);
    if (!existing) return false;
    logger.info(`[telegram] Dropping replayed update thread=${threadId} sender=${senderId} existing=${existing}`);
    return true;
  }

  private describeReplyMessage(message: any): string | null {
    if (!message) return null;

    const author = message.from?.first_name ?? message.from?.username ?? "Unknown";
    const text = message.text?.trim()
      ?? message.caption?.trim()
      ?? (message.document ? `file: ${message.document.file_name ?? "document"}` : null)
      ?? (message.photo ? "photo" : null)
      ?? (message.voice ? "voice note" : null)
      ?? (message.audio ? `audio: ${message.audio.title ?? message.audio.file_name ?? "audio"}` : null)
      ?? (message.video ? `video: ${message.video.file_name ?? "video"}` : null)
      ?? null;

    if (!text) return `Replying to ${author}'s message.`;
    const normalized = text.replace(/\s+/g, " ").slice(0, 220);
    return `Replying to ${author}: "${normalized}"`;
  }

  private withReplyContext(messageText: string, replyTo?: any): string {
    const replyContext = this.describeReplyMessage(replyTo);
    return replyContext ? `${replyContext}\n\n${messageText}` : messageText;
  }

  private trackHandler<T>(work: () => Promise<T>): Promise<T> {
    return this.inflightHandlers.track(work());
  }

  private toTelegramInputRequest(data: unknown): TelegramInputRequestData | null {
    return parseChannelInputRequest(data);
  }

  private async sendInputRequest(
    chatId: number,
    replyToMessageId: number | undefined,
    request: TelegramInputRequestData,
  ): Promise<void> {
    const opts: Record<string, unknown> = { parse_mode: "HTML" };
    if (replyToMessageId) {
      opts.reply_to_message_id = replyToMessageId;
    }
    if (request.options.length > 0) {
      opts.reply_markup = {
        inline_keyboard: request.options.map((option) => [{
          text: option.description || option.key,
          callback_data: buildTelegramInputChoiceData(request.messageId, option.key),
        }]),
      };
    }
    await this.bot.api.sendMessage(chatId, markdownToTelegramHTML(request.question), opts);
    this.stats.messagesSent++;
  }

  private setupHandlers(): void {
    // Pairing middleware — check if sender is approved
    if (this.pairing) {
      const pairing = this.pairing;
      this.bot.use(async (ctx, next) => {
        const userId = ctx.from?.id?.toString();
        if (!userId) return;

        // Let /pair command through for everyone (it's the approval mechanism)
        const text = ctx.message && "text" in ctx.message ? ctx.message.text : undefined;
        if (text?.startsWith("/pair")) {
          await next();
          return;
        }

        if (pairing.isApproved("telegram", userId)) {
          await next();
          return;
        }

        // Auto-approve first user on this channel (bootstrap)
        if (!pairing.hasAnyApproved("telegram")) {
          const name = ctx.from?.first_name ?? ctx.from?.username ?? "Unknown";
          pairing.approve(pairing.generateCode("telegram", userId, name));
          logger.info(`[telegram] Auto-approved first user: ${name} (${userId})`);
          await ctx.reply("You're the first user — auto-approved. Welcome!");
          await next();
          return;
        }

        // Not approved — generate pairing code
        const name = ctx.from?.first_name ?? ctx.from?.username ?? "Unknown";
        const code = pairing.generateCode("telegram", userId, name);
        await ctx.reply(
          `Pairing required. Your code: ${code}\nSend this code to an approved user so they can run /pair ${code}`,
        );
      });
    }

    const processBinaryMessage = async (
      ctx: any,
      fileId: string,
      mimeType: string,
      fileName: string,
      messageText: string,
      logLabel: string,
      fileSize?: number,
    ) => {
      const chatId = ctx.chat.id.toString();
      const userId = ctx.from.id.toString();
      const senderName = ctx.from.first_name ?? ctx.from.username ?? "Unknown";
      const isGroup = ctx.chat.type === "group" || ctx.chat.type === "supergroup";

      // In groups, only process if this bot is mentioned (or no bot is mentioned at all)
      if (isGroup && this.botUsername) {
        const mentions = [...messageText.matchAll(/@(\w+)/g)].map(m => m[1].toLowerCase());
        if (mentions.length > 0 && !mentions.includes(this.botUsername)) {
          return; // Message mentions bot(s) but not us
        }
      }

      const rateLimitId = normalizeSenderId(userId, isGroup ? chatId : undefined);
      if (!this.queue.checkSenderRateLimit(rateLimitId)) {
        await ctx.reply("You're sending messages too fast. Please wait a moment.");
        return;
      }
      const threadId = ctx.message.message_id.toString();
      if (this.shouldDropReplay(rateLimitId, threadId)) return;

      if (fileSize && fileSize > MAX_FILE_SIZE) {
        recordChannelAttachmentBlockedPath(this.runs, {
          message_id: threadId,
          channel: "telegram",
          failed_path: "telegram.attachment.size.exceeded",
          trigger: `File too large: ${(fileSize / 1024 / 1024).toFixed(1)}MB`,
          inspected: [`telegram.message.${logLabel}`, "providers.MAX_FILE_SIZE"],
          available_artifacts: [fileName].filter(Boolean),
          missing_primitive: "attachment.limit.size",
          impact: "Telegram attachment request rejected before processing; no model run was started.",
          next_action: "ignore",
          requires_approval: false,
        });
        this.runs?.recordInboundArtifactFailure({
          message_id: threadId,
          channel: "telegram",
          source: `telegram.message.${logLabel}`,
          name: fileName ?? null,
          mime_type: mimeType ?? null,
          size_bytes: fileSize,
          acquisition_error: `File too large: ${(fileSize / 1024 / 1024).toFixed(1)}MB`,
          handler_status: "unsupported",
        });
        await ctx.reply(`File too large (${(fileSize / 1024 / 1024).toFixed(1)}MB). Max is ${MAX_FILE_SIZE / 1024 / 1024}MB.`);
        return;
      }

      const resolvedMimeType = inferSupportedFileType(mimeType, fileName);
      if (!resolvedMimeType) {
        recordChannelAttachmentBlockedPath(this.runs, {
          message_id: threadId,
          channel: "telegram",
          failed_path: "telegram.attachment.mime.unsupported",
          trigger: `Unsupported file type: ${mimeType || "unknown"}`,
          inspected: [
            `telegram.message.${logLabel}`,
            "providers.inferSupportedFileType",
          ],
          available_artifacts: [fileName].filter(Boolean),
          missing_primitive: "attachment.mime.supported_handler",
          impact: "Telegram attachment request rejected before processing; no model run was started.",
          next_action: "fix",
          requires_approval: false,
        });
        this.runs?.recordInboundArtifactFailure({
          message_id: threadId,
          channel: "telegram",
          source: `telegram.message.${logLabel}`,
          name: fileName ?? null,
          mime_type: mimeType ?? null,
          size_bytes: fileSize ?? null,
          acquisition_error: `Unsupported file type: ${mimeType || "unknown"}`,
          handler_status: "unsupported",
        });
        const supported = "CSV, PDF, text, markdown, HTML, JSON, images (JPEG/PNG/GIF/WebP), and common audio files";
        await ctx.reply(`Unsupported file type: ${mimeType}\nSupported: ${supported}`);
        return;
      }

      const files: FileAttachment[] = [];
      let recordedDownloadBlocker = false;
      try {
        const fileInfo = await ctx.api.getFile(fileId);
        if (fileInfo.file_path) {
          const fileUrl = `https://api.telegram.org/file/bot${this.botToken}/${fileInfo.file_path}`;
          const response = await fetch(fileUrl, { signal: AbortSignal.timeout(30_000) });
          if (response.ok) {
            const buffer = await response.arrayBuffer();
            files.push({
              name: fileName || fileInfo.file_path.split("/").pop() || "attachment",
              mimeType: resolvedMimeType,
              base64: Buffer.from(buffer).toString("base64"),
              size: buffer.byteLength,
            });
          } else {
            logger.warn(`[telegram] Failed to download ${logLabel}: HTTP ${response.status}`);
            recordChannelAttachmentBlockedPath(this.runs, {
              message_id: threadId,
              channel: "telegram",
              failed_path: "telegram.attachment.download",
              trigger: `Failed to download ${logLabel}: HTTP ${response.status}`,
              inspected: [
                "telegram.api.getFile",
                "telegram.file.download",
              ],
              available_artifacts: [fileName].filter(Boolean),
              missing_primitive: "attachment.download.fetch",
              impact: "Telegram attachment could not be downloaded; no model run was started.",
              next_action: "retry",
              requires_approval: false,
            });
            this.runs?.recordInboundArtifactFailure({
              message_id: threadId,
              channel: "telegram",
              source: `telegram.message.${logLabel}`,
              name: fileName ?? null,
              mime_type: resolvedMimeType,
              size_bytes: fileSize ?? null,
              acquisition_error: `Failed to download ${logLabel}: HTTP ${response.status}`,
              handler_status: "unsupported",
            });
            recordedDownloadBlocker = true;
          }
        }
      } catch (err) {
        logger.warn(`[telegram] Failed to download ${logLabel}: ${err}`);
        recordChannelAttachmentBlockedPath(this.runs, {
          message_id: threadId,
          channel: "telegram",
          failed_path: "telegram.attachment.download",
          trigger: `Failed to download ${logLabel}: ${formatError(err)}`,
          inspected: [
            "telegram.api.getFile",
            "telegram.file.download",
          ],
          available_artifacts: [fileName].filter(Boolean),
          missing_primitive: "attachment.download.fetch",
          impact: "Telegram attachment could not be downloaded; no model run was started.",
          next_action: "retry",
          requires_approval: false,
        });
        this.runs?.recordInboundArtifactFailure({
          message_id: threadId,
          channel: "telegram",
          source: `telegram.message.${logLabel}`,
          name: fileName ?? null,
          mime_type: resolvedMimeType,
          size_bytes: fileSize ?? null,
          acquisition_error: `Failed to download ${logLabel}: ${formatError(err)}`,
          handler_status: "unsupported",
        });
        recordedDownloadBlocker = true;
      }

      if (files.length === 0) {
        if (!recordedDownloadBlocker) {
          recordChannelAttachmentBlockedPath(this.runs, {
            message_id: threadId,
            channel: "telegram",
            failed_path: "telegram.attachment.download",
            trigger: `Failed to download ${logLabel}: no file payload available`,
            inspected: [
              "telegram.api.getFile",
              "telegram.file.download",
            ],
            available_artifacts: [fileName].filter(Boolean),
            missing_primitive: "attachment.download.fetch",
            impact: "Telegram attachment could not be downloaded; no model run was started.",
            next_action: "retry",
            requires_approval: false,
          });
          this.runs?.recordInboundArtifactFailure({
            message_id: threadId,
            channel: "telegram",
            source: `telegram.message.${logLabel}`,
            name: fileName ?? null,
            mime_type: resolvedMimeType,
            size_bytes: fileSize ?? null,
            acquisition_error: `Failed to download ${logLabel}: no file payload available`,
            handler_status: "unsupported",
          });
        }
        await ctx.reply("Failed to download the file. Please try again.");
        return;
      }

      try {
        await ctx.replyWithChatAction("typing");
        const typingInterval = setInterval(() => {
          ctx.replyWithChatAction("typing").catch(() => {});
        }, 4000);

        let result;
        let inputRequest: TelegramInputRequestData | null = null;
        try {
          result = await this.processor.processImmediate({
            channel: "telegram",
            sender: senderName,
            sender_id: rateLimitId,
            message: messageText,
            thread_id: threadId,
            is_group: isGroup,
            files,
            onEvent: (event) => {
              if (event.type !== "input.requested") return;
              inputRequest = this.toTelegramInputRequest(event.data);
            },
          });
        } finally {
          clearInterval(typingInterval);
        }

        if (inputRequest) {
          await this.sendInputRequest(ctx.chat.id, ctx.message.message_id, inputRequest);
          return;
        }

        const responseText = markdownToTelegramHTML(sanitizeResponse(result.response));
        const fileReplyOpts = { parse_mode: "HTML" as const, reply_to_message_id: ctx.message.message_id };
        const maxLen = TELEGRAM_MAX_MESSAGE_LEN;
        if (shouldSendAsFile(responseText, maxLen)) {
          const preview = buildTelegramHTMLPreview(responseText, 500);
          const buffer = createResponseBuffer(sanitizeResponse(result.response));
          try {
            await withRetry(() => ctx.reply(preview, fileReplyOpts), { baseDelayMs: 500 });
            await withRetry(() => ctx.replyWithDocument(new InputFile(buffer, "response.md")), { baseDelayMs: 500 });
            this.stats.messagesSent++;
          } catch (err) {
            logger.warn(`[telegram] Response delivery failed: ${err}`);
          }
        } else if (responseText.length <= maxLen) {
          try {
            await withRetry(() => ctx.reply(responseText || "(no response)", fileReplyOpts), { baseDelayMs: 500 });
            this.stats.messagesSent++;
          } catch (err) {
            logger.warn(`[telegram] Response delivery failed: ${err}`);
          }
        } else {
          const chunks = splitTelegramHTML(responseText, maxLen);
          for (const chunk of chunks) {
            try {
              await withRetry(() => ctx.reply(chunk, { parse_mode: "HTML" as const }), { baseDelayMs: 500 });
            } catch (err) {
              logger.warn(`[telegram] Chunk delivery failed: ${err}`);
            }
          }
          this.stats.messagesSent++;
        }
      } catch (err) {
        this.stats.errors++;
        const errorMsg = formatError(err);
        logger.error(`[telegram] ${logLabel} handler error: ${errorMsg}`);
        await ctx.reply("Something went wrong processing the file. Check logs.");
      }
    };

    // /start
    this.bot.command("start", async (ctx) => {
      const agentNames = Object.values(this.config.agents).map((a) => a.name).join(", ");
      await ctx.reply(`NyxHive online. Agents: ${agentNames}`);
    });

    // /agent — list agents
    this.bot.command("agent", async (ctx) => {
      const agents = Object.entries(this.config.agents)
        .map(([key, a]) => `- ${a.name} (@${key}): ${a.model}`)
        .join("\n");
      await ctx.reply(`Agents:\n${agents}`);
    });

    // /usage — queue stats + model routing
    this.bot.command("usage", async (ctx) => {
      const queueStats = this.queue.getQueueStats();
      const lines: string[] = [
        `Queue: ${queueStats.pending} pending, ${queueStats.processing} processing, ${queueStats.completed} completed, ${queueStats.failed} failed`,
      ];

      const routing = this.processor.getRoutingStats();
      if (routing && routing.successRates.length > 0) {
        lines.push("\nRouting (7d):");
        for (const r of routing.successRates) {
          lines.push(`  ${r.task_type} → ${r.model}: ${r.success_rate}% (${r.completed}/${r.total})`);
        }
      }

      await ctx.reply(lines.join("\n"));
    });

    this.bot.command("help", async (ctx) => {
      await ctx.reply([
        "Commands:",
        "/help — command list",
        "/status — fleet and model status",
        "/fleet — alias for /status",
        "/cost — conversation tokens and cost",
        "/new — reset conversation",
        "/model [name] — show or switch model override",
        "/proposals — pending proposals awaiting review",
      ].join("\n"));
    });

    const sendStatus = async (ctx: any) => {
      const defaultAgent = resolvePrimaryAgentKey(this.config.agents, this.config.daemon) ?? Object.keys(this.config.agents)[0];
      const modelUserId = ctx.from?.id?.toString() ?? "unknown";
      const override = defaultAgent ? this.processor.getModelOverride(modelUserId, defaultAgent) : null;
      const model = override ?? (defaultAgent ? this.config.agents[defaultAgent]?.model : "unknown");
      await ctx.reply([
        `Agent: ${defaultAgent ?? "unknown"}`,
        `Model: ${model}`,
        "",
        this.processor.getFleetHealthSummary() || "No fleet health available.",
      ].join("\n"));
    };

    this.bot.command("status", sendStatus);
    this.bot.command("fleet", sendStatus);

    this.bot.command("cost", async (ctx) => {
      const userId = ctx.from?.id?.toString();
      if (!userId) return;
      const chatId = ctx.chat?.id?.toString();
      const isGroup = ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";
      const senderId = normalizeSenderId(userId, isGroup && chatId ? chatId : undefined);
      const usage = this.processor.getConversationUsageSummary("telegram", senderId, ctx.from?.first_name ?? ctx.from?.username ?? "Unknown");
      if (!usage) {
        await ctx.reply("No conversation usage yet.");
        return;
      }
      await ctx.reply([
        `Model: ${usage.model ?? "unknown"}`,
        `Tokens: ${usage.total_tokens_in} in / ${usage.total_tokens_out} out`,
        `Estimated cost: $${usage.total_cost_usd.toFixed(4)}`,
        `Messages: ${usage.message_count}`,
      ].join("\n"));
    });

    this.bot.command("proposals", async (ctx) => {
      await ctx.reply(this.processor.formatPendingProposals(8));
    });

    this.bot.command("crawl", async (ctx) => {
      const parsed = parseCrawlCommandText(ctx.message?.text ?? "", "/crawl");
      if (!parsed.ok) {
        await ctx.reply(parsed.error);
        return;
      }
      try {
        const result = await runCrawlCommand(parsed.input, {
          service: this.crawlService,
          sources: this.crawlSources,
          ingest: this.crawlIngest,
        });
        await ctx.reply(formatCrawlCommandResult(result));
      } catch (err) {
        await ctx.reply(`crawl failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

    // /model — view or switch model
    this.bot.command("model", async (ctx) => {
      const args = ctx.message?.text?.split(/\s+/).slice(1) ?? [];
      const defaultAgent = resolvePrimaryAgentKey(this.config.agents, this.config.daemon) ?? Object.keys(this.config.agents)[0];
      const modelUserId = ctx.from?.id?.toString() ?? "unknown";

      if (args.length === 0) {
        // Show current model for each agent
        const lines = Object.entries(this.config.agents).map(([key, a]) => {
          const override = this.processor.getModelOverride(modelUserId, key);
          const current = override ?? a.model;
          const suffix = override ? " (override)" : "";
          return `${a.name}: ${current}${suffix}`;
        });
        const aliases = "Aliases: haiku, sonnet, opus, claude, anthropic, flash, pro, gpt, gpt 5.5, gpt 5.4 pro, gpt 5 mini, gpt 5 nano, codex";
        await ctx.reply(`${lines.join("\n")}\n\n${aliases}\n\nUsage: /model <name>`);
        return;
      }

      // Set model — /model sonnet or /model agent:sonnet or /model gpt 5.5
      let agentKey = defaultAgent;
      let modelInput = args.join(" ");

      if (args[0].includes(":")) {
        const [a, m] = args[0].split(":", 2);
        agentKey = a;
        modelInput = [m, ...args.slice(1)].join(" ");
      }

      if (!this.config.agents[agentKey]) {
        await ctx.reply(`Unknown agent: ${agentKey}`);
        return;
      }

      if (modelInput === "reset" || modelInput === "default") {
        this.processor.clearModelOverride(modelUserId, agentKey);
        const base = this.config.agents[agentKey].model;
        await ctx.reply(`${this.config.agents[agentKey].name} reset to ${base}`);
        return;
      }

      const resolved = resolveModelAlias(modelInput);
      const modelWarning = this.processor.setModelOverride(modelUserId, agentKey, resolved);
      if (modelWarning) {
        await ctx.reply(`⚠️ ${modelWarning}`);
      } else {
        const providerOverride = this.processor.getModelOverrideProvider(modelUserId, agentKey);
        const providerNote = providerOverride && providerOverride !== this.config.agents[agentKey].provider
          ? ` (${providerOverride})` : "";
        await ctx.reply(`${this.config.agents[agentKey].name} → ${resolved}${providerNote}`);
      }
    });

    const cancelActiveTelegramTask = async (ctx: any) => {
      const cancelUserId = ctx.from?.id?.toString();
      if (!cancelUserId) return;
      const cancelChatId = ctx.chat?.id?.toString();
      const cancelIsGroup = ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";
      const cancelSenderId = normalizeSenderId(cancelUserId, cancelIsGroup && cancelChatId ? cancelChatId : undefined);
      const cancelResult = this.processor.cancelTask("telegram", cancelSenderId);
      if (cancelResult.cancelled) {
        await ctx.reply(`Cancelled ${cancelResult.agent} task (was running ${cancelResult.elapsed}s).`);
      } else {
        await ctx.reply("No active task to cancel.");
      }
    };

    this.bot.command("cancel", cancelActiveTelegramTask);
    this.bot.command("stop", cancelActiveTelegramTask);

    // /new — fresh session (clear history + confirm)
    this.bot.command("new", async (ctx) => {
      const newUserId = ctx.from?.id?.toString();
      if (newUserId) {
        const newChatId = ctx.chat?.id?.toString();
        const newIsGroup = ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";
        const newSenderId = normalizeSenderId(newUserId, newIsGroup && newChatId ? newChatId : undefined);
        this.processor.clearConversation("telegram", newSenderId);
      }
      await ctx.reply("Fresh session. What's on?");
    });

    // /reset — clear conversation history
    this.bot.command("reset", async (ctx) => {
      const resetUserId = ctx.from?.id?.toString();
      if (resetUserId) {
        const resetChatId = ctx.chat?.id?.toString();
        const resetIsGroup = ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";
        const resetSenderId = normalizeSenderId(resetUserId, resetIsGroup && resetChatId ? resetChatId : undefined);
        this.processor.clearConversation("telegram", resetSenderId);
      }
      await ctx.reply("Conversation context cleared.");
    });

    // /forget [N] — remove last N exchanges (replaces /undo)
    this.bot.command("forget", async (ctx) => {
      const forgetUserId = ctx.from?.id?.toString();
      if (!forgetUserId) return;
      const forgetChatId = ctx.chat?.id?.toString();
      const forgetIsGroup = ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";
      const forgetSenderId = normalizeSenderId(forgetUserId, forgetIsGroup && forgetChatId ? forgetChatId : undefined);
      const args = ctx.message?.text?.split(/\s+/).slice(1) ?? [];
      const exchanges = Number.parseInt(args[0] ?? "1");
      if (Number.isNaN(exchanges) || exchanges < 1) {
        await ctx.reply("Usage: /forget [N]");
        return;
      }
      const result = this.processor.forgetMessages("telegram", forgetSenderId, exchanges);
      await ctx.reply(
        result.removed > 0
          ? `Removed ${result.removed} messages (${exchanges} exchange${exchanges !== 1 ? "s" : ""}).`
          : "Nothing to forget.",
      );
    });

    // /trim [N] — keep only last N messages
    this.bot.command("trim", async (ctx) => {
      const trimUserId = ctx.from?.id?.toString();
      if (!trimUserId) return;
      const trimChatId = ctx.chat?.id?.toString();
      const trimIsGroup = ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";
      const trimSenderId = normalizeSenderId(trimUserId, trimIsGroup && trimChatId ? trimChatId : undefined);
      const args = ctx.message?.text?.split(/\s+/).slice(1) ?? [];
      const keep = Number.parseInt(args[0] ?? "5");
      if (Number.isNaN(keep) || keep < 1) {
        await ctx.reply("Usage: /trim [N]");
        return;
      }
      const result = this.processor.trimConversation("telegram", trimSenderId, keep);
      await ctx.reply(
        result.removed > 0
          ? `Trimmed ${result.removed} messages. Keeping last ${keep}.`
          : `Already at or under ${keep} messages.`,
      );
    });

    // /context — show context info
    this.bot.command("context", async (ctx) => {
      const ctxUserId = ctx.from?.id?.toString();
      if (!ctxUserId) return;
      const ctxChatId = ctx.chat?.id?.toString();
      const ctxIsGroup = ctx.chat?.type === "group" || ctx.chat?.type === "supergroup";
      const ctxSenderId = normalizeSenderId(ctxUserId, ctxIsGroup && ctxChatId ? ctxChatId : undefined);
      const info = this.processor.getContextInfo("telegram", ctxSenderId);
      await ctx.reply(
        `Context: ${info.messageCount} message${info.messageCount !== 1 ? "s" : ""}${info.hasSummary ? " + summary" : ""}`,
      );
    });

    // /pair <code> — approve a pairing code (only approved users, or self-service with valid code)
    this.bot.command("pair", async (ctx) => {
      if (!this.pairing) {
        await ctx.reply("Pairing is not enabled.");
        return;
      }

      const args = ctx.message?.text?.split(/\s+/).slice(1) ?? [];
      if (args.length === 0) {
        await ctx.reply("Usage: /pair <code>");
        return;
      }

      const code = args[0].toUpperCase();
      const result = this.pairing.approve(code);
      if (result) {
        await ctx.reply(`Approved ${result.sender} on ${result.channel}.`);
      } else {
        await ctx.reply("Invalid or expired code.");
      }
    });

    // --- Trading desk commands (direct DB ops, no LLM) ---

    this.bot.command("watch", async (ctx) => {
      if (!this.tradingDb) { await ctx.reply("Trading desk not enabled."); return; }
      const args = ctx.message?.text?.split(/\s+/).slice(1) ?? [];
      if (args.length === 0) { await ctx.reply("Usage: /watch BTCUSDT [long|short] [4h|1d]"); return; }
      const symbol = args[0].toUpperCase();
      const bias = ["long", "short", "neutral"].includes(args[1]?.toLowerCase()) ? args[1].toLowerCase() : undefined;
      const timeframe = args[bias ? 2 : 1] ?? undefined;
      const market = /USD[T]?$/.test(symbol) || /BTC|ETH|SOL|BNB|XRP|DOGE|ADA|AVAX|LINK|DOT/.test(symbol) ? "crypto" : "forex";
      const item = this.tradingDb.addToWatchlist({ symbol, market, direction_bias: bias, timeframe });
      const biasStr = item.direction_bias ? ` (${item.direction_bias})` : "";
      const tfStr = item.timeframe ? ` ${item.timeframe}` : "";
      await ctx.reply(`Added ${item.symbol}${biasStr}${tfStr} to watchlist`);
    });

    this.bot.command("unwatch", async (ctx) => {
      if (!this.tradingDb) { await ctx.reply("Trading desk not enabled."); return; }
      const args = ctx.message?.text?.split(/\s+/).slice(1) ?? [];
      if (args.length === 0) { await ctx.reply("Usage: /unwatch BTCUSDT"); return; }
      const removed = this.tradingDb.removeFromWatchlist(args[0]);
      await ctx.reply(removed ? `Removed ${args[0].toUpperCase()} from watchlist` : "Not found on watchlist");
    });

    this.bot.command("watchlist", async (ctx) => {
      if (!this.tradingDb) { await ctx.reply("Trading desk not enabled."); return; }
      const items = this.tradingDb.getWatchlist();
      if (items.length === 0) { await ctx.reply("Watchlist is empty. Use /watch to add symbols."); return; }
      const lines = items.map(w => {
        const bias = w.direction_bias ? ` ${w.direction_bias}` : "";
        const tf = w.timeframe ? ` ${w.timeframe}` : "";
        const prio = w.priority > 0 ? (w.priority === 2 ? " !!" : " !") : "";
        return `${w.symbol}${bias}${tf}${prio}`;
      });
      await ctx.reply(`Watchlist (${items.length}):\n${lines.join("\n")}`);
    });

    this.bot.command("pnl", async (ctx) => {
      if (!this.tradingDb) { await ctx.reply("Trading desk not enabled."); return; }
      const risk = this.tradingDb.getRiskState() as any;
      const open = this.tradingDb.getPositions("open");
      const lines = [
        `Daily P&L: $${risk.daily_pnl.toFixed(2)} (limit: $${risk.daily_loss_limit})`,
        `Trades today: ${risk.daily_trades}/${risk.max_daily_trades}`,
        `Weekly P&L: $${risk.weekly_pnl.toFixed(2)}`,
        `Open positions: ${open.length}/${risk.max_concurrent}`,
      ];
      if (open.length > 0) {
        lines.push("");
        for (const p of open) {
          const pnl = p.pnl_usd !== null ? ` ($${p.pnl_usd.toFixed(2)})` : "";
          lines.push(`  ${p.symbol} ${p.direction} @ ${p.entry_price}${pnl}`);
        }
      }
      await ctx.reply(lines.join("\n"));
    });

    this.bot.command("risk", async (ctx) => {
      if (!this.tradingDb) { await ctx.reply("Trading desk not enabled."); return; }
      const risk = this.tradingDb.getRiskState() as any;
      const open = this.tradingDb.getPositions("open");
      const lines = [
        "Risk Management:",
        `  Daily P&L: $${risk.daily_pnl.toFixed(2)} / $${risk.daily_loss_limit}`,
        `  Daily trades: ${risk.daily_trades} / ${risk.max_daily_trades}`,
        `  Open positions: ${open.length} / ${risk.max_concurrent}`,
        `  Max position: $${risk.max_position_size}`,
        `  Risk/trade: ${risk.risk_per_trade_percent}%`,
        `  Balance: ${risk.account_balance ? `$${risk.account_balance.toFixed(2)}` : "not set"}`,
        `  Weekly P&L: $${risk.weekly_pnl.toFixed(2)}`,
      ];
      await ctx.reply(lines.join("\n"));
    });

    this.bot.command("signals", async (ctx) => {
      if (!this.tradingDb) { await ctx.reply("Trading desk not enabled."); return; }
      const signals = this.tradingDb.getSignals({ status: "active", limit: 10 });
      if (signals.length === 0) { await ctx.reply("No active signals."); return; }
      const lines = signals.map(s => {
        const rr = s.risk_reward ? ` RR:${s.risk_reward.toFixed(1)}` : "";
        const conf = s.confidence ? ` (${s.confidence}/10)` : "";
        const entry = s.entry_zone_low && s.entry_zone_high
          ? ` @ ${s.entry_zone_low}-${s.entry_zone_high}`
          : s.entry_zone_low ? ` @ ${s.entry_zone_low}` : "";
        return `[${s.id}] ${s.symbol} ${s.direction} ${s.timeframe}${entry}${rr}${conf}\n  ${s.signal_type} — ${s.rationale.slice(0, 80)}`;
      });
      await ctx.reply(`Active signals:\n\n${lines.join("\n\n")}\n\nReply /take <id> or /pass <id>`);
    });

    this.bot.command("take", async (ctx) => {
      if (!this.tradingDb) { await ctx.reply("Trading desk not enabled."); return; }
      const args = ctx.message?.text?.split(/\s+/).slice(1) ?? [];
      if (args.length === 0) { await ctx.reply("Usage: /take <signal_id>"); return; }
      const signal = this.tradingDb.getSignalById(args[0]);
      if (!signal || signal.status !== "active") { await ctx.reply("Signal not found or not active."); return; }

      // Risk check
      if (signal.stop_loss && signal.entry_zone_low) {
        const check = this.tradingDb.checkRisk(signal.direction, signal.entry_zone_low, signal.stop_loss);
        if (!check.allowed) { await ctx.reply(`Risk check failed: ${check.reason}`); return; }
      }

      const entry = signal.entry_zone_low ?? signal.entry_zone_high ?? 0;
      const pos = this.tradingDb.openPosition({
        signal_id: signal.id,
        symbol: signal.symbol,
        market: signal.market,
        direction: signal.direction,
        entry_price: entry,
        stop_loss: signal.stop_loss ?? undefined,
        take_profit: signal.tp1 ?? undefined,
        confluences: signal.confluences ?? undefined,
      });
      this.tradingDb.updateSignalStatus(signal.id, "triggered");
      const sl = pos.stop_loss ? `\nSL: ${pos.stop_loss}` : "";
      const tp = pos.take_profit ? `\nTP: ${pos.take_profit}` : "";
      await ctx.reply(`Position opened: ${pos.symbol} ${pos.direction} @ ${pos.entry_price}${sl}${tp}\nID: ${pos.id}`);
    });

    this.bot.command("pass", async (ctx) => {
      if (!this.tradingDb) { await ctx.reply("Trading desk not enabled."); return; }
      const args = ctx.message?.text?.split(/\s+/).slice(1) ?? [];
      if (args.length === 0) { await ctx.reply("Usage: /pass <signal_id>"); return; }
      const updated = this.tradingDb.updateSignalStatus(args[0], "passed");
      await ctx.reply(updated ? `Signal ${args[0]} dismissed.` : "Signal not found.");
    });

    this.bot.command("positions", async (ctx) => {
      if (!this.tradingDb) { await ctx.reply("Trading desk not enabled."); return; }
      const positions = this.tradingDb.getPositions("open");
      if (positions.length === 0) { await ctx.reply("No open positions."); return; }
      const lines = positions.map(p => {
        const sl = p.stop_loss ? ` SL:${p.stop_loss}` : "";
        const tp = p.take_profit ? ` TP:${p.take_profit}` : "";
        const size = p.position_size ? ` $${p.position_size}` : "";
        return `[${p.id}] ${p.symbol} ${p.direction} @ ${p.entry_price}${size}${sl}${tp}`;
      });
      await ctx.reply(`Open positions:\n${lines.join("\n")}\n\nUse /close <id> <price> to close`);
    });

    // Alias
    this.bot.command("pos", async (ctx) => {
      if (!this.tradingDb) { await ctx.reply("Trading desk not enabled."); return; }
      const positions = this.tradingDb.getPositions("open");
      if (positions.length === 0) { await ctx.reply("No open positions."); return; }
      const lines = positions.map(p => {
        const sl = p.stop_loss ? ` SL:${p.stop_loss}` : "";
        const tp = p.take_profit ? ` TP:${p.take_profit}` : "";
        return `[${p.id}] ${p.symbol} ${p.direction} @ ${p.entry_price}${sl}${tp}`;
      });
      await ctx.reply(`Open positions:\n${lines.join("\n")}`);
    });

    this.bot.command("close", async (ctx) => {
      if (!this.tradingDb) { await ctx.reply("Trading desk not enabled."); return; }
      const args = ctx.message?.text?.split(/\s+/).slice(1) ?? [];
      if (args.length < 2) { await ctx.reply("Usage: /close <position_id> <exit_price> [grade]"); return; }
      const exitPrice = parseFloat(args[1]);
      if (isNaN(exitPrice)) { await ctx.reply("Invalid price."); return; }
      const pos = this.tradingDb.closePosition(args[0], exitPrice, { grade: args[2] });
      if (!pos) { await ctx.reply("Position not found or already closed."); return; }
      const pnl = pos.pnl_usd !== null ? `$${pos.pnl_usd.toFixed(2)}` : "N/A";
      const pct = pos.pnl_percent !== null ? `${pos.pnl_percent.toFixed(2)}%` : "";
      await ctx.reply(`Closed ${pos.symbol} ${pos.direction} @ ${exitPrice}\nP&L: ${pnl} (${pct})`);
    });

    this.bot.command("todo", async (ctx) => {
      if (!this.tradingDb) { await ctx.reply("Trading desk not enabled."); return; }
      const text = ctx.message?.text?.replace(/^\/todo\s*/, "").trim() ?? "";
      if (!text) { await ctx.reply("Usage: /todo Buy groceries"); return; }
      const priority = text.startsWith("!!") ? 2 : text.startsWith("!") ? 1 : 0;
      const title = text.replace(/^!{1,2}\s*/, "");
      const todo = this.tradingDb.addTodo({ title, priority });
      await ctx.reply(`Todo added: ${todo.title} [${todo.id}]`);
    });

    this.bot.command("todos", async (ctx) => {
      if (!this.tradingDb) { await ctx.reply("Trading desk not enabled."); return; }
      const todos = this.tradingDb.getTodos(false);
      if (todos.length === 0) { await ctx.reply("No pending todos."); return; }
      const lines = todos.map(t => {
        const due = t.due_at ? ` (due: ${new Date(t.due_at).toLocaleDateString()})` : "";
        const overdue = t.due_at && t.due_at < Date.now() ? " OVERDUE" : "";
        const prio = t.priority > 0 ? (t.priority === 2 ? " !!" : " !") : "";
        return `[${t.id}] ${t.title}${prio}${due}${overdue}`;
      });
      await ctx.reply(`Todos (${todos.length}):\n${lines.join("\n")}\n\nUse /done <id> to complete`);
    });

    this.bot.command("done", async (ctx) => {
      if (!this.tradingDb) { await ctx.reply("Trading desk not enabled."); return; }
      const args = ctx.message?.text?.split(/\s+/).slice(1) ?? [];
      if (args.length === 0) { await ctx.reply("Usage: /done <todo_id>"); return; }
      const completed = this.tradingDb.completeTodo(args[0]);
      await ctx.reply(completed ? `Done: ${args[0]}` : "Todo not found.");
    });

    this.bot.command("alert", async (ctx) => {
      if (!this.tradingDb) { await ctx.reply("Trading desk not enabled."); return; }
      const args = ctx.message?.text?.split(/\s+/).slice(1) ?? [];
      if (args.length < 3) { await ctx.reply("Usage: /alert BTC above 100000"); return; }
      const symbol = args[0].toUpperCase();
      const condition = `${args[1].toLowerCase()}:${args[2]}`;
      const alert = this.tradingDb.createAlert({ symbol, condition });
      await ctx.reply(`Alert set: ${symbol} ${args[1]} ${args[2]} [${alert.id}]`);
    });

    this.bot.command("alerts", async (ctx) => {
      if (!this.tradingDb) { await ctx.reply("Trading desk not enabled."); return; }
      const alerts = this.tradingDb.getAlerts(true);
      if (alerts.length === 0) { await ctx.reply("No pending alerts."); return; }
      const lines = alerts.map(a => `[${a.id}] ${a.symbol}: ${a.condition}${a.message ? ` — ${a.message}` : ""}`);
      await ctx.reply(`Alerts (${alerts.length}):\n${lines.join("\n")}`);
    });

    this.bot.command("brief", async (ctx) => {
      if (!this.tradingDb) { await ctx.reply("Trading desk not enabled."); return; }
      const userId = ctx.from?.id?.toString() ?? "unknown";
      const senderName = ctx.from?.first_name ?? ctx.from?.username ?? "Unknown";
      const tradingContext = this.tradingDb.getTradingContext();
      await ctx.replyWithChatAction("typing");
      const typingInterval = setInterval(() => { ctx.replyWithChatAction("typing").catch(() => {}); }, 4000);
      try {
        const result = await this.processor.processImmediate({
          channel: "telegram",
          sender: senderName,
          sender_id: userId,
          agent: "analyst",
          message: `Give me my trading briefing. Here is my current trading state:\n\n${tradingContext}\n\nSearch for current BTC, ETH prices, DXY/EURUSD levels, today's economic calendar, and crypto sentiment. Format as a scannable briefing for Telegram.`,
        });
        const response = markdownToTelegramHTML(sanitizeResponse(result.response));
        const maxLen = TELEGRAM_MAX_MESSAGE_LEN;
        if (response.length <= maxLen) {
          await ctx.reply(response || "(no response)", { parse_mode: "HTML", reply_to_message_id: ctx.message?.message_id });
        } else {
          const chunks = splitTelegramHTML(response, maxLen);
          for (const chunk of chunks) { await ctx.reply(chunk, { parse_mode: "HTML" }); }
        }
        this.stats.messagesSent++;
      } catch (err) {
        logger.error(`[telegram] Brief command error: ${err}`);
        await ctx.reply("Failed to generate briefing.");
      } finally {
        clearInterval(typingInterval);
      }
    });

    this.bot.command("scan", async (ctx) => {
      if (!this.tradingDb) { await ctx.reply("Trading desk not enabled."); return; }
      const args = ctx.message?.text?.split(/\s+/).slice(1) ?? [];
      const userId = ctx.from?.id?.toString() ?? "unknown";
      const senderName = ctx.from?.first_name ?? ctx.from?.username ?? "Unknown";
      const tradingContext = this.tradingDb.getTradingContext();
      const symbolFilter = args[0] ? `Focus on ${args[0].toUpperCase()}.` : "Scan all watchlist symbols.";
      await ctx.replyWithChatAction("typing");
      const typingInterval = setInterval(() => { ctx.replyWithChatAction("typing").catch(() => {}); }, 4000);
      try {
        const result = await this.processor.processImmediate({
          channel: "telegram",
          sender: senderName,
          sender_id: userId,
          agent: "analyst",
          message: `Scan for trade setups. ${symbolFilter}\n\nTrading state:\n${tradingContext}\n\nUse SMC/Wyckoff/ICT methodology. Search for technical analysis on each symbol. Create signals using create_signal for setups with RR >= 1:2 and confidence >= 6. Check existing signals to avoid duplicates.`,
        });
        const response = markdownToTelegramHTML(sanitizeResponse(result.response));
        const maxLen = TELEGRAM_MAX_MESSAGE_LEN;
        if (response.length <= maxLen) {
          await ctx.reply(response || "(no response)", { parse_mode: "HTML", reply_to_message_id: ctx.message?.message_id });
        } else {
          const chunks = splitTelegramHTML(response, maxLen);
          for (const chunk of chunks) { await ctx.reply(chunk, { parse_mode: "HTML" }); }
        }
        this.stats.messagesSent++;
      } catch (err) {
        logger.error(`[telegram] Scan command error: ${err}`);
        await ctx.reply("Failed to run scan.");
      } finally {
        clearInterval(typingInterval);
      }
    });

    this.bot.command("note", async (ctx) => {
      if (!this.tradingDb) { await ctx.reply("Trading desk not enabled."); return; }
      const text = ctx.message?.text?.replace(/^\/note\s*/, "").trim() ?? "";
      if (!text) { await ctx.reply("Usage: /note BTC looks weak at 95k resistance"); return; }
      const note = this.tradingDb.addMarketNote({ category: "observation", content: text, source: "manual" });
      await ctx.reply(`Note saved [${note.id}]`);
    });

    // Handle proposal approval/rejection callback buttons
    this.bot.on("callback_query:data", (ctx) => this.trackHandler(async () => {
      const data = ctx.callbackQuery.data;
      const inputReply = parseTelegramInputChoiceData(data);
      if (inputReply) {
        try {
          let nestedInputRequest: TelegramInputRequestData | null = null;
          const result = await this.processor.resumeSuspendedMessage(inputReply.messageId, inputReply.choice, {
            async: false,
            channel: "telegram",
            sender: ctx.from?.first_name ?? ctx.from?.username ?? "Unknown",
            sender_id: ctx.from?.id?.toString(),
            thread_id: ctx.callbackQuery.message?.message_id?.toString(),
            onEvent: (event) => {
              if (event.type !== "input.requested") return;
              nestedInputRequest = this.toTelegramInputRequest(event.data);
            },
          });
          await ctx.answerCallbackQuery({ text: "Got it." });
          try {
            await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
          } catch (err) {
            logger.debug(`[telegram] Failed to clear input request keyboard: ${err}`);
          }
          if (nestedInputRequest) {
            const chatId = ctx.chat?.id;
            if (!chatId) {
              throw new Error("Telegram callback missing chat context");
            }
            await this.sendInputRequest(chatId, ctx.callbackQuery.message?.message_id, nestedInputRequest);
            return;
          }
          if (result.response) {
            const response = markdownToTelegramHTML(sanitizeResponse(result.response));
            const maxLen = TELEGRAM_MAX_MESSAGE_LEN;
            if (response.length <= maxLen) {
              await ctx.reply(response || "(no response)", {
                parse_mode: "HTML",
                reply_to_message_id: ctx.callbackQuery.message?.message_id,
              });
            } else {
              const chunks = splitTelegramHTML(response, maxLen);
              for (const chunk of chunks) {
                await ctx.reply(chunk, { parse_mode: "HTML" });
              }
            }
            this.stats.messagesSent++;
          }
        } catch (err) {
          await ctx.answerCallbackQuery({ text: "Failed to resume" });
          logger.warn(`[telegram] input reply callback failed: ${err}`);
        }
        return;
      }

      if (!data.startsWith("proposal:")) return;

      const [, action, shortId] = data.split(":");
      const userName = ctx.from?.first_name ?? ctx.from?.username ?? "Unknown";
      const result = action === "view"
        ? { ok: true, response: this.processor.getProposalDetails(shortId) }
        : this.processor.handleProposalDecision(
            action === "approve" ? "approve" : "reject",
            shortId,
            userName,
            action === "reject" ? `Rejected via Telegram by ${userName}` : undefined,
          );

      if (action !== "view") {
        try {
          await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
        } catch (err) {
          logger.debug(`[telegram] Failed to clear proposal keyboard: ${err}`);
        }
      }

      if (result.ok) {
        await ctx.answerCallbackQuery({ text: action === "approve" ? "Approved" : action === "reject" ? "Rejected" : "Details loaded" });
        await ctx.reply(result.response, {
          reply_to_message_id: ctx.callbackQuery.message?.message_id,
        });
      } else {
        await ctx.answerCallbackQuery({ text: "Proposal action failed." });
      }
    }));

    this.bot.on("message:sticker", async (ctx) => {
      await ctx.reply("I can't process stickers yet.");
    });

    // Document messages — download and process (CSV, PDF, text, markdown, JSON, etc.)
    this.bot.on("message:document", (ctx) => this.trackHandler(async () => {
      this.stats.messagesReceived++;
      const userId = ctx.from.id.toString();
      const caption = ctx.message.caption?.trim() ?? "";
      const senderName = ctx.from.first_name ?? ctx.from.username ?? "Unknown";
      const doc = ctx.message.document;

      logger.info(`[telegram] ${senderName} (${userId}): [document] ${doc.file_name ?? "unknown"}${caption ? ` ${caption.slice(0, 60)}` : ""}`);

      const mimeType = doc.mime_type ?? "application/octet-stream";
      const messageText = this.withReplyContext(
        caption || `Analyze this file: ${doc.file_name ?? "document"}`,
        ctx.message.reply_to_message,
      );
      await processBinaryMessage(
        ctx,
        doc.file_id,
        mimeType,
        doc.file_name ?? "document",
        messageText,
        "document",
        doc.file_size,
      );
    }));

    this.bot.on("message:voice", (ctx) => this.trackHandler(async () => {
      this.stats.messagesReceived++;
      const userId = ctx.from.id.toString();
      const senderName = ctx.from.first_name ?? ctx.from.username ?? "Unknown";
      const voice = ctx.message.voice;

      logger.info(`[telegram] ${senderName} (${userId}): [voice]`);

      const messageText = this.withReplyContext(
        "Please transcribe or analyze this voice note.",
        ctx.message.reply_to_message,
      );
      await processBinaryMessage(
        ctx,
        voice.file_id,
        "audio/ogg",
        `voice-${voice.file_unique_id ?? voice.file_id}.ogg`,
        messageText,
        "voice",
        voice.file_size,
      );
    }));

    this.bot.on("message:audio", (ctx) => this.trackHandler(async () => {
      this.stats.messagesReceived++;
      const userId = ctx.from.id.toString();
      const senderName = ctx.from.first_name ?? ctx.from.username ?? "Unknown";
      const caption = ctx.message.caption?.trim() ?? "";
      const audio = ctx.message.audio;

      logger.info(
        `[telegram] ${senderName} (${userId}): [audio] ${audio.file_name ?? audio.title ?? "audio"}${caption ? ` ${caption.slice(0, 60)}` : ""}`,
      );

      const messageText = this.withReplyContext(
        caption || `Please analyze this audio file: ${audio.file_name ?? audio.title ?? "audio"}`,
        ctx.message.reply_to_message,
      );
      await processBinaryMessage(
        ctx,
        audio.file_id,
        audio.mime_type ?? "audio/mpeg",
        audio.file_name ?? `${audio.file_unique_id ?? audio.file_id}.mp3`,
        messageText,
        "audio",
        audio.file_size,
      );
    }));

    this.bot.on("message:video", (ctx) => this.trackHandler(async () => {
      this.stats.messagesReceived++;
      await ctx.reply("Telegram currently supports images and text-like documents only. Video uploads are disabled.");
    }));

    // Photo messages — download and process
    this.bot.on("message:photo", (ctx) => this.trackHandler(async () => {
      this.stats.messagesReceived++;
      const chatId = ctx.chat.id.toString();
      const userId = ctx.from.id.toString();
      const caption = ctx.message.caption?.trim() ?? "";
      const senderName = ctx.from.first_name ?? ctx.from.username ?? "Unknown";
      const isGroup = ctx.chat.type === "group" || ctx.chat.type === "supergroup";

      // In groups, only process if this bot is mentioned (or no bot is mentioned at all)
      if (isGroup && this.botUsername) {
        const mentions = [...caption.matchAll(/@(\w+)/g)].map(m => m[1].toLowerCase());
        if (mentions.length > 0 && !mentions.includes(this.botUsername)) {
          return; // Message mentions bot(s) but not us
        }
      }

      logger.info(`[telegram] ${senderName} (${userId}): [photo]${caption ? ` ${caption.slice(0, 60)}` : ""}`);

      // Rate limit check
      const rateLimitIdPhoto = normalizeSenderId(userId, isGroup ? chatId : undefined);
      if (!this.queue.checkSenderRateLimit(rateLimitIdPhoto)) {
        await ctx.reply("You're sending messages too fast. Please wait a moment.");
        return;
      }

      // Download the largest photo (last in array)
      const photo = ctx.message.photo[ctx.message.photo.length - 1];
      const files: FileAttachment[] = [];

      try {
        const fileInfo = await ctx.api.getFile(photo.file_id);
        if (fileInfo.file_path) {
          const fileUrl = `https://api.telegram.org/file/bot${this.botToken}/${fileInfo.file_path}`;
          const response = await fetch(fileUrl, { signal: AbortSignal.timeout(30_000) });
          if (response.ok) {
            const buffer = await response.arrayBuffer();
            files.push({
              name: fileInfo.file_path.split("/").pop() || "photo.jpg",
              mimeType: "image/jpeg",
              base64: Buffer.from(buffer).toString("base64"),
              size: buffer.byteLength,
            });
          } else {
            logger.warn(`[telegram] Failed to download photo: HTTP ${response.status}`);
          }
        }
      } catch (err) {
        logger.warn(`[telegram] Failed to download photo: ${err}`);
      }

      if (files.length === 0) {
        await ctx.reply("Failed to download the image. Please try again.");
        return;
      }

      const messageText = this.withReplyContext(
        caption || "What's in this image?",
        ctx.message.reply_to_message,
      );
      const senderId = normalizeSenderId(userId, isGroup ? chatId : undefined);
      const threadId = ctx.message.message_id.toString();
      if (this.shouldDropReplay(senderId, threadId)) return;

      try {
        await ctx.replyWithChatAction("typing");
        const typingInterval = setInterval(() => {
          ctx.replyWithChatAction("typing").catch(() => {});
        }, 4000);

        let result;
        let inputRequest: TelegramInputRequestData | null = null;
        try {
          result = await this.processor.processImmediate({
            channel: "telegram",
            sender: senderName,
            sender_id: senderId,
            message: messageText,
            thread_id: threadId,
            is_group: isGroup,
            files,
            onEvent: (event) => {
              if (event.type !== "input.requested") return;
              inputRequest = this.toTelegramInputRequest(event.data);
            },
          });
        } finally {
          clearInterval(typingInterval);
        }

        if (inputRequest) {
          await this.sendInputRequest(ctx.chat.id, ctx.message.message_id, inputRequest);
          return;
        }

        const responseText = markdownToTelegramHTML(sanitizeResponse(result.response));
        const photoReplyOpts = { parse_mode: "HTML" as const, reply_to_message_id: ctx.message.message_id };
        const maxLen = TELEGRAM_MAX_MESSAGE_LEN;
        if (shouldSendAsFile(responseText, maxLen)) {
          const preview = buildTelegramHTMLPreview(responseText, 500);
          const buffer = createResponseBuffer(sanitizeResponse(result.response));
          try {
            await withRetry(() => ctx.reply(preview, photoReplyOpts), { baseDelayMs: 500 });
            await withRetry(() => ctx.replyWithDocument(new InputFile(buffer, "response.md")), { baseDelayMs: 500 });
            this.stats.messagesSent++;
          } catch (err) {
            logger.warn(`[telegram] Response delivery failed: ${err}`);
          }
        } else if (responseText.length <= maxLen) {
          try {
            await withRetry(() => ctx.reply(responseText || "(no response)", photoReplyOpts), { baseDelayMs: 500 });
            this.stats.messagesSent++;
          } catch (err) {
            logger.warn(`[telegram] Response delivery failed: ${err}`);
          }
        } else {
          const chunks = splitTelegramHTML(responseText, maxLen);
          for (const chunk of chunks) {
            try {
              await withRetry(() => ctx.reply(chunk, { parse_mode: "HTML" as const }), { baseDelayMs: 500 });
            } catch (err) {
              logger.warn(`[telegram] Chunk delivery failed: ${err}`);
            }
          }
          this.stats.messagesSent++;
        }
      } catch (err) {
        this.stats.errors++;
        const errorMsg = formatError(err);
        logger.error(`[telegram] Photo handler error: ${errorMsg}`);
        await ctx.reply("Something went wrong processing the image. Check logs.");
      }
    }));

    // Regular messages — enqueue and process
    this.bot.on("message:text", (ctx) => this.trackHandler(async () => {
      this.stats.messagesReceived++;
      const chatId = ctx.chat.id.toString();
      const userId = ctx.from.id.toString();
      const text = ctx.message.text;
      const senderName = ctx.from.first_name ?? ctx.from.username ?? "Unknown";
      const isGroup = ctx.chat.type === "group" || ctx.chat.type === "supergroup";
      const messageText = this.withReplyContext(text, ctx.message.reply_to_message);
      const preRouteModel = chooseTelegramModelTier(text);

      // In groups, only process if this bot is mentioned (or no bot is mentioned at all)
      if (isGroup && this.botUsername) {
        const mentions = [...text.matchAll(/@(\w+)/g)].map(m => m[1].toLowerCase());
        if (mentions.length > 0 && !mentions.includes(this.botUsername)) {
          return; // Message mentions bot(s) but not us
        }
      }

      logger.info(`[telegram] ${senderName} (${userId}): ${text.slice(0, 80)}`);

      // Rate limit check
      const rateLimitId = normalizeSenderId(userId, isGroup ? chatId : undefined);
      if (!this.queue.checkSenderRateLimit(rateLimitId)) {
        await ctx.reply("You're sending messages too fast. Please wait a moment.");
        return;
      }
      const threadId = ctx.message.message_id.toString();
      if (this.shouldDropReplay(rateLimitId, threadId)) return;

      let responseStream: MessageStreamManager<number> | null = null;
      const senderId = rateLimitId;
      try {
        // Send typing indicator every 4s (Telegram expires it after ~5s)
        await ctx.replyWithChatAction("typing");
        const typingInterval = setInterval(() => {
          ctx.replyWithChatAction("typing").catch(() => {});
        }, 4000);

        // Progress tracking for long CLI tasks
        let progressMsgId: number | null = null;
        const toolActivityLines: string[] = [];
        let lastToolActivity = "";
        let toolRepeatCount = 0;
        let progressDirty = false;
        let result;
        let inputRequest: TelegramInputRequestData | null = null;

        // Timer-based flush: batch tool activity updates on a fixed interval
        // instead of editing Telegram messages on every tool event
        const progressFlushInterval = setInterval(async () => {
          if (!progressDirty || toolActivityLines.length === 0) return;
          if (responseStream) return; // streaming phase handles its own messages
          progressDirty = false;
          const status = toolActivityLines.join("\n");
          try {
            if (progressMsgId) {
              await ctx.api.editMessageText(ctx.chat.id, progressMsgId, status);
            } else {
              const sent = await ctx.reply(status);
              progressMsgId = sent.message_id;
            }
          } catch (err) {
            logger.debug(`[telegram] Failed to update progress message: ${err}`);
          }
        }, TOOL_ACTIVITY_FLUSH_INTERVAL_MS);
        try {
          // Process synchronously — enqueue, invoke, return
          result = await this.processor.processImmediate({
            channel: "telegram",
            sender: senderName,
            sender_id: senderId,
            message: messageText,
            thread_id: threadId,
            is_group: isGroup,
            modelHint: preRouteModel.tier,
            onProgress: async (info) => {
              if (info.phase === "responding" && info.streamingSafe && info.textDelta) {
                if (!responseStream) {
                  responseStream = new MessageStreamManager<number>({
                    updateIntervalMs: TELEGRAM_STREAM_UPDATE_INTERVAL_MS,
                    forceFlushChars: TELEGRAM_STREAM_FORCE_FLUSH_CHARS,
                    maxPreviewChars: TELEGRAM_STREAM_MAX_PREVIEW_CHARS,
                    onStart: async () => {
                      if (progressMsgId) {
                        try {
                          await ctx.api.deleteMessage(ctx.chat.id, progressMsgId);
                        } catch (err) {
                          logger.debug(`[telegram] Failed to delete progress message before streaming: ${err}`);
                        }
                        progressMsgId = null;
                      }
                      const sent = await withRetry(
                        () => ctx.reply("…", { parse_mode: "HTML" as const, reply_to_message_id: ctx.message.message_id }),
                        { baseDelayMs: 500 },
                      );
                      return sent.message_id;
                    },
                    onUpdate: async (messageId, text) => {
                      await editTelegramMessageText(
                        () => ctx.api.editMessageText(ctx.chat.id, messageId, text, { parse_mode: "HTML" as const }),
                      );
                    },
                    render: (text, truncated) => {
                      const html = markdownToTelegramHTML(sanitizeResponse(text) || "…");
                      const preview = truncated ? `${html}\n\n<i>Streaming preview…</i>` : html;
                      return preview.length > TELEGRAM_MAX_MESSAGE_LEN
                        ? `${preview.slice(0, TELEGRAM_MAX_MESSAGE_LEN - 3)}...`
                        : preview;
                    },
                    onError: (err) => {
                      logger.debug(`[telegram] Streaming update failed: ${err}`);
                    },
                  });
                }
                responseStream.append(info.textDelta);
                return;
              }

              if (responseStream) return;

              // Working phase only: show tool activity with emojis
              if (info.phase !== "working" || !info.activity) return;

              const line = formatToolLine(info.activity);

              // Skip generic "Reading file" / "Writing file" / "Editing file" — the detailed
              // version with the filename follows immediately from tool_done
              if (/^. (?:Reading|Writing|Editing) file$/.test(line)) return;

              // Dedup consecutive identical activities
              if (line === lastToolActivity) {
                toolRepeatCount++;
                const idx = toolActivityLines.length - 1;
                if (idx >= 0) {
                  toolActivityLines[idx] = `${line} (×${toolRepeatCount + 1})`;
                }
              } else {
                lastToolActivity = line;
                toolRepeatCount = 0;
                toolActivityLines.push(line);
                if (toolActivityLines.length > TOOL_ACTIVITY_MAX_LINES) {
                  toolActivityLines.shift();
                }
              }
              progressDirty = true;
            },
            onEvent: (event) => {
              if (event.type !== "input.requested") return;
              inputRequest = this.toTelegramInputRequest(event.data);
            },
          });
        } finally {
          clearInterval(typingInterval);
          clearInterval(progressFlushInterval);
        }

        const activeResponseStream = responseStream as MessageStreamManager<number> | null;
        const streamed = activeResponseStream
          ? await activeResponseStream.finalize()
          : null;

        // Final flush: ensure progress message shows complete tool trace
        if (!streamed?.message && progressDirty && toolActivityLines.length > 0) {
          const status = toolActivityLines.join("\n");
          try {
            if (progressMsgId) {
              await ctx.api.editMessageText(ctx.chat.id, progressMsgId, status);
            } else {
              const sent = await ctx.reply(status);
              progressMsgId = sent.message_id;
            }
          } catch (err) {
            logger.debug(`[telegram] Failed final progress flush: ${err}`);
          }
        }

        if (inputRequest) {
          if (streamed?.message) {
            try { await ctx.api.deleteMessage(ctx.chat.id, streamed.message); } catch (err) {
              logger.debug(`[telegram] Failed to delete streamed message before input request: ${err}`);
            }
          }
          await this.sendInputRequest(ctx.chat.id, ctx.message.message_id, inputRequest);
          return;
        }

        const response = markdownToTelegramHTML(sanitizeResponse(result.response));
        const replyOpts = { parse_mode: "HTML" as const, reply_to_message_id: ctx.message.message_id };

        // Split long messages (Telegram limit is 4096, -10 safety margin)
        const maxLen = TELEGRAM_MAX_MESSAGE_LEN;
        if (shouldSendAsFile(response, maxLen)) {
          if (streamed?.message) {
            try { await ctx.api.deleteMessage(ctx.chat.id, streamed.message); } catch (err) {
              logger.debug(`[telegram] Failed to delete streamed preview before file response: ${err}`);
            }
          }
          const preview = buildTelegramHTMLPreview(response, 500);
          const buffer = createResponseBuffer(sanitizeResponse(result.response));
          try {
            await withRetry(() => ctx.reply(preview, replyOpts), { baseDelayMs: 500 });
            await withRetry(() => ctx.replyWithDocument(new InputFile(buffer, "response.md")), { baseDelayMs: 500 });
            this.stats.messagesSent++;
          } catch (err) {
            logger.warn(`[telegram] Response delivery failed: ${err}`);
          }
        } else if (response.length <= maxLen) {
          try {
            if (streamed?.message) {
              const streamedMessageId = streamed.message;
              await editTelegramMessageText(
                () => ctx.api.editMessageText(ctx.chat.id, streamedMessageId, response || "(no response)", { parse_mode: "HTML" as const }),
              );
            } else {
              await withRetry(() => ctx.reply(response || "(no response)", replyOpts), { baseDelayMs: 500 });
            }
            this.stats.messagesSent++;
          } catch (err) {
            logger.warn(`[telegram] Response delivery failed: ${err}`);
          }
        } else {
          if (streamed?.message) {
            try { await ctx.api.deleteMessage(ctx.chat.id, streamed.message); } catch (err) {
              logger.debug(`[telegram] Failed to delete streamed preview before chunked response: ${err}`);
            }
          }
          const chunks = splitTelegramHTML(response, maxLen);
          for (const chunk of chunks) {
            try {
              await withRetry(() => ctx.reply(chunk, { parse_mode: "HTML" as const }), { baseDelayMs: 500 });
            } catch (err) {
              logger.warn(`[telegram] Chunk delivery failed: ${err}`);
            }
          }
          this.stats.messagesSent++;
        }
      } catch (err) {
        this.stats.errors++;
        const errorMsg = formatError(err);
        logger.error(`[telegram] Error: ${errorMsg}`);
        const streamedMessageId = (responseStream as MessageStreamManager<number> | null)?.getMessage();
        if (streamedMessageId) {
          try { await ctx.api.deleteMessage(ctx.chat.id, streamedMessageId); } catch (deleteErr) {
            logger.debug(`[telegram] Failed to delete streamed message after error: ${deleteErr}`);
          }
        }
        if (errorMsg.startsWith("Model override failed:")) {
          await ctx.reply(errorMsg);
        } else {
          await ctx.reply("Something went wrong. Check logs.");
        }
      }
    }));
  }

  isConnected(): boolean {
    return this.connected;
  }

  getStats(): ChannelStats {
    return { ...this.stats };
  }

  async sendOutbound(recipientId: string, message: string, _agent?: string, replyToId?: string): Promise<void> {
    try {
      const opts: Record<string, unknown> = { parse_mode: "HTML" };
      if (replyToId) opts.reply_to_message_id = Number(replyToId);
      await withRetry(() => this.bot.api.sendMessage(Number(recipientId), markdownToTelegramHTML(message), opts), { baseDelayMs: 500 });
      this.stats.messagesSent++;
    } catch (err) {
      logger.warn(`[telegram] sendOutbound failed: ${err}`);
    }
  }

  async sendProposalNotification(recipientId: string, proposal: Proposal): Promise<void> {
    try {
      const { text, inlineKeyboard } = formatTelegramNotification(proposal);
      await withRetry(
        () => this.bot.api.sendMessage(Number(recipientId), text, {
          parse_mode: "Markdown",
          reply_markup: { inline_keyboard: inlineKeyboard },
        }),
        { baseDelayMs: 500 },
      );
      this.stats.messagesSent++;
    } catch (err) {
      // Fallback to plain text if markdown/keyboard fails
      logger.debug(`[telegram] Proposal notification with keyboard failed, falling back: ${err}`);
      try {
        await this.sendOutbound(recipientId, formatProposalPlainText(proposal));
      } catch (err2) {
        logger.warn(`[telegram] sendProposalNotification failed: ${err2}`);
      }
    }
  }

  async start(): Promise<void> {
    logger.info("[telegram] Starting bot...");
    await this.bot.api.deleteWebhook({ drop_pending_updates: false });
    this.bot.catch((err) => {
      logger.error(`[telegram] Bot error: ${err}`);
      this.connected = false;
      this.stats.errors++;
      this.reconnector.schedule(() => this.reconnect());
    });
    this.bot.start({
      onStart: (botInfo) => {
        logger.info(`[telegram] Bot started as @${botInfo.username}`);
        this.botUsername = botInfo.username.toLowerCase();
        this.connected = true;
        this.reconnector.reset();
      },
    });
  }

  private async reconnect(): Promise<void> {
    try { await this.bot.stop(); } catch (err) {
      logger.debug(`[telegram] Failed to stop bot during reconnect: ${err}`);
    }
    this.bot = new Bot(this.botToken);
    this.setupHandlers();
    await this.start();
  }

  async stop(): Promise<void> {
    logger.info("[telegram] Stopping bot...");
    this.reconnector.stop();
    if (this.pollTimer) clearInterval(this.pollTimer);
    await this.bot.stop();
    const pendingBefore = this.inflightHandlers.size();
    if (pendingBefore > 0) {
      logger.info(`[telegram] Waiting for ${pendingBefore} in-flight handler(s) to finish`);
    }
    const { drained, pending } = await this.inflightHandlers.waitForIdle(5_000);
    if (!drained) {
      logger.warn(`[telegram] Shutdown continuing with ${pending} in-flight handler(s) still active`);
    } else if (pendingBefore > 0) {
      logger.info("[telegram] In-flight handlers drained before shutdown");
    }
    this.connected = false;
  }
}

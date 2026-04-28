import type { Channel, ChannelStats } from "./types.js";
import type { QueueDB } from "../queue/db.js";
import type { QueueProcessor } from "../queue/processor.js";
import type { PairingStore } from "../pairing/pairing.js";
import type { NyxHiveConfig } from "../types.js";
import { IMessageDB, type IncomingMessage } from "./imessage-db.js";
import { IMessageSender } from "./imessage-send.js";
import { sanitizeResponse, splitMessage } from "./utils.js";
import { resolveModelAlias } from "../queue/processor.js";
import { logger } from "../utils/logger.js";
import { formatError } from "../utils/error.js";
import { withRetry } from "../utils/retry.js";
import { normalizeSenderId } from "../utils/sender.js";
import { clampInt } from "../utils/parse.js";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CrawlIngestBridge, CrawlService, CrawlSourceStore } from "../crawl/index.js";
import { formatCrawlCommandResult, parseCrawlCommandText, runCrawlCommand } from "../crawl/index.js";
import { resolvePrimaryAgentKey } from "../agents/primary.js";

interface IMessageChannelOpts {
  config: NyxHiveConfig;
  queue: QueueDB;
  processor: QueueProcessor;
  pairing?: PairingStore;
  crawlService?: CrawlService;
  crawlSources?: CrawlSourceStore;
  crawlIngest?: CrawlIngestBridge;
}

export class IMessageChannel implements Channel {
  name = "imessage";
  private config: NyxHiveConfig;
  private queue: QueueDB;
  private processor: QueueProcessor;
  private pairing?: PairingStore;
  private crawlService?: CrawlService;
  private crawlSources?: CrawlSourceStore;
  private crawlIngest?: CrawlIngestBridge;
  private db: IMessageDB;
  private sender: IMessageSender;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private allowedNumbers: Set<string> | null;
  private polling = false;
  private connected = false;
  private stats: ChannelStats = { messagesReceived: 0, messagesSent: 0, errors: 0 };

  constructor(opts: IMessageChannelOpts) {
    this.config = opts.config;
    this.queue = opts.queue;
    this.processor = opts.processor;
    this.pairing = opts.pairing;
    this.crawlService = opts.crawlService;
    this.crawlSources = opts.crawlSources;
    this.crawlIngest = opts.crawlIngest;

    const imCfg = opts.config.imessage!;
    const dbPath = imCfg.db_path ?? join(homedir(), "Library/Messages/chat.db");
    this.db = new IMessageDB(dbPath);
    this.sender = new IMessageSender();
    this.allowedNumbers = imCfg.allowed_numbers
      ? new Set(imCfg.allowed_numbers)
      : null;
  }

  async start(): Promise<void> {
    const pollMs = this.config.imessage?.poll_interval_ms ?? 2000;
    logger.info(`[imessage] Starting (poll every ${pollMs}ms)`);
    this.connected = true;
    this.pollTimer = setInterval(() => this.poll(), pollMs);
  }

  async stop(): Promise<void> {
    logger.info("[imessage] Stopping...");
    this.connected = false;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.db.close();
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const messages = this.db.getNewMessages();
      for (const msg of messages) {
        if (this.allowedNumbers && !this.allowedNumbers.has(msg.senderId)) {
          continue;
        }
        if (this.sender.wasSentByUs(msg.text.trim())) {
          logger.debug(`[imessage] Skipping own message (text match): ${msg.text.slice(0, 40)}...`);
          continue;
        }
        if (this.sender.isEchoCooldown(msg.chatIdentifier)) {
          logger.debug(`[imessage] Skipping echo cooldown for ${msg.chatIdentifier}: ${msg.text.slice(0, 40)}...`);
          continue;
        }
        this.stats.messagesReceived++;
        await this.handleMessage(msg);
      }
    } catch (err) {
      logger.error(`[imessage] Poll error: ${err}`);
      this.stats.errors++;
    } finally {
      this.polling = false;
    }
  }

  /** Send a message and advance the DB cursor past any echo it creates */
  private async sendAndSkipEcho(
    recipient: string,
    text: string,
    isGroup: boolean,
    chatGuid?: string,
  ): Promise<void> {
    await this.sender.send(recipient, text, isGroup, chatGuid);
    // Wait for Messages.app to write the sent message to chat.db
    await new Promise((r) => setTimeout(r, 500));
    this.db.advanceToLatest();
  }

  private async handleMessage(msg: IncomingMessage): Promise<void> {
    const senderId = msg.senderId;
    const text = msg.text.trim();
    if (!text) return;

    logger.info(`[imessage] ${senderId}: ${text.slice(0, 80)}`);

    // Pairing check
    if (this.pairing && !this.pairing.isApproved("imessage", senderId)) {
      const code = this.pairing.generateCode("imessage", senderId, senderId);
      await this.sendAndSkipEcho(
        msg.chatIdentifier,
        `Pairing required. Your code: ${code}\nApprove via API: POST /api/pairing/approve { "code": "${code}" }`,
        msg.isGroup,
        msg.chatGuid,
      );
      this.stats.messagesSent++;
      return;
    }

    // Rate limit check
    const rateLimitId = normalizeSenderId(senderId, msg.isGroup ? msg.chatGuid : undefined);
    if (!this.queue.checkSenderRateLimit(rateLimitId)) {
      await this.sendAndSkipEcho(
        msg.chatIdentifier,
        "You're sending messages too fast. Please wait a moment.",
        msg.isGroup,
        msg.chatGuid,
      );
      return;
    }

    // Commands (! prefix since iMessage has no slash commands)
    if (text.startsWith("!")) {
      const handled = await this.handleCommand(text, msg);
      if (handled) return;
    }

    try {
      const result = await this.processor.processImmediate({
        channel: "imessage",
        sender: senderId,
        sender_id: normalizeSenderId(senderId, msg.isGroup ? msg.chatGuid : undefined),
        message: text,
        is_group: msg.isGroup,
      });

      const response = sanitizeResponse(result.response);

      const maxLen = 5000;
      if (response.length <= maxLen) {
        try {
          await withRetry(() => this.sendAndSkipEcho(msg.chatIdentifier, response || "(no response)", msg.isGroup, msg.chatGuid), { baseDelayMs: 500 });
          this.stats.messagesSent++;
        } catch (err) {
          logger.warn(`[imessage] Response delivery failed: ${err}`);
        }
      } else {
        const chunks = splitMessage(response, maxLen);
        for (const chunk of chunks) {
          try {
            await withRetry(() => this.sendAndSkipEcho(msg.chatIdentifier, chunk, msg.isGroup, msg.chatGuid), { baseDelayMs: 500 });
            this.stats.messagesSent++;
          } catch (err) {
            logger.warn(`[imessage] Chunk delivery failed: ${err}`);
          }
        }
      }
    } catch (err) {
      const errorMsg = formatError(err);
      logger.error(`[imessage] Error: ${errorMsg}`);
      this.stats.errors++;
      if (errorMsg.startsWith("Model override failed:")) {
        await this.sendAndSkipEcho(msg.chatIdentifier, errorMsg, msg.isGroup, msg.chatGuid);
      } else {
        await this.sendAndSkipEcho(msg.chatIdentifier, "Something went wrong. Check logs.", msg.isGroup, msg.chatGuid);
      }
      this.stats.messagesSent++;
    }
  }

  private async handleCommand(text: string, msg: IncomingMessage): Promise<boolean> {
    const parts = text.split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const reply = async (content: string) => {
      await this.sendAndSkipEcho(msg.chatIdentifier, content, msg.isGroup, msg.chatGuid);
    };

    switch (cmd) {
      case "!help": {
        await reply(
          "Commands:\n" +
          "!agent - List agents and models\n" +
          "!model <name> - Switch model (e.g. sonnet, opus, agent:model)\n" +
          "!crawl <url> - Crawl a site into knowledge\n" +
          "!cancel - Cancel running task\n" +
          "!reset - Clear conversation history\n" +
          "!undo - Remove last exchange\n" +
          "!forget [N] - Remove last N exchanges (default 1)\n" +
          "!trim [N] - Keep only last N messages (default 5)\n" +
          "!context - Show context info\n" +
          "!usage - Queue stats\n" +
          "!help - This message",
        );
        return true;
      }

      case "!agent": {
        const agents = Object.entries(this.config.agents)
          .map(([key, a]) => `- ${a.name} (@${key}): ${a.model}`)
          .join("\n");
        await reply(`Agents:\n${agents}`);
        return true;
      }

      case "!model": {
        const defaultAgent = resolvePrimaryAgentKey(this.config.agents, this.config.daemon) ?? Object.keys(this.config.agents)[0];
        const modelSenderId = msg.senderId;

        if (parts.length < 2) {
          const lines = Object.entries(this.config.agents).map(([key, a]) => {
            const override = this.processor.getModelOverride(modelSenderId, key);
            const current = override ?? a.model;
            const suffix = override ? " (override)" : "";
            return `${a.name}: ${current}${suffix}`;
          });
          const aliases = "Aliases: haiku, sonnet, opus, claude, anthropic, flash, pro, gpt, gpt 5.5, gpt 5.4 pro, gpt 5 mini, gpt 5 nano, codex";
          await reply(`${lines.join("\n")}\n\n${aliases}\n\nUsage: !model <name>`);
          return true;
        }

        let agentKey = defaultAgent;
        let modelInput = parts.slice(1).join(" ");

        if (parts[1].includes(":")) {
          const [a, m] = parts[1].split(":", 2);
          agentKey = a;
          modelInput = [m, ...parts.slice(2)].join(" ");
        }

        if (!this.config.agents[agentKey]) {
          await reply(`Unknown agent: ${agentKey}`);
          return true;
        }

        if (modelInput === "reset" || modelInput === "default") {
          this.processor.clearModelOverride(modelSenderId, agentKey);
          const base = this.config.agents[agentKey].model;
          await reply(`${this.config.agents[agentKey].name} reset to ${base}`);
          return true;
        }

        const resolved = resolveModelAlias(modelInput);
        const modelWarning = this.processor.setModelOverride(modelSenderId, agentKey, resolved);
        if (modelWarning) {
          await reply(`⚠️ ${modelWarning}`);
        } else {
          const providerOverride = this.processor.getModelOverrideProvider(modelSenderId, agentKey);
          const providerNote = providerOverride && providerOverride !== this.config.agents[agentKey].provider
            ? ` (${providerOverride})` : "";
          await reply(`${this.config.agents[agentKey].name} → ${resolved}${providerNote}`);
        }
        return true;
      }

      case "!crawl": {
        const parsed = parseCrawlCommandText(text, "!crawl");
        if (!parsed.ok) {
          await reply(parsed.error);
          return true;
        }
        try {
          const result = await runCrawlCommand({
            ...parsed.input,
            origin: "channel:imessage",
          }, {
            service: this.crawlService,
            sources: this.crawlSources,
            ingest: this.crawlIngest,
          });
          await reply(formatCrawlCommandResult(result));
        } catch (err) {
          await reply(`crawl failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        return true;
      }

      case "!cancel": {
        const cancelSenderId = normalizeSenderId(msg.senderId, msg.isGroup ? msg.chatGuid : undefined);
        const cancelResult = this.processor.cancelTask("imessage", cancelSenderId);
        if (cancelResult.cancelled) {
          await reply(`Cancelled ${cancelResult.agent} task (was running ${cancelResult.elapsed}s).`);
        } else {
          await reply("No active task to cancel.");
        }
        return true;
      }

      case "!reset": {
        const resetSenderId = normalizeSenderId(msg.senderId, msg.isGroup ? msg.chatGuid : undefined);
        this.processor.clearConversation("imessage", resetSenderId);
        await reply("Conversation context cleared.");
        return true;
      }

      case "!undo": {
        const undoSenderId = normalizeSenderId(msg.senderId, msg.isGroup ? msg.chatGuid : undefined);
        const undoResult = this.processor.undoLastExchange("imessage", undoSenderId);
        await reply(
          undoResult.removed > 0
            ? `Removed last exchange (${undoResult.removed} messages).`
            : "Nothing to undo.",
        );
        return true;
      }

      case "!forget": {
        const forgetSenderId = normalizeSenderId(msg.senderId, msg.isGroup ? msg.chatGuid : undefined);
        const exchanges = clampInt(parts[1], 1, 1, 100);
        const forgetResult = this.processor.forgetMessages("imessage", forgetSenderId, exchanges);
        await reply(
          forgetResult.removed > 0
            ? `Removed ${forgetResult.removed} messages (${exchanges} exchange${exchanges !== 1 ? "s" : ""}).`
            : "Nothing to forget.",
        );
        return true;
      }

      case "!trim": {
        const trimSenderId = normalizeSenderId(msg.senderId, msg.isGroup ? msg.chatGuid : undefined);
        const keep = clampInt(parts[1], 5, 1, 100);
        const trimResult = this.processor.trimConversation("imessage", trimSenderId, keep);
        await reply(
          trimResult.removed > 0
            ? `Trimmed ${trimResult.removed} messages. Keeping last ${keep}.`
            : `Already at or under ${keep} messages.`,
        );
        return true;
      }

      case "!context": {
        const ctxSenderId = normalizeSenderId(msg.senderId, msg.isGroup ? msg.chatGuid : undefined);
        const info = this.processor.getContextInfo("imessage", ctxSenderId);
        await reply(
          `Context: ${info.messageCount} message${info.messageCount !== 1 ? "s" : ""}${info.hasSummary ? " + summary" : ""}`,
        );
        return true;
      }

      case "!usage": {
        const stats = this.queue.getQueueStats();
        await reply(
          `Queue stats:\nPending: ${stats.pending}\nProcessing: ${stats.processing}\nCompleted: ${stats.completed}\nFailed: ${stats.failed}\nDead letters: ${stats.dead_letter}`,
        );
        return true;
      }

      default:
        return false;
    }
  }

  isConnected(): boolean {
    return this.connected;
  }

  getStats(): ChannelStats {
    return { ...this.stats };
  }

  async sendOutbound(recipientId: string, message: string): Promise<void> {
    try {
      await withRetry(() => this.sender.send(recipientId, message, false), { baseDelayMs: 500 });
      this.stats.messagesSent++;
    } catch (err) {
      logger.warn(`[imessage] sendOutbound failed: ${err}`);
    }
  }
}

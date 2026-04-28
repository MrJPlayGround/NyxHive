import type { Channel, ChannelStats } from "./types.js";
import type {
  SlackChannelOpts,
  SlackMessageSurface,
  SlackSlashCommandSurface,
  SlackSurfaceContext,
  SlackSurfaceResult,
} from "./slack-types.js";
import { parseChannelInputRequest, type NyxHiveConfig } from "../types.js";
import type { QueueDB } from "../queue/db.js";
import type { QueueProcessor } from "../queue/processor.js";
import type { PairingStore } from "../pairing/pairing.js";
import type { PairingRole } from "../pairing/pairing.js";
import { mkdirSync, readdirSync, readFileSync, rmSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { logger } from "../utils/logger.js";
import { resolveModelAlias } from "../queue/processor.js";
import { sanitizeResponse, markdownToSlack } from "./utils.js";
import { Reconnector } from "./reconnect.js";
import { SUPPORTED_IMAGE_TYPES, MAX_IMAGE_SIZE, MAX_IMAGES_PER_MESSAGE, type FileAttachment } from "../providers/types.js";
import { withRetry } from "../utils/retry.js";
import { normalizeSenderId } from "../utils/sender.js";
import { clampInt } from "../utils/parse.js";
import type { CrawlIngestBridge, CrawlService, CrawlSourceStore } from "../crawl/index.js";
import { formatCrawlCommandResult, parseCrawlCommandText, runCrawlCommand } from "../crawl/index.js";
import type { AuditLog } from "../utils/audit.js";
import { parseInteractiveDirectives, buildBlockKitBlocks, resolveToken, formatSlackProposalBlocks } from "./slack/interactive.js";
import { editMessage as _editMessage, deleteMessage as _deleteMessage } from "./slack/message-ops.js";
import { resolveSlackIdentity, resolveReactions } from "./slack/identity.js";
import { chunkMessage } from "./slack/chunking.js";
import type { Proposal, ProposalStore } from "../proposals/store.js";
import type { FeedbackStore } from "../memory/feedback.js";
import { renderArgMenu } from "./slack/arg-menus.js";
import { resolveChannelConfig } from "./slack/channel-config.js";
import { formatChannelEvent, formatMemberEvent, formatMessageEvent } from "./slack/events.js";
import { resolvePrimaryAgentKey } from "../agents/primary.js";
import {
  SlackDeliveryManager,
  inferPhase,
  activityDetail,
  type ApprovalRequestData,
  type InputRequestData,
} from "./slack/delivery.js";

/**
 * Build Slack Block Kit blocks from mrkdwn text.
 * Uses section blocks so Slack renders mrkdwn properly.
 * Slack limits blocks text to 3000 chars, so callers should pre-split.
 */
function slackBlocks(text: string): any[] {
  return [{ type: "section", text: { type: "mrkdwn", text } }];
}

const SLACK_ROLE_ORDER: Record<PairingRole, number> = {
  viewer: 0,
  support: 1,
  engineer: 2,
  operator: 3,
};

const BUILTIN_SLACK_COMMANDS = new Set([
  "support",
  "reset",
  "forget",
  "trim",
  "context",
  "pair",
  "agent",
  "model",
  "usage",
  "crawl",
  "cancel",
  "role",
]);

type SlackChangeSummaryEntry = {
  path: string;
  added: number;
  removed: number;
  operation?: string;
};

function pushApprovalRequest(
  requests: ApprovalRequestData[],
  request: ApprovalRequestData,
): void {
  if (requests.some((entry) => entry.proposalId === request.proposalId)) return;
  requests.push(request);
}

function toApprovalRequestData(data: Record<string, unknown>): ApprovalRequestData | null {
  const proposalId = typeof data.proposal_id === "string"
    ? data.proposal_id
    : typeof data.proposalId === "string"
      ? data.proposalId
      : null;
  const title = typeof data.title === "string" ? data.title : null;
  if (!proposalId || !title) return null;

  return {
    proposalId,
    title,
    description: typeof data.description === "string" ? data.description : undefined,
    category: typeof data.category === "string" ? data.category : undefined,
    effort: typeof data.effort === "string" ? data.effort : undefined,
    filesAffected: Array.isArray(data.files_affected)
      ? data.files_affected.filter((file): file is string => typeof file === "string")
      : Array.isArray(data.filesAffected)
        ? data.filesAffected.filter((file): file is string => typeof file === "string")
        : undefined,
  };
}

function toInputRequestData(data: Record<string, unknown>): InputRequestData | null {
  return parseChannelInputRequest(data);
}

function recordSlackChange(
  summary: Map<string, SlackChangeSummaryEntry>,
  executionEvent: { kind?: string; changes?: Array<{ path: string; kind: "add" | "delete" | "update" }> } | undefined,
): void {
  if (!executionEvent || executionEvent.kind !== "file_change" || !Array.isArray(executionEvent.changes)) return;

  for (const change of executionEvent.changes) {
    if (!change?.path) continue;
    const existing = summary.get(change.path) ?? {
      path: change.path,
      added: 0,
      removed: 0,
      operation: change.kind === "add" ? "create" : change.kind === "delete" ? "delete" : "edit",
    };
    if (!existing.operation) {
      existing.operation = change.kind === "add" ? "create" : change.kind === "delete" ? "delete" : "edit";
    }
    summary.set(change.path, existing);
  }
}

/**
 * Slack channel -- Socket Mode via @slack/bolt.
 *
 * Conversation isolation:
 *   - Thread messages: sender_id = "thread:{thread_ts}" (per-thread context)
 *   - DMs: sender_id = "{user_id}" (per-user context)
 */
export class SlackChannel implements Channel {
  name = "slack";
  private app: any = null;
  private config: NyxHiveConfig;
  private processor: QueueProcessor;
  private queue: QueueDB;
  private pairing?: PairingStore;
  private botUserId: string | null = null;
  private monitorChannels: Set<string>;
  private channelAgents: Record<string, string>;
  private autoThread: boolean;
  private botToken: string;
  private appToken: string;
  private crawlService?: CrawlService;
  private crawlSources?: CrawlSourceStore;
  private crawlIngest?: CrawlIngestBridge;
  private auditLog?: AuditLog;
  private connected = false;
  private stats: ChannelStats = { messagesReceived: 0, messagesSent: 0, errors: 0 };
  private reconnector = new Reconnector({ name: "slack" });
  private proposalStore?: ProposalStore;
  private feedbackStore?: FeedbackStore;
  private messageSurfaces: SlackMessageSurface[];
  private slashCommandSurfaces: SlackSlashCommandSurface[];

  // Per-thread output directories — kept alive for 2h of inactivity so follow-up
  // messages in the same thread can reference previously produced files.
  private threadOutputDirs = new Map<string, { dir: string; timer: ReturnType<typeof setTimeout> }>();
  private static readonly OUTPUT_DIR_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

  constructor(opts: SlackChannelOpts) {
    this.config = opts.config;
    this.processor = opts.processor;
    this.queue = opts.queue;
    this.pairing = opts.pairing;
    this.botToken = opts.botToken;
    this.appToken = opts.appToken;
    this.crawlService = opts.crawlService;
    this.crawlSources = opts.crawlSources;
    this.crawlIngest = opts.crawlIngest;
    this.auditLog = opts.auditLog;
    this.monitorChannels = new Set(opts.config.slack?.monitor_channels ?? []);
    this.channelAgents = opts.config.slack?.channel_agents ?? {};
    this.autoThread = opts.config.slack?.auto_thread ?? true;
    this.proposalStore = opts.proposalStore;
    this.feedbackStore = opts.feedbackStore;
    this.messageSurfaces = (opts.slackSurfaces ?? []).flatMap((surface) => surface.messages ?? []);
    this.slashCommandSurfaces = (opts.slackSurfaces ?? []).flatMap((surface) => surface.commands ?? []);
  }

  private getChannelConfig(channelId: string) {
    return resolveChannelConfig(channelId, this.config.slack?.channels);
  }

  private getConfiguredSlackRole(userId: string): PairingRole | null {
    return this.config.slack?.user_roles?.[userId] ?? null;
  }

  private roleAtLeast(role: PairingRole | null | undefined, minimum: PairingRole): boolean {
    if (!role) return false;
    return SLACK_ROLE_ORDER[role] >= SLACK_ROLE_ORDER[minimum];
  }

  private messageMentionsBot(text: string | undefined): boolean {
    return !!(text && this.botUserId && text.includes(`<@${this.botUserId}>`));
  }

  private async postAccessNotice(client: any, channelId: string, userId: string, text: string, threadTs?: string): Promise<void> {
    if (channelId.startsWith("D")) {
      await client.chat.postMessage({
        channel: channelId,
        text,
        thread_ts: threadTs,
      });
      return;
    }
    await client.chat.postEphemeral({
      channel: channelId,
      user: userId,
      text,
    });
  }

  private async enforceAllowedUsers(channelId: string, userId: string, client: any, threadTs?: string): Promise<boolean> {
    const allowedUsers = this.getChannelConfig(channelId).allowed_users ?? [];
    if (allowedUsers.length === 0 || allowedUsers.includes(userId)) return true;

    await this.postAccessNotice(client, channelId, userId, "You are not allowed to use this channel with NyxHive.", threadTs);
    this.auditLog?.log({
      event: "security.slack_access_denied",
      channel: "slack",
      sender_id: userId,
      detail: `channel=${channelId} reason=allowed_users`,
    });
    return false;
  }

  private async ensureSlackUserApproved(
    userId: string,
    channelId: string,
    client: any,
    threadTs?: string,
    senderName?: string,
  ): Promise<PairingRole | null> {
    if (!this.pairing) return "operator";

    const configuredRole = this.getConfiguredSlackRole(userId);
    const existingRole = this.pairing.getRole("slack", userId);
    if (existingRole) {
      if (configuredRole && existingRole !== configuredRole) {
        this.pairing.setRole("slack", userId, configuredRole);
        logger.info(`[slack] Synced configured role for ${userId}: ${existingRole} -> ${configuredRole}`);
        this.auditLog?.log({
          event: "security.slack_role_synced",
          channel: "slack",
          sender_id: userId,
          detail: `from=${existingRole} to=${configuredRole}`,
        });
        return configuredRole;
      }
      return existingRole;
    }

    const userName = senderName ?? await this.lookupSlackUserName(client, userId);
    if (configuredRole) {
      const code = this.pairing.generateCode("slack", userId, userName);
      this.pairing.approve(code, undefined, configuredRole);
      logger.info(`[slack] Auto-approved configured user: ${userName} (${userId}) as ${configuredRole}`);
      this.auditLog?.log({
        event: "security.slack_auto_approved",
        channel: "slack",
        sender_id: userId,
        detail: `role=${configuredRole} source=config`,
      });
      return configuredRole;
    }

    const hasConfiguredRoles = Object.keys(this.config.slack?.user_roles ?? {}).length > 0;
    if (!this.pairing.hasAnyApproved("slack") && !hasConfiguredRoles) {
      const code = this.pairing.generateCode("slack", userId, userName);
      this.pairing.approve(code, undefined, "operator");
      logger.info(`[slack] Auto-approved first user as operator: ${userName} (${userId})`);
      return "operator";
    }

    const autoApproveRole = this.config.slack?.auto_approve_role;
    if (autoApproveRole) {
      const code = this.pairing.generateCode("slack", userId, userName);
      this.pairing.approve(code, undefined, autoApproveRole);
      logger.info(`[slack] Auto-approved workspace user: ${userName} (${userId}) as ${autoApproveRole}`);
      this.auditLog?.log({
        event: "security.slack_auto_approved",
        channel: "slack",
        sender_id: userId,
        detail: `role=${autoApproveRole}`,
      });
      return autoApproveRole;
    }

    const code = this.pairing.generateCode("slack", userId, userName);
    await this.postAccessNotice(
      client,
      channelId,
      userId,
      `Pairing required. Your code: \`${code}\`\nAsk an operator to run \`/pair ${code}\`.`,
      threadTs,
    );
    return null;
  }

  private async authorizeCommand(
    command: any,
    client: any,
    minimumRole?: PairingRole,
    deniedText?: string,
  ): Promise<PairingRole | null> {
    if (!(await this.enforceAllowedUsers(command.channel_id, command.user_id, client, command.thread_ts))) {
      return null;
    }

    const role = await this.ensureSlackUserApproved(
      command.user_id,
      command.channel_id,
      client,
      command.thread_ts,
      command.user_name,
    );
    if (!role) return null;

    if (minimumRole && !this.roleAtLeast(role, minimumRole)) {
      await client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: deniedText ?? `Only ${minimumRole}s can do that.`,
      });
      this.auditLog?.log({
        event: "security.slack_command_denied",
        channel: "slack",
        sender_id: command.user_id,
        detail: `cmd=${command.command ?? "unknown"} role=${role} required=${minimumRole}`,
      });
      return null;
    }

    return role;
  }

  private matchSurfacePattern(pattern: RegExp | string, text: string): string[] | null {
    if (typeof pattern === "string") {
      return text.trim() === pattern ? [] : null;
    }
    const match = text.trim().match(pattern);
    return match ? match.slice(1) : null;
  }

  private buildSurfaceContext(input: {
    text: string;
    args: string[];
    command?: string;
    channelId: string;
    userId: string;
    userName: string;
    threadTs?: string;
    messageTs?: string;
    isDM: boolean;
    role: PairingRole | null;
    client: any;
  }): SlackSurfaceContext {
    return {
      ...input,
      processor: this.processor.getPublicAPI(),
      config: this.config,
      queue: this.queue,
    };
  }

  private async postSurfaceResult(
    client: any,
    target: { channelId: string; userId: string; isDM: boolean; threadTs?: string; messageTs?: string },
    result: SlackSurfaceResult,
  ): Promise<void> {
    if (!result.text) return;

    if (result.ephemeral && !target.isDM) {
      await client.chat.postEphemeral({
        channel: target.channelId,
        user: target.userId,
        text: result.text,
      });
      return;
    }

    await client.chat.postMessage({
      channel: target.channelId,
      text: result.text,
      thread_ts: result.threadTs ?? target.threadTs ?? target.messageTs,
    });
  }

  private async dispatchMessageSurfaces(input: {
    text: string;
    channelId: string;
    userId: string;
    userName: string;
    threadTs?: string;
    messageTs?: string;
    isDM: boolean;
    role: PairingRole | null;
    client: any;
    mentioned: boolean;
  }): Promise<boolean> {
    for (const surface of this.messageSurfaces) {
      if (surface.scope === "dm" && !input.isDM) continue;
      if (surface.scope === "channel" && input.isDM) continue;
      if (surface.mentionOnly && !input.mentioned) continue;
      if (surface.minimumRole && !this.roleAtLeast(input.role, surface.minimumRole)) continue;

      const args = this.matchSurfacePattern(surface.pattern, input.text);
      if (!args) continue;

      const result = await surface.handler(this.buildSurfaceContext({
        text: input.text,
        args,
        channelId: input.channelId,
        userId: input.userId,
        userName: input.userName,
        threadTs: input.threadTs,
        messageTs: input.messageTs,
        isDM: input.isDM,
        role: input.role,
        client: input.client,
      }));
      if (!result.handled) continue;

      await this.postSurfaceResult(input.client, input, result);
      return true;
    }

    return false;
  }

  private async handleRegisteredSlackCommand(
    surface: SlackSlashCommandSurface,
    command: any,
    client: any,
  ): Promise<void> {
    const role = await this.authorizeCommand(command, client, surface.minimumRole);
    if (!role) return;

    const userName = command.user_name || await this.lookupSlackUserName(client, command.user_id);
    const text = typeof command.text === "string" ? command.text.trim() : "";
    const args = text ? text.split(/\s+/).filter(Boolean) : [];
    const result = await surface.handler(this.buildSurfaceContext({
      text,
      args,
      command: surface.command,
      channelId: command.channel_id,
      userId: command.user_id,
      userName,
      threadTs: command.thread_ts,
      isDM: command.channel_id?.startsWith("D") ?? false,
      role,
      client,
    }));
    if (!result.handled) return;

    await this.postSurfaceResult(client, {
      channelId: command.channel_id,
      userId: command.user_id,
      isDM: command.channel_id?.startsWith("D") ?? false,
      threadTs: command.thread_ts,
    }, result);
  }

  private async lookupSlackUserName(client: any, userId: string): Promise<string> {
    try {
      const userInfo = await client.users.info({ user: userId });
      return userInfo.user?.real_name ?? userInfo.user?.name ?? userId;
    } catch {
      return userId;
    }
  }

  async start(): Promise<void> {
    const mode = this.config.slack?.mode ?? "socket";

    if (mode === "http") {
      const webhookPath = this.config.slack?.webhook_path ?? "/slack/events";
      logger.info(`[slack] HTTP events mode enabled — mount verifySlackSignature + parseSlackPayload on ${webhookPath} externally`);
      this.connected = true;
      return;
    }

    let bolt: any;
    try {
      // @ts-ignore -- @slack/bolt is an optional peer dependency
      bolt = await import("@slack/bolt");
    } catch (err) {
      logger.debug(`[slack] @slack/bolt not available: ${err}`);
      throw new Error("@slack/bolt not installed -- run: bun add @slack/bolt");
    }

    const { App, LogLevel } = bolt;
    this.app = new App({
      token: this.botToken,
      appToken: this.appToken,
      socketMode: true,
      logLevel: LogLevel.INFO,
    });

    this.setupHandlers();

    await this.app.start();
    this.connected = true;
    this.reconnector.reset();
    const auth = await this.app.client.auth.test();
    this.botUserId = auth.user_id ?? null;
    logger.info(`[slack] Connected as ${auth.user} (${this.botUserId})`);
  }

  private async reconnect(): Promise<void> {
    if (this.app) {
      try { await this.app.stop(); } catch (err) {
        logger.debug(`[slack] Failed to stop app during reconnect: ${err}`);
      }
    }
    this.app = null;
    await this.start();
  }

  async stop(): Promise<void> {
    this.reconnector.stop();
    // Clean up all thread output dirs on shutdown
    for (const threadTs of [...this.threadOutputDirs.keys()]) {
      this.evictThreadOutputDir(threadTs);
    }
    if (this.app) {
      await this.app.stop();
      this.connected = false;
      logger.info("[slack] Disconnected");
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
      const slackMsg = markdownToSlack(message);
      await withRetry(() => this.app.client.chat.postMessage({
        channel: recipientId,
        text: slackMsg,
        blocks: slackBlocks(slackMsg),
      }), { baseDelayMs: 500 });
      this.stats.messagesSent++;
    } catch (err) {
      logger.warn(`[slack] sendOutbound failed: ${err}`);
    }
  }

  async editMessage(channel: string, ts: string, text: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.app) return { ok: false, error: "not connected" };
    return _editMessage(this.app.client, channel, ts, text);
  }

  async deleteMessage(channel: string, ts: string): Promise<{ ok: boolean; error?: string }> {
    if (!this.app) return { ok: false, error: "not connected" };
    return _deleteMessage(this.app.client, channel, ts);
  }

  async sendProposalNotification(recipientId: string, proposal: Proposal): Promise<void> {
    try {
      const blocks = formatSlackProposalBlocks(proposal);
      await withRetry(() => this.app.client.chat.postMessage({
        channel: recipientId,
        text: `Proposal: ${proposal.title}`,
        blocks,
      }), { baseDelayMs: 500 });
      this.stats.messagesSent++;
    } catch (err) {
      logger.warn(`[slack] sendProposalNotification failed: ${err}`);
    }
  }

  private async deliverStructuredSlackResult(opts: {
    client: any;
    delivery: SlackDeliveryManager;
    channelId: string;
    threadTs?: string;
    responseText: string;
    result: { response: string; agent?: string; tokens_in?: number; tokens_out?: number; cost?: number };
    agent?: string;
    processStartMs: number;
    changes: Array<{ path: string; added: number; removed: number; operation?: string }>;
    approvalRequests: ApprovalRequestData[];
    inputRequest: InputRequestData | null;
  }): Promise<void> {
    const response = markdownToSlack(sanitizeResponse(opts.responseText));
    const chunkLimit = this.config.slack?.chunk_limit ?? 3000;

    if (opts.changes.length > 0) {
      await opts.delivery.postChangeSummary({
        files: opts.changes,
        summary: "Updated during this run.",
      });
    }

    if (opts.approvalRequests.length > 0) {
      await opts.delivery.updatePhase("waiting_approval");
      for (const request of opts.approvalRequests) {
        await opts.delivery.postApprovalRequest(request);
      }
    }

    if (opts.inputRequest) {
      await opts.delivery.updatePhase("waiting_input");
      await opts.delivery.postInputRequest(opts.inputRequest);
      await opts.delivery.finalize();
      return;
    }

    const interactiveEnabled = this.config.slack?.interactive_replies ?? false;
    let responseText = response;
    let lastChunkBlocks: any[] | undefined;
    if (interactiveEnabled) {
      const parsed = parseInteractiveDirectives(response);
      if (parsed.directives.length > 0) {
        responseText = parsed.cleanText;
        const callbackId = randomUUID().slice(0, 12);
        lastChunkBlocks = buildBlockKitBlocks(
          markdownToSlack(parsed.cleanText),
          parsed.directives,
          callbackId,
        );
      }
    }

    const chunks = chunkMessage(responseText, chunkLimit);
    const agentIdentity = resolveSlackIdentity(this.config.agents[opts.agent ?? ""]?.identity);

    if (chunks.length <= 1 && !lastChunkBlocks) {
      await opts.delivery.postCompletionSummary({
        text: responseText,
        agent: opts.result.agent ?? opts.agent,
        durationMs: Date.now() - opts.processStartMs,
        tokensIn: opts.result.tokens_in,
        tokensOut: opts.result.tokens_out,
        cost: opts.result.cost,
      });
      return;
    }

    await opts.delivery.finalize();
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const isLast = i === chunks.length - 1;
      const blocks = isLast && lastChunkBlocks ? lastChunkBlocks : slackBlocks(chunk);
      try {
        await withRetry(() => opts.client.chat.postMessage({
          channel: opts.channelId,
          text: chunk,
          blocks,
          thread_ts: opts.threadTs,
          ...agentIdentity,
        }), { baseDelayMs: 500 });
        this.stats.messagesSent++;
      } catch (err) {
        logger.warn(`[slack] Chunk delivery failed: ${err}`);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Handler registration
  // ---------------------------------------------------------------------------

  private setupHandlers(): void {
    // Regular messages (channels + DMs)
    this.app.message(async ({ message, client }: any) => {
      await this.handleMessage(message, client);
    });

    // @mentions in non-monitored channels
    this.app.event("app_mention", async ({ event, client }: any) => {
      await this.handleMention(event, client);
    });

    // Slash commands
    this.app.command("/support", async ({ command, ack, client }: any) => {
      await ack();
      await this.handleSupportCommand(command, client);
    });

    this.app.command("/reset", async ({ command, ack, client }: any) => {
      await ack();
      await this.handleResetCommand(command, client);
    });

    this.app.command("/forget", async ({ command, ack, client }: any) => {
      await ack();
      await this.handleForgetCommand(command, client);
    });

    this.app.command("/trim", async ({ command, ack, client }: any) => {
      await ack();
      await this.handleTrimCommand(command, client);
    });

    this.app.command("/context", async ({ command, ack, client }: any) => {
      await ack();
      await this.handleContextCommand(command, client);
    });

    this.app.command("/pair", async ({ command, ack, client }: any) => {
      await ack();
      await this.handlePairCommand(command, client);
    });

    this.app.command("/agent", async ({ command, ack }: any) => {
      await ack();
      await this.handleAgentCommand(command);
    });

    this.app.command("/model", async ({ command, ack }: any) => {
      await ack();
      await this.handleModelCommand(command);
    });

    this.app.command("/usage", async ({ command, ack, client }: any) => {
      await ack();
      await this.handleUsageCommand(command, client);
    });

    this.app.command("/crawl", async ({ command, ack, client }: any) => {
      await ack();
      await this.handleCrawlCommand(command, client);
    });

    this.app.command("/cancel", async ({ command, ack, client }: any) => {
      await ack();
      await this.handleCancelCommand(command, client);
    });

    this.app.command("/role", async ({ command, ack, client }: any) => {
      await ack();
      await this.handleRoleCommand(command, client);
    });

    const registeredCommands = new Set(BUILTIN_SLACK_COMMANDS);
    for (const surface of this.slashCommandSurfaces) {
      const commandName = surface.command.replace(/^\//, "").trim();
      if (!commandName) continue;
      if (registeredCommands.has(commandName)) {
        logger.warn(`[slack] Skipping extension command /${commandName}: name already registered`);
        continue;
      }
      registeredCommands.add(commandName);
      this.app.command(`/${commandName}`, async ({ command, ack, client }: any) => {
        await ack();
        await this.handleRegisteredSlackCommand(surface, command, client);
      });
    }

    // Reaction workflows
    this.app.event("reaction_added", async ({ event, client }: any) => {
      await this.handleReaction(event, client);
    });

    // Channel lifecycle events
    this.app.event("channel_created", async ({ event }: any) => {
      const formatted = formatChannelEvent("channel_created", event);
      logger.info(`[slack] Channel created: ${formatted.channel_name} (${formatted.channel_id})`);
    });
    this.app.event("channel_rename", async ({ event }: any) => {
      const formatted = formatChannelEvent("channel_rename", event);
      logger.info(`[slack] Channel renamed: ${formatted.channel_name} (${formatted.channel_id})`);
    });
    this.app.event("member_joined_channel", async ({ event }: any) => {
      const formatted = formatMemberEvent("member_joined_channel", event);
      logger.info(`[slack] Member joined: ${formatted.user_id} in ${formatted.channel_id}`);
    });
    this.app.event("member_left_channel", async ({ event }: any) => {
      const formatted = formatMemberEvent("member_left_channel", event);
      logger.info(`[slack] Member left: ${formatted.user_id} from ${formatted.channel_id}`);
    });

    // Interactive element handlers (buttons/selects from agent directives)
    this.app.action(/^nyxhive:reply_button:/, async ({ action, ack, client, body }: any) => {
      await ack();
      const value = resolveToken(action.value);
      if (!value) return;
      const channelId = body.channel?.id;
      const threadTs = body.message?.thread_ts ?? body.message?.ts;
      if (!channelId) return;
      // Send the resolved value as a new message from the user who clicked
      await this.handleInteractiveReply(channelId, body.user?.id, threadTs, value, client);
    });

    this.app.action(/^nyxhive:reply_select:/, async ({ action, ack, client, body }: any) => {
      await ack();
      const value = resolveToken(action.selected_option?.value);
      if (!value) return;
      const channelId = body.channel?.id;
      const threadTs = body.message?.thread_ts ?? body.message?.ts;
      if (!channelId) return;
      await this.handleInteractiveReply(channelId, body.user?.id, threadTs, value, client);
    });

    this.app.action(/^nyxhive:arg_menu:/, async ({ action, ack, client, body }: any) => {
      await ack();
      const value: string = action.value ?? action.selected_option?.value;
      if (!value) return;
      const channelId = body.channel?.id;
      const userId = body.user?.id;
      if (!channelId || !userId) return;
      await client.chat.postEphemeral({
        channel: channelId,
        user: userId,
        text: `Selected: \`${value}\``,
      });
    });

    this.app.action(/^nyxhive:input_choice:/, async ({ action, ack, client, body }: any) => {
      await ack();
      const value = typeof action.value === "string" ? action.value : null;
      if (!value) return;
      const channelId = body.channel?.id;
      const threadTs = body.message?.thread_ts ?? body.message?.ts;
      if (!channelId) return;
      await this.handleInteractiveReply(channelId, body.user?.id, threadTs, value, client);
    });

    this.app.action(/^nyxhive:proposal_approve:/, async ({ action, ack, client, body }: any) => {
      await ack();
      if (!this.proposalStore) return;
      const proposalId = action.value;
      const approvedBy = body.user?.id ?? "slack-unknown";
      const callerRole = this.pairing?.getRole("slack", approvedBy) ?? (this.pairing ? null : "operator");
      if (!this.roleAtLeast(callerRole, "operator")) {
        const responseChannel = body.channel?.id ?? approvedBy;
        await this.postAccessNotice(client, responseChannel, approvedBy, "Only operators can approve proposals.", body.message?.thread_ts ?? body.message?.ts);
        this.auditLog?.log({
          event: "security.slack_proposal_denied",
          channel: "slack",
          sender_id: approvedBy,
          detail: `action=approve proposal=${proposalId} role=${callerRole ?? "unknown"}`,
        });
        return;
      }
      try {
        const result = this.proposalStore.approve(proposalId, approvedBy);
        if (result) {
          this.processor.emitEvent("proposal:approved", {
            proposal_id: proposalId,
            title: result.title,
            category: result.category,
            description: result.description,
            proposed_by: result.proposed_by,
            approved_by: approvedBy,
          });
          this.processor.getProposalExecutor()?.onApproved(proposalId, "approval").catch((err) =>
            logger.error(`[slack] Auto-execute on Slack approval failed: ${err}`),
          );
        }
        await client.chat.postMessage({
          channel: body.channel?.id ?? body.user?.id,
          text: result ? `Proposal \`${proposalId}\` approved by <@${approvedBy}>.` : `Proposal \`${proposalId}\` not found or already processed.`,
        });
      } catch (err) {
        logger.warn(`[slack] Proposal approve action failed: ${err}`);
      }
    });

    this.app.action(/^nyxhive:proposal_reject:/, async ({ action, ack, client, body }: any) => {
      await ack();
      if (!this.proposalStore) return;
      const proposalId = action.value;
      const rejectedBy = body.user?.id ?? "slack-unknown";
      const callerRole = this.pairing?.getRole("slack", rejectedBy) ?? (this.pairing ? null : "operator");
      if (!this.roleAtLeast(callerRole, "operator")) {
        const responseChannel = body.channel?.id ?? rejectedBy;
        await this.postAccessNotice(client, responseChannel, rejectedBy, "Only operators can reject proposals.", body.message?.thread_ts ?? body.message?.ts);
        this.auditLog?.log({
          event: "security.slack_proposal_denied",
          channel: "slack",
          sender_id: rejectedBy,
          detail: `action=reject proposal=${proposalId} role=${callerRole ?? "unknown"}`,
        });
        return;
      }
      try {
        const result = this.proposalStore.reject(proposalId, "Rejected via Slack");
        if (result) {
          this.processor.emitEvent("proposal:rejected", {
            proposalId,
            reason: "Rejected via Slack",
          });
        }
        await client.chat.postMessage({
          channel: body.channel?.id ?? body.user?.id,
          text: result ? `Proposal \`${proposalId}\` rejected.` : `Proposal \`${proposalId}\` not found or already processed.`,
        });
      } catch (err) {
        logger.warn(`[slack] Proposal reject action failed: ${err}`);
      }
    });

    this.app.error(async (error: any) => {
      logger.error(`[slack] App error: ${error}`);
      this.connected = false;
      this.stats.errors++;
      this.reconnector.schedule(() => this.reconnect());
    });
  }

  // ---------------------------------------------------------------------------
  // Message handler
  // ---------------------------------------------------------------------------

  private async handleMessage(message: any, client: any): Promise<void> {
    // Skip bot messages, subtypes (edits, deletes, joins, etc.) — but allow file_share, message_changed, message_deleted
    const allowedSubtypes = new Set(["file_share", "message_changed", "message_deleted"]);
    const ignoredSubtype = message.subtype && !allowedSubtypes.has(message.subtype);
    if (ignoredSubtype) return;

    // Track message edits and deletes as system events, then bail
    if (message.subtype === "message_changed" || message.subtype === "message_deleted") {
      const formatted = formatMessageEvent(message.subtype, message);
      logger.info(`[slack] ${formatted.type}: ${formatted.previous_text?.slice(0, 50)} → ${formatted.new_text?.slice(0, 50) ?? "(deleted)"}`);
      this.auditLog?.log({
        event: `message.${message.subtype === "message_changed" ? "edited" : "deleted"}`,
        channel: "slack",
        sender_id: formatted.user_id ?? "unknown",
        detail: `ts=${formatted.ts}`,
      });
      return;
    }

    if (!message.user || message.user === this.botUserId) return;

    const channelId: string = message.channel;
    const isDM = channelId.startsWith("D");
    const isMonitored = this.monitorChannels.has(channelId);
    const channelConfig = this.getChannelConfig(channelId);
    const mentioned = this.messageMentionsBot(message.text);

    if (!(await this.enforceAllowedUsers(channelId, message.user, client, message.thread_ts ?? message.ts))) {
      return;
    }

    // In non-monitored channels, only respond to thread replies where bot participates
    if (!isDM && !isMonitored) {
      if (!message.thread_ts) return;
      const isParticipating = await this.isBotInThread(client, channelId, message.thread_ts);
      if (!isParticipating) return;
    }

    if (!isDM && isMonitored && channelConfig.require_mention) {
      const isParticipatingThread = message.thread_ts
        ? await this.isBotInThread(client, channelId, message.thread_ts)
        : false;
      if (!mentioned && !isParticipatingThread) return;
    }

    const text: string | undefined = message.text?.trim();

    // Extract file attachments from Slack message
    let files: FileAttachment[] | undefined;
    const textFileParts: string[] = [];
    const MAX_TEXT_FILE_SIZE = 512 * 1024; // 512KB per text file

    if (message.files?.length) {
      const imageFiles = (message.files as any[]).filter(
        (f) => f.mimetype && SUPPORTED_IMAGE_TYPES.has(f.mimetype),
      );
      const textFiles = (message.files as any[]).filter(
        (f) => f.mimetype && isTextMimetype(f.mimetype),
      );

      // Handle image files
      if (imageFiles.length > MAX_IMAGES_PER_MESSAGE) {
        await client.chat.postMessage({
          channel: channelId,
          text: `Too many images. Max ${MAX_IMAGES_PER_MESSAGE} per message.`,
          thread_ts: message.thread_ts ?? message.ts,
        });
        return;
      }

      if (imageFiles.length > 0) {
        files = [];
        for (const file of imageFiles) {
          if (file.size > MAX_IMAGE_SIZE) {
            await client.chat.postMessage({
              channel: channelId,
              text: `Image "${file.name}" is too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Max 5MB.`,
              thread_ts: message.thread_ts ?? message.ts,
            });
            return;
          }
          if (file.url_private) {
            try {
              const response = await fetch(file.url_private, {
                headers: { Authorization: `Bearer ${this.botToken}` },
                signal: AbortSignal.timeout(30_000),
              });
              if (response.ok) {
                const buffer = await response.arrayBuffer();
                files.push({
                  name: file.name || "attachment",
                  mimeType: file.mimetype,
                  base64: Buffer.from(buffer).toString("base64"),
                  size: file.size || buffer.byteLength,
                });
              } else {
                logger.warn(`[slack] Failed to download file ${file.name}: HTTP ${response.status}`);
              }
            } catch (err) {
              logger.warn(`[slack] Failed to download file ${file.name}: ${err}`);
            }
          }
        }
        if (files.length === 0) files = undefined;
      }

      // Handle text-based files (CSV, JSON, TXT, etc.) — download and inline as text
      for (const file of textFiles) {
        if (!file.url_private) continue;
        if (file.size > MAX_TEXT_FILE_SIZE) {
          // Too large to inline — download to disk so the agent can Read it
          try {
            const dir = join(tmpdir(), `nyxhive-files-${randomUUID()}`);
            mkdirSync(dir, { recursive: true });
            const localPath = join(dir, file.name);
            const response = await fetch(file.url_private, {
              headers: { Authorization: `Bearer ${this.botToken}` },
              signal: AbortSignal.timeout(120_000),
            });
            if (response.ok) {
              await Bun.write(localPath, await response.arrayBuffer());
              const sizeMB = (file.size / (1024 * 1024)).toFixed(1);
              textFileParts.push(`[File saved: ${localPath} (${sizeMB}MB)]`);
              logger.info(`[slack] Large text file "${file.name}" saved to ${localPath} (${sizeMB}MB)`);
            } else {
              logger.warn(`[slack] Failed to download large text file ${file.name}: HTTP ${response.status}`);
            }
          } catch (err) {
            logger.warn(`[slack] Failed to save large text file ${file.name}: ${err}`);
          }
          continue;
        }
        try {
          const response = await fetch(file.url_private, {
            headers: { Authorization: `Bearer ${this.botToken}` },
            signal: AbortSignal.timeout(30_000),
          });
          if (response.ok) {
            const content = await response.text();
            textFileParts.push(`--- File: ${file.name} ---\n${content}\n--- End: ${file.name} ---`);
          } else {
            logger.warn(`[slack] Failed to download text file ${file.name}: HTTP ${response.status}`);
          }
        } catch (err) {
          logger.warn(`[slack] Failed to download text file ${file.name}: ${err}`);
        }
      }

      // No usable content at all
      const unsupported = (message.files as any[]).filter(
        (f) => !f.mimetype || (!SUPPORTED_IMAGE_TYPES.has(f.mimetype) && !isTextMimetype(f.mimetype)),
      );
      if (unsupported.length > 0 && !imageFiles.length && !textFiles.length && !text) {
        await client.chat.postMessage({
          channel: channelId,
          text: "I can't process this file type. Supported: images (JPEG, PNG, GIF, WebP) and text files (CSV, JSON, TXT, XML, etc.).",
          thread_ts: message.thread_ts ?? message.ts,
        });
        return;
      }
    }

    if (!text && !files && textFileParts.length === 0) return;

    // Build message text: user text + any inlined file content
    let messageText: string;
    if (textFileParts.length > 0) {
      const fileContent = textFileParts.join("\n\n");
      messageText = text ? `${text}\n\n${fileContent}` : fileContent;
    } else {
      messageText = text || "What's in this image?";
    }

    this.stats.messagesReceived++;

    // Pairing check
    const senderRole = await this.ensureSlackUserApproved(
      message.user,
      channelId,
      client,
      message.thread_ts ?? message.ts,
    );
    if (!senderRole) return;

    // Conversation key: thread-based for channels, user-based for DMs
    const threadTs = message.thread_ts ?? message.ts;
    const senderId = isDM ? message.user : normalizeSenderId("thread", threadTs);
    const agent = this.channelAgents[channelId] ?? undefined;

    // BTW/steer routing — intercept messages to actively processing agents
    // Strip bot mention from text for the BTW prefix check
    const cleanText = (text ?? "").replace(/<@[A-Z0-9]+>/gi, "").trim();
    if (cleanText) {
      const handled = await this.tryBtwSteerRouting({
        text: cleanText,
        agent,
        senderId,
        channelId,
        userId: message.user,
        threadTs,
        messageTs: message.ts,
        client,
      });
      if (handled) return;
    }

    // Rate limit check (per user, not per thread)
    if (!this.queue.checkSenderRateLimit(message.user)) {
      await client.chat.postMessage({
        channel: channelId,
        text: "You're sending messages too fast. Please wait a moment.",
        thread_ts: message.thread_ts ?? message.ts,
      });
      return;
    }

    const userInfo = await client.users.info({ user: message.user });
    const senderName: string = userInfo.user?.real_name ?? userInfo.user?.name ?? message.user;
    logger.info(`[slack] ${senderName} (${senderId}): ${messageText.slice(0, 80)}${files ? ` [+${files.length} image(s)]` : ""}`);

    if (!files && textFileParts.length === 0 && text) {
      const handledBySurface = await this.dispatchMessageSurfaces({
        text,
        channelId,
        userId: message.user,
        userName: senderName,
        threadTs,
        messageTs: message.ts,
        isDM,
        role: senderRole,
        client,
        mentioned,
      });
      if (handledBySurface) return;
    }

    // --- Slack delivery UX ---
    const replyTs = this.autoThread ? threadTs : undefined;
    const agentKey = agent ?? resolvePrimaryAgentKey(this.config.agents, this.config.daemon) ?? Object.keys(this.config.agents)[0] ?? "";
    const reactions = resolveReactions(this.config.agents[agentKey]?.identity);
    await this.addReaction(client, channelId, message.ts, reactions.ack);

    const delivery = new SlackDeliveryManager({
      client,
      channelId,
      threadTs: replyTs ?? threadTs,
      gatewayBaseUrl: this.config.server?.public_url,
    });
    const changeSummary = new Map<string, SlackChangeSummaryEntry>();
    const approvalRequests: ApprovalRequestData[] = [];
    let inputRequest: InputRequestData | null = null;

    await delivery.updatePhase("planning");

    // Reuse (or create) a per-thread output directory — kept alive for 2h of inactivity
    const outputDir = this.getOrCreateThreadOutputDir(threadTs);
    const finalMessage = `${messageText}\n\n[Output Directory: ${outputDir} — if you produce any output files (e.g. modified CSVs, reports), save them here and I will send them back to the user automatically.]`;

    const processStartMs = Date.now();

    try {
      const result = await this.processor.processImmediate({
        channel: "slack",
        sender: senderName,
        sender_id: senderId,
        sender_role: senderRole ?? undefined,
        message: finalMessage,
        agent,
        is_group: !isDM,
        files,
        onProgress: (info) => {
          recordSlackChange(changeSummary, info.executionEvent);
          const phase = inferPhase(info.activity, info.phase);
          const detail = activityDetail(info.activity);
          delivery.updatePhase(phase, detail).catch(() => {});
        },
        onEvent: (event) => {
          const data = (event.data ?? {}) as Record<string, unknown>;
          if (event.type === "proposal:created") {
            const request = toApprovalRequestData(data);
            if (request) pushApprovalRequest(approvalRequests, request);
          } else if (event.type === "input.requested" && !inputRequest) {
            inputRequest = toInputRequestData(data);
          }
        },
      });

      await this.removeReaction(client, channelId, message.ts, reactions.ack);
      await this.addReaction(client, channelId, message.ts, reactions.done);

      // Upload any output files the agent produced
      await this.uploadOutputFiles(client, channelId, replyTs, outputDir);
      const changedFiles = [...changeSummary.values()].sort((a, b) => a.path.localeCompare(b.path));

      await this.deliverStructuredSlackResult({
        client,
        delivery,
        channelId,
        threadTs: replyTs,
        responseText: result.response,
        result,
        agent,
        processStartMs,
        changes: changedFiles,
        approvalRequests,
        inputRequest,
      });

      this.auditLog?.log({
        event: "message.completed",
        channel: "slack",
        sender_id: message.user,
        agent: result.agent ?? agent,
        detail: `role=${senderRole ?? "unknown"} duration=${Date.now() - processStartMs}ms`,
      });
    } catch (err) {
      logger.error(`[slack] Error processing message: ${err}`);
      this.stats.errors++;
      await delivery.postFailureSummary({
        error: String(err),
      });
      await this.removeReaction(client, channelId, message.ts, reactions.ack);
      await this.addReaction(client, channelId, message.ts, reactions.error);
    }
  }

  // ---------------------------------------------------------------------------
  // @mention handler
  // ---------------------------------------------------------------------------

  private async handleMention(event: any, client: any): Promise<void> {
    const text = event.text.replace(/<@[A-Z0-9]+>/gi, "").trim();
    if (!text) return;

    this.stats.messagesReceived++;
    if (!(await this.enforceAllowedUsers(event.channel, event.user, client, event.thread_ts ?? event.ts))) {
      return;
    }
    const mentionRole = await this.ensureSlackUserApproved(
      event.user,
      event.channel,
      client,
      event.thread_ts ?? event.ts,
    );
    if (!mentionRole) return;

    const threadTs = event.thread_ts ?? event.ts;
    const senderId = normalizeSenderId("thread", threadTs);
    const agent = this.channelAgents[event.channel] ?? undefined;

    // BTW/steer routing — intercept messages to actively processing agents
    if (text) {
      const handled = await this.tryBtwSteerRouting({
        text,
        agent,
        senderId,
        channelId: event.channel,
        userId: event.user,
        threadTs,
        messageTs: event.ts,
        client,
      });
      if (handled) return;
    }

    // Rate limit check
    if (!this.queue.checkSenderRateLimit(event.user)) {
      await client.chat.postMessage({
        channel: event.channel,
        text: "You're sending messages too fast. Please wait a moment.",
        thread_ts: threadTs,
      });
      return;
    }

    const userInfo = await client.users.info({ user: event.user });
    const senderName: string = userInfo.user?.real_name ?? event.user;

    logger.info(`[slack] @mention from ${senderName} (${senderId}): ${text.slice(0, 80)}`);

    const handledBySurface = await this.dispatchMessageSurfaces({
      text,
      channelId: event.channel,
      userId: event.user,
      userName: senderName,
      threadTs,
      messageTs: event.ts,
      isDM: false,
      role: mentionRole,
      client,
      mentioned: true,
    });
    if (handledBySurface) return;

    // Fetch thread context if this mention is inside a thread
    let messageWithContext = text;
    if (event.thread_ts) {
      const threadContext = await this.fetchThreadContext(client, event.channel, event.thread_ts, event.ts);
      if (threadContext) {
        messageWithContext = `${threadContext}\n\n[New message]\n<${senderName}> ${text}`;
      }
    }

    // --- Slack delivery UX ---
    const mentionAgentKey = agent ?? resolvePrimaryAgentKey(this.config.agents, this.config.daemon) ?? Object.keys(this.config.agents)[0] ?? "";
    const mentionReactions = resolveReactions(this.config.agents[mentionAgentKey]?.identity);
    await this.addReaction(client, event.channel, event.ts, mentionReactions.ack);

    const mentionDelivery = new SlackDeliveryManager({
      client,
      channelId: event.channel,
      threadTs,
      gatewayBaseUrl: this.config.server?.public_url,
    });
    const changeSummary = new Map<string, SlackChangeSummaryEntry>();
    const approvalRequests: ApprovalRequestData[] = [];
    let inputRequest: InputRequestData | null = null;

    await mentionDelivery.updatePhase("planning");
    const processStartMs = Date.now();

    try {
      const result = await this.processor.processImmediate({
        channel: "slack",
        sender: senderName,
        sender_id: senderId,
        sender_role: mentionRole ?? undefined,
        message: messageWithContext,
        agent,
        is_group: true,
        onProgress: (info) => {
          recordSlackChange(changeSummary, info.executionEvent);
          const phase = inferPhase(info.activity, info.phase);
          const detail = activityDetail(info.activity);
          mentionDelivery.updatePhase(phase, detail).catch(() => {});
        },
        onEvent: (eventInfo) => {
          const data = (eventInfo.data ?? {}) as Record<string, unknown>;
          if (eventInfo.type === "proposal:created") {
            const request = toApprovalRequestData(data);
            if (request) pushApprovalRequest(approvalRequests, request);
          } else if (eventInfo.type === "input.requested" && !inputRequest) {
            inputRequest = toInputRequestData(data);
          }
        },
      });

      await this.removeReaction(client, event.channel, event.ts, mentionReactions.ack);
      await this.addReaction(client, event.channel, event.ts, mentionReactions.done);
      const changedFiles = [...changeSummary.values()].sort((a, b) => a.path.localeCompare(b.path));
      await this.deliverStructuredSlackResult({
        client,
        delivery: mentionDelivery,
        channelId: event.channel,
        threadTs,
        responseText: result.response,
        result,
        agent,
        processStartMs,
        changes: changedFiles,
        approvalRequests,
        inputRequest,
      });
    } catch (err) {
      logger.error(`[slack] Error processing mention: ${err}`);
      this.stats.errors++;
      await mentionDelivery.postFailureSummary({
        error: String(err),
      });
      await this.removeReaction(client, event.channel, event.ts, mentionReactions.ack);
      await this.addReaction(client, event.channel, event.ts, mentionReactions.error);
    }
  }

  // ---------------------------------------------------------------------------
  // Interactive reply handler
  // ---------------------------------------------------------------------------

  private async handleInteractiveReply(
    channelId: string,
    userId: string | undefined,
    threadTs: string | undefined,
    value: string,
    client: any,
  ): Promise<void> {
    if (!userId) return;
    // Post the value as a visible message from the user, then process it
    const posted = await client.chat.postMessage({
      channel: channelId,
      text: value,
      thread_ts: threadTs,
    });

    await this.handleMessage({
      user: userId,
      text: value,
      channel: channelId,
      ts: posted.ts ?? `${Date.now() / 1000}`,
      thread_ts: threadTs,
    }, client);
  }

  // ---------------------------------------------------------------------------
  // BTW / Steer routing
  // ---------------------------------------------------------------------------

  /**
   * Check if the target agent is actively processing and route the message as
   * BTW (side query) or steer (mid-task context injection).
   *
   * Returns true if the message was handled (caller should return early).
   */
  private async tryBtwSteerRouting(opts: {
    text: string;
    agent: string | undefined;
    senderId: string;
    channelId: string;
    userId: string;
    threadTs: string;
    messageTs: string;
    client: any;
  }): Promise<boolean> {
    const targetAgent = opts.agent ?? resolvePrimaryAgentKey(this.config.agents, this.config.daemon) ?? Object.keys(this.config.agents)[0];
    if (!targetAgent) return false;

    const tasks = this.processor.getActiveTasks(targetAgent);
    if (tasks.length === 0) return false;

    // Match on conversation_id (senderId is the conversation key in Slack)
    const match = tasks.find((t) => t.conversation_id === opts.senderId);
    if (!match) return false;

    const isBtw = /^btw\b/i.test(opts.text);

    if (isBtw) {
      const question = opts.text.replace(/^btw\s*/i, "").trim();
      if (!question) return false;

      try {
        const result = await this.processor.handleBtw(
          targetAgent,
          match.message_id,
          question,
          "slack",
        );
        if (!result) {
          // No cached context — fall through to normal processing
          return false;
        }

        await opts.client.chat.postEphemeral({
          channel: opts.channelId,
          user: opts.userId,
          text: result.answer,
          ...(opts.threadTs ? { thread_ts: opts.threadTs } : {}),
        });

        logger.info(`[slack] BTW response sent to ${opts.userId} in ${opts.channelId}`);
        return true;
      } catch (err) {
        if (err instanceof Error && err.message.includes("Rate limit")) {
          await opts.client.chat.postEphemeral({
            channel: opts.channelId,
            user: opts.userId,
            text: "BTW rate limit exceeded. Please wait a moment.",
            ...(opts.threadTs ? { thread_ts: opts.threadTs } : {}),
          });
          return true;
        }
        logger.warn(`[slack] BTW routing failed: ${err}`);
        return false;
      }
    }

    // Steer — inject context into the active task
    try {
      await this.processor.handleSteer(
        targetAgent,
        match.message_id,
        match.conversation_id,
        {
          message: opts.text,
          priority: "normal",
          source: "slack",
          channel: "slack",
        },
      );

      await opts.client.reactions.add({
        channel: opts.channelId,
        name: "white_check_mark",
        timestamp: opts.messageTs,
      });

      logger.info(`[slack] Steer queued for ${targetAgent} in ${opts.channelId}`);
      return true;
    } catch (err) {
      logger.warn(`[slack] Steer routing failed: ${err}`);
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Thread context fetching
  // ---------------------------------------------------------------------------

  /**
   * Fetch thread history via conversations.replies and format it as context.
   * Returns a formatted string with all prior messages, or null if the thread
   * has no prior messages or the fetch fails.
   */
  private async fetchThreadContext(
    client: any,
    channel: string,
    threadTs: string,
    currentEventTs: string,
  ): Promise<string | null> {
    try {
      const channelConfig = resolveChannelConfig(channel, this.config.slack?.channels);
      const replies = await client.conversations.replies({
        channel,
        ts: threadTs,
        limit: channelConfig.history_limit ?? 50,
      });

      const messages: any[] = replies.messages ?? [];
      // Exclude the current message (the one that triggered this handler)
      const prior = messages.filter((m: any) => m.ts !== currentEventTs);
      if (prior.length === 0) return null;

      // Resolve user IDs to display names (batch-dedupe to minimize API calls)
      const uniqueUserIds = [...new Set(prior.map((m: any) => m.user).filter(Boolean))] as string[];
      const nameMap = new Map<string, string>();
      await Promise.all(
        uniqueUserIds.map(async (uid) => {
          try {
            const info = await client.users.info({ user: uid });
            nameMap.set(uid, info.user?.real_name ?? info.user?.name ?? uid);
          } catch {
            nameMap.set(uid, uid);
          }
        }),
      );

      const lines = prior.map((m: any) => {
        const name = m.user ? (nameMap.get(m.user) ?? m.user) : "Unknown";
        const isBot = m.user === this.botUserId;
        const label = isBot ? this.config.daemon.name : name;
        const text = (m.text ?? "").replace(/<@[A-Z0-9]+>/gi, "").trim();
        return `<${label}> ${text}`;
      });

      return `[Thread context]\n${lines.join("\n")}`;
    } catch (err) {
      logger.debug(`[slack] Failed to fetch thread context: ${err}`);
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Thread participation check
  // ---------------------------------------------------------------------------

  private async isBotInThread(client: any, channel: string, threadTs: string): Promise<boolean> {
    try {
      const replies = await client.conversations.replies({
        channel,
        ts: threadTs,
        limit: 50,
      });
      return (replies.messages ?? []).some((m: any) => m.user === this.botUserId);
    } catch (err) {
      logger.debug(`[slack] Failed to check thread participation: ${err}`);
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Thread output directory management
  // ---------------------------------------------------------------------------

  /** Get or create a persistent output dir for a thread, resetting its 2h TTL on each access. */
  private getOrCreateThreadOutputDir(threadTs: string): string {
    const existing = this.threadOutputDirs.get(threadTs);
    if (existing) {
      clearTimeout(existing.timer);
      existing.timer = setTimeout(() => this.evictThreadOutputDir(threadTs), SlackChannel.OUTPUT_DIR_TTL_MS);
      return existing.dir;
    }
    const dir = join(tmpdir(), `nyxhive-output-${randomUUID()}`);
    mkdirSync(dir, { recursive: true });
    const timer = setTimeout(() => this.evictThreadOutputDir(threadTs), SlackChannel.OUTPUT_DIR_TTL_MS);
    this.threadOutputDirs.set(threadTs, { dir, timer });
    return dir;
  }

  private evictThreadOutputDir(threadTs: string): void {
    const entry = this.threadOutputDirs.get(threadTs);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.threadOutputDirs.delete(threadTs);
    try { rmSync(entry.dir, { recursive: true, force: true }); } catch {}
    logger.debug(`[slack] Evicted output dir for thread ${threadTs}`);
  }

  // ---------------------------------------------------------------------------
  // Output file upload
  // ---------------------------------------------------------------------------

  /**
   * Scan outputDir for files and upload each one back to the Slack channel/thread.
   * Only files with explicitly allowed extensions are sent — hidden files, credentials,
   * executables, and anything not on the allowlist are silently skipped and deleted.
   * The dir is NOT deleted here — callers must clean up in a finally block.
   */
  private async uploadOutputFiles(client: any, channelId: string, threadTs: string | undefined, outputDir: string): Promise<void> {
    if (!existsSync(outputDir)) return;

    let entries: string[];
    try {
      entries = readdirSync(outputDir);
    } catch {
      return;
    }
    if (entries.length === 0) return;

    const MAX_OUTPUT_FILE_SIZE = 10 * 1024 * 1024; // 10MB

    for (const filename of entries) {
      // Never send hidden files
      if (filename.startsWith(".")) {
        logger.warn(`[slack] Skipping hidden output file: ${filename}`);
        continue;
      }

      // Only send files with explicitly allowed extensions
      if (!isAllowedOutputExtension(filename)) {
        logger.warn(`[slack] Blocked output file with disallowed extension: ${filename}`);
        continue;
      }

      const filePath = join(outputDir, filename);
      let stat: { size: number } | undefined;
      try {
        stat = statSync(filePath);
      } catch {
        continue;
      }

      if (stat.size > MAX_OUTPUT_FILE_SIZE) {
        logger.warn(`[slack] Skipping oversized output file ${filename} (${(stat.size / 1024 / 1024).toFixed(1)}MB)`);
        continue;
      }

      try {
        const fileBuffer = readFileSync(filePath);
        await client.files.uploadV2({
          channel_id: channelId,
          filename,
          file: fileBuffer,
          thread_ts: threadTs,
        });
        logger.info(`[slack] Uploaded output file: ${filename} (${stat.size} bytes)`);
      } catch (err) {
        logger.warn(`[slack] Failed to upload output file ${filename}: ${err}`);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Slash commands
  // ---------------------------------------------------------------------------

  private async handleSupportCommand(command: any, client: any): Promise<void> {
    const senderRole = await this.authorizeCommand(command, client);
    if (!senderRole) return;

    if (!command.text?.trim()) {
      await client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: "Usage: `/support [describe your issue]`",
      });
      return;
    }

    // Post visible message to start a thread
    const post = await client.chat.postMessage({
      channel: command.channel_id,
      text: `*Support request from <@${command.user_id}>:*\n${command.text}`,
    });

    const agent = this.channelAgents[command.channel_id] ?? undefined;
    const senderId = normalizeSenderId("thread", post.ts!);
    const delivery = new SlackDeliveryManager({
      client,
      channelId: command.channel_id,
      threadTs: post.ts!,
      gatewayBaseUrl: this.config.server?.public_url,
    });
    const changeSummary = new Map<string, SlackChangeSummaryEntry>();
    const approvalRequests: ApprovalRequestData[] = [];
    let inputRequest: InputRequestData | null = null;
    const outputDir = this.getOrCreateThreadOutputDir(post.ts!);
    const finalMessage = `${command.text}\n\n[Output Directory: ${outputDir} — if you produce any output files (e.g. modified CSVs, reports), save them here and I will send them back to the user automatically.]`;
    const processStartMs = Date.now();

    await delivery.updatePhase("planning");

    try {
      const result = await this.processor.processImmediate({
        channel: "slack",
        sender: command.user_name,
        sender_id: senderId,
        sender_role: senderRole,
        message: finalMessage,
        agent,
        onProgress: (info) => {
          recordSlackChange(changeSummary, info.executionEvent);
          const phase = inferPhase(info.activity, info.phase);
          const detail = activityDetail(info.activity);
          delivery.updatePhase(phase, detail).catch(() => {});
        },
        onEvent: (event) => {
          const data = (event.data ?? {}) as Record<string, unknown>;
          if (event.type === "proposal:created") {
            const request = toApprovalRequestData(data);
            if (request) pushApprovalRequest(approvalRequests, request);
          } else if (event.type === "input.requested" && !inputRequest) {
            inputRequest = toInputRequestData(data);
          }
        },
      });

      await this.uploadOutputFiles(client, command.channel_id, post.ts!, outputDir);
      const changedFiles = [...changeSummary.values()].sort((a, b) => a.path.localeCompare(b.path));
      await this.deliverStructuredSlackResult({
        client,
        delivery,
        channelId: command.channel_id,
        threadTs: post.ts!,
        responseText: result.response,
        result,
        agent,
        processStartMs,
        changes: changedFiles,
        approvalRequests,
        inputRequest,
      });
    } catch (err) {
      logger.error(`[slack] Error processing support command: ${err}`);
      this.stats.errors++;
      await delivery.postFailureSummary({
        error: String(err),
      });
    }
  }

  private async handleResetCommand(command: any, client: any): Promise<void> {
    if (!(await this.authorizeCommand(command, client))) return;
    const senderId = this.getCommandConversationSenderId(command);
    this.processor.clearConversation("slack", senderId);
    await client.chat.postEphemeral({
      channel: command.channel_id,
      user: command.user_id,
      text: "Conversation context cleared.",
    });
  }

  private async handleForgetCommand(command: any, client: any): Promise<void> {
    if (!(await this.authorizeCommand(command, client))) return;
    const senderId = this.getCommandConversationSenderId(command);
    const exchanges = clampInt(command.text?.trim(), 1, 1, 100);
    const result = this.processor.forgetMessages("slack", senderId, exchanges);
    await client.chat.postEphemeral({
      channel: command.channel_id,
      user: command.user_id,
      text: result.removed > 0
        ? `Removed ${result.removed} messages (${exchanges} exchange${exchanges !== 1 ? "s" : ""}).`
        : "Nothing to forget.",
    });
  }

  private async handleTrimCommand(command: any, client: any): Promise<void> {
    if (!(await this.authorizeCommand(command, client))) return;
    const senderId = this.getCommandConversationSenderId(command);
    const keep = clampInt(command.text?.trim(), 5, 1, 100);
    const result = this.processor.trimConversation("slack", senderId, keep);
    await client.chat.postEphemeral({
      channel: command.channel_id,
      user: command.user_id,
      text: result.removed > 0
        ? `Trimmed ${result.removed} messages. Keeping last ${keep}.`
        : `Already at or under ${keep} messages.`,
    });
  }

  private async handleContextCommand(command: any, client: any): Promise<void> {
    if (!(await this.authorizeCommand(command, client))) return;
    const senderId = this.getCommandConversationSenderId(command);
    const info = this.processor.getContextInfo("slack", senderId);
    await client.chat.postEphemeral({
      channel: command.channel_id,
      user: command.user_id,
      text: `Context: ${info.messageCount} message${info.messageCount !== 1 ? "s" : ""}${info.hasSummary ? " + summary" : ""}`,
    });
  }

  private async handleAgentCommand(command: any): Promise<void> {
    const role = await this.authorizeCommand(command, this.app.client);
    if (!role) return;
    const agentEntries = Object.entries(this.config.agents);
    const options = agentEntries.map(([key, a]) => ({ label: a.name, value: key }));
    const blocks = renderArgMenu("*Available agents — pick one to switch:*", options, "agent_select");
    await this.app.client.chat.postEphemeral({
      channel: command.channel_id,
      user: command.user_id,
      text: "Available agents",
      blocks,
    });
  }

  private async handlePairCommand(command: any, client: any): Promise<void> {
    if (!(await this.authorizeCommand(command, client, "operator", "Only operators can approve new Slack users."))) return;
    if (!this.pairing) {
      await client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: "Pairing is not enabled.",
      });
      return;
    }

    const code = command.text?.trim()?.toUpperCase();
    if (!code) {
      await client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: "Usage: `/pair <code>`",
      });
      return;
    }

    const result = this.pairing.approve(code, command.user_id, "viewer");
    if (result) {
      await client.chat.postMessage({
        channel: command.channel_id,
        text: `Approved ${result.sender} on ${result.channel}.`,
      });
    } else {
      await client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: "Invalid or expired code.",
      });
    }
  }

  private async handleRoleCommand(command: any, client: any): Promise<void> {
    if (!(await this.authorizeCommand(command, client, "operator", "Only operators can manage roles."))) return;
    if (!this.pairing) {
      await client.chat.postEphemeral({ channel: command.channel_id, user: command.user_id, text: "Pairing is not enabled." });
      return;
    }

    const text = command.text?.trim();

    // No args — list all approved users
    if (!text) {
      const users = this.pairing.listApproved();
      if (users.length === 0) {
        await client.chat.postEphemeral({ channel: command.channel_id, user: command.user_id, text: "No approved users." });
        return;
      }
      const lines = users.map((u) => `• <@${u.sender_id}> (${u.sender}) — \`${u.role}\``);
      await client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: `*Approved users:*\n${lines.join("\n")}\n\nUsage: \`/role @user <operator|engineer|support|viewer>\``,
      });
      return;
    }

    // Parse: /role @user <role>  or  /role <user_id> <role>
    const VALID_ROLES = ["operator", "engineer", "support", "viewer"] as const;
    const parts = text.split(/\s+/);
    if (parts.length !== 2) {
      await client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: "Usage: `/role @user <operator|engineer|support|viewer>`",
      });
      return;
    }

    // Extract user ID — accepts <@U12345> or <@U12345|name> or bare U12345
    const rawTarget = parts[0];
    const newRole = parts[1].toLowerCase() as typeof VALID_ROLES[number];

    if (!VALID_ROLES.includes(newRole)) {
      await client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: `Invalid role \`${newRole}\`. Valid: operator, engineer, support, viewer`,
      });
      return;
    }

    const mentionMatch = rawTarget.match(/^<@([A-Z0-9]+)(?:\|[^>]*)?>$/);
    const targetId = mentionMatch ? mentionMatch[1] : rawTarget;

    if (!targetId.match(/^[A-Z0-9]+$/)) {
      await client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: `Could not parse user: \`${rawTarget}\``,
      });
      return;
    }

    const updated = this.pairing.setRole("slack", targetId, newRole);
    if (!updated) {
      await client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: `User <@${targetId}> is not in the approved list.`,
      });
      return;
    }

    await client.chat.postEphemeral({
      channel: command.channel_id,
      user: command.user_id,
      text: `Updated <@${targetId}> to \`${newRole}\`.`,
    });
    logger.info(`[slack] /role: ${command.user_id} set ${targetId} to ${newRole}`);
  }

  private async handleModelCommand(command: any): Promise<void> {
    const role = await this.authorizeCommand(command, this.app.client);
    if (!role) return;
    const text = command.text?.trim();
    const senderId: string = command.user_id;

    if (!text) {
      const lines = Object.entries(this.config.agents).map(([key, a]) => {
        const override = this.processor.getModelOverride(senderId, key);
        const current = override ?? a.model;
        const suffix = override ? " (override)" : "";
        return `- ${a.name}: \`${current}\`${suffix}`;
      });
      const aliases = "Aliases: haiku, sonnet, opus, claude, anthropic, flash, pro, gpt, gpt 5.5, gpt 5.4 pro, gpt 5 mini, gpt 5 nano, codex";
      await this.app.client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: `*Current models:*\n${lines.join("\n")}\n\n${aliases}\n\nUsage: \`/model agent:model\` or \`/model reset\``,
      });
      return;
    }

    if (text === "reset") {
      this.processor.clearAllModelOverrides(senderId);
      await this.app.client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: "All model overrides cleared.",
      });
      return;
    }

    const defaultAgent = resolvePrimaryAgentKey(this.config.agents, this.config.daemon) ?? Object.keys(this.config.agents)[0];
    let agentKey = defaultAgent;
    let model = text;

    if (model.includes(":")) {
      const [a, m] = model.split(":", 2);
      agentKey = a;
      model = m;
    }

    if (!this.config.agents[agentKey]) {
      await this.app.client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: `Unknown agent: ${agentKey}`,
      });
      return;
    }

    if (model === "default") {
      this.processor.clearModelOverride(senderId, agentKey);
      const base = this.config.agents[agentKey].model;
      await this.app.client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: `${this.config.agents[agentKey].name} reset to \`${base}\``,
      });
      return;
    }

    const resolved = resolveModelAlias(model);
    const modelWarning = this.processor.setModelOverride(senderId, agentKey, resolved);
    let replyText: string;
    if (modelWarning) {
      replyText = `⚠️ ${modelWarning}`;
    } else {
      const providerOverride = this.processor.getModelOverrideProvider(senderId, agentKey);
      const providerNote = providerOverride && providerOverride !== this.config.agents[agentKey].provider
        ? ` (${providerOverride})` : "";
      replyText = `${this.config.agents[agentKey].name} set to \`${resolved}\`${providerNote}`;
    }
    await this.app.client.chat.postEphemeral({
      channel: command.channel_id,
      user: command.user_id,
      text: replyText,
    });
  }

  private async handleUsageCommand(command: any, client: any): Promise<void> {
    if (!(await this.authorizeCommand(command, client, "operator", "Only operators can view queue stats."))) return;
    const stats = this.queue.getQueueStats();
    await client.chat.postEphemeral({
      channel: command.channel_id,
      user: command.user_id,
      text: `Queue stats:\nPending: ${stats.pending}\nProcessing: ${stats.processing}\nSuspended: ${stats.suspended}\nCompleted: ${stats.completed}\nFailed: ${stats.failed}\nDead letters: ${stats.dead_letter}`,
    });
  }

  private async handleCrawlCommand(command: any, client: any): Promise<void> {
    if (!(await this.authorizeCommand(command, client, "operator", "Only operators can run crawls from Slack."))) return;
    const parsed = parseCrawlCommandText(`/crawl ${command.text ?? ""}`, "/crawl");
    if (!parsed.ok) {
      await client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: parsed.error,
      });
      return;
    }

    try {
      const result = await runCrawlCommand({
        ...parsed.input,
        origin: "channel:slack",
      }, {
        service: this.crawlService,
        sources: this.crawlSources,
        ingest: this.crawlIngest,
      });
      await client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: formatCrawlCommandResult(result),
      });
    } catch (err) {
      await client.chat.postEphemeral({
        channel: command.channel_id,
        user: command.user_id,
        text: `crawl failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  private async handleCancelCommand(command: any, client: any): Promise<void> {
    if (!(await this.authorizeCommand(command, client))) return;
    const senderId = this.getCommandConversationSenderId(command);
    const result = this.processor.cancelTask("slack", senderId);
    await client.chat.postEphemeral({
      channel: command.channel_id,
      user: command.user_id,
      text: result.cancelled
        ? `Cancelled ${result.agent} task (was running ${result.elapsed}s).`
        : "No active task to cancel.",
    });
  }

  private getCommandConversationSenderId(command: any): string {
    const threadTs = typeof command.thread_ts === "string" ? command.thread_ts.trim() : "";
    if (threadTs) {
      return normalizeSenderId("thread", threadTs);
    }

    const userId = typeof command.user_id === "string" ? command.user_id : "";
    const channelId = typeof command.channel_id === "string" ? command.channel_id : "";
    if (!channelId || channelId.startsWith("D")) {
      return userId;
    }
    return normalizeSenderId(userId, channelId);
  }

  // ---------------------------------------------------------------------------
  // Reaction handler
  // ---------------------------------------------------------------------------

  private async handleReaction(event: any, client: any): Promise<void> {
    // Thumbs up/down feedback on agent responses
    if ((event.reaction === "+1" || event.reaction === "thumbsup") && this.feedbackStore) {
      this.feedbackStore.addFeedback({
        messageId: `slack:${event.item.channel}:${event.item.ts}`,
        channel: "slack",
        senderId: event.user,
        rating: 1,
      });
      logger.info(`[slack] Positive feedback from ${event.user} on ${event.item.ts}`);
      return;
    }

    if ((event.reaction === "-1" || event.reaction === "thumbsdown") && this.feedbackStore) {
      this.feedbackStore.addFeedback({
        messageId: `slack:${event.item.channel}:${event.item.ts}`,
        channel: "slack",
        senderId: event.user,
        rating: -1,
      });
      logger.info(`[slack] Negative feedback from ${event.user} on ${event.item.ts}`);
      return;
    }

    if (event.reaction === "white_check_mark") {
      await client.chat.postMessage({
        channel: event.item.channel,
        text: `Marked as resolved by <@${event.user}>.`,
        thread_ts: event.item.ts,
      });
      await client.reactions.add({
        channel: event.item.channel,
        timestamp: event.item.ts,
        name: "white_check_mark",
      }).catch((_err: unknown) => {
        logger.debug(`[slack] Failed to add reaction: ${_err}`);
      });
    }

    if (event.reaction === "sos" || event.reaction === "rotating_light") {
      await client.chat.postMessage({
        channel: event.item.channel,
        text: `Escalation requested by <@${event.user}>. A human will review this thread.`,
        thread_ts: event.item.ts,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Reaction helpers
  // ---------------------------------------------------------------------------

  private async addReaction(client: any, channel: string, ts: string, name: string): Promise<void> {
    try {
      await client.reactions.add({ channel, timestamp: ts, name });
    } catch (err) {
      logger.debug(`[slack] Failed to add :${name}: reaction: ${err}`);
    }
  }

  private async removeReaction(client: any, channel: string, ts: string, name: string): Promise<void> {
    try {
      await client.reactions.remove({ channel, timestamp: ts, name });
    } catch (err) {
      logger.debug(`[slack] Failed to remove :${name}: reaction: ${err}`);
    }
  }
}

/**
 * Check if a filename's extension is safe to send back as a Slack output file.
 * Allowlist only — anything not listed is blocked.
 */
function isAllowedOutputExtension(filename: string): boolean {
  const ext = filename.includes(".") ? filename.split(".").pop()!.toLowerCase() : "";
  const allowed = new Set([
    // Tabular / data
    "csv", "tsv", "xlsx", "xls", "ods",
    // Text / docs
    "txt", "md", "rst", "html", "htm",
    // Structured data
    "json", "jsonl", "xml", "yaml", "yml", "toml",
    // Code output (read-only artifacts, not scripts)
    "sql", "log",
    // Images (generated charts etc.)
    "png", "jpg", "jpeg", "gif", "webp", "svg", "pdf",
  ]);
  return allowed.has(ext);
}

/** Check if a MIME type represents a text-based file we can inline. */
function isTextMimetype(mime: string): boolean {
  if (mime.startsWith("text/")) return true;
  const textTypes = new Set([
    "application/json",
    "application/xml",
    "application/csv",
    "application/javascript",
    "application/typescript",
    "application/x-yaml",
    "application/yaml",
    "application/sql",
    "application/x-sh",
    "application/toml",
  ]);
  return textTypes.has(mime);
}

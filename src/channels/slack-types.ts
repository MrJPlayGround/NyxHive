import type { NyxHiveConfig } from "../types.js";
import type { QueueDB } from "../queue/db.js";
import type { QueueProcessor } from "../queue/processor.js";
import type { PairingStore } from "../pairing/pairing.js";
import type { CrawlIngestBridge, CrawlService, CrawlSourceStore } from "../crawl/index.js";
import type { AuditLog } from "../utils/audit.js";
import type { ProposalStore } from "../proposals/store.js";
import type { FeedbackStore } from "../memory/feedback.js";
import type { PairingRole } from "../pairing/pairing.js";
import type { PublicProcessorAPI } from "../framework/types.js";

export interface SlackIncomingMessage {
  text: string;
  userId: string;
  userName: string;
  channelId: string;
  threadTs?: string;
  messageTs: string;
  isThread: boolean;
  isDM: boolean;
}

export interface SlackChannelOpts {
  botToken: string;
  appToken: string;
  config: NyxHiveConfig;
  queue: QueueDB;
  processor: QueueProcessor;
  pairing?: PairingStore;
  auditLog?: AuditLog;
  crawlService?: CrawlService;
  crawlSources?: CrawlSourceStore;
  crawlIngest?: CrawlIngestBridge;
  interactive_replies?: boolean;
  proposalStore?: ProposalStore;
  feedbackStore?: FeedbackStore;
  slackSurfaces?: SlackSurfaceRegistration[];
}

export interface SlackAccountConfig {
  bot_token_env: string;
  app_token_env: string;
  channel_agents?: Record<string, string>;
  monitor_channels?: string[];
}

export type SlackSurfaceScope = "any" | "dm" | "channel";

export interface SlackSurfaceResult {
  handled: boolean;
  text?: string;
  ephemeral?: boolean;
  threadTs?: string;
}

export interface SlackSurfaceContext {
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
  processor: PublicProcessorAPI;
  config: NyxHiveConfig;
  queue: QueueDB;
  client: any;
}

export interface SlackMessageSurface {
  name: string;
  description: string;
  pattern: RegExp | string;
  scope?: SlackSurfaceScope;
  mentionOnly?: boolean;
  minimumRole?: PairingRole;
  handler: (ctx: SlackSurfaceContext) => Promise<SlackSurfaceResult>;
}

export interface SlackSlashCommandSurface {
  command: string;
  description: string;
  minimumRole?: PairingRole;
  handler: (ctx: SlackSurfaceContext) => Promise<SlackSurfaceResult>;
}

export interface SlackSurfaceRegistration {
  owner?: string;
  messages?: SlackMessageSurface[];
  commands?: SlackSlashCommandSurface[];
}

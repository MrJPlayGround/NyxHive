import type { Channel, ChannelStats } from "./types.js";
import type { NyxHiveConfig } from "../types.js";
import type { QueueDB } from "../queue/db.js";
import type { QueueProcessor } from "../queue/processor.js";
import type { WebhookSource } from "./webhook-sources/types.js";
import { GitHubSource } from "./webhook-sources/github.js";
import { logger } from "../utils/logger.js";

interface WebhookChannelOpts {
  config: NyxHiveConfig;
  queue: QueueDB;
  processor: QueueProcessor;
}

// Registry of all available webhook sources
const SOURCE_REGISTRY: Record<string, WebhookSource> = {
  github: new GitHubSource(),
};

// The signature header name per source
const SIGNATURE_HEADERS: Record<string, string> = {
  github: "x-hub-signature-256",
};

export interface HandleRequestResult {
  status: number;
  body: string;
}

export class WebhookChannel implements Channel {
  name = "webhook";
  private config: NyxHiveConfig;
  private queue: QueueDB;
  private connected = false;
  private stats: ChannelStats = { messagesReceived: 0, messagesSent: 0, errors: 0 };

  constructor(opts: WebhookChannelOpts) {
    this.config = opts.config;
    this.queue = opts.queue;
  }

  async start(): Promise<void> {
    this.connected = true;
    logger.info("[webhook] Channel started");
  }

  async stop(): Promise<void> {
    this.connected = false;
    logger.info("[webhook] Channel stopped");
  }

  isConnected(): boolean {
    return this.connected;
  }

  getStats(): ChannelStats {
    return { ...this.stats };
  }

  hasSource(name: string): boolean {
    const sources = this.config.webhook?.sources;
    return !!(sources && name in sources && name in SOURCE_REGISTRY);
  }

  async handleRequest(
    sourceName: string,
    headers: Record<string, string>,
    rawBody: string,
  ): Promise<HandleRequestResult> {
    const source = SOURCE_REGISTRY[sourceName];
    const sourceConfig = this.config.webhook?.sources?.[sourceName];

    if (!source || !sourceConfig) {
      return { status: 404, body: "Unknown source" };
    }

    const secret = process.env[sourceConfig.secret_env];
    if (!secret) {
      logger.error(`[webhook] Secret env var '${sourceConfig.secret_env}' not set for source '${sourceName}'`);
      return { status: 500, body: "Server configuration error" };
    }

    const sigHeader = SIGNATURE_HEADERS[sourceName] ?? "x-hub-signature-256";
    const signature = headers[sigHeader] ?? "";

    if (!source.verifySignature(rawBody, signature, secret)) {
      logger.warn(`[webhook] Invalid signature for source '${sourceName}'`);
      this.stats.errors++;
      return { status: 401, body: "Invalid signature" };
    }

    const event = source.parseEvent(headers, rawBody);
    if (!event) {
      return { status: 200, body: "Event ignored (unparseable)" };
    }

    const action = source.mapToAction(event, sourceConfig);
    if (!action) {
      return { status: 200, body: "Event acknowledged (no action)" };
    }

    // Dedup: check if any recent message has the same content (first 500 chars).
    // This catches duplicate deliveries even across different delivery IDs, which is
    // more robust than keying on delivery ID alone.
    const existing = this.queue.findRecentDuplicateAnyChannel(action.message, 60_000);
    if (existing) {
      logger.debug(`[webhook] Duplicate event from ${sourceName} (matches ${existing.message_id})`);
      return { status: 200, body: "Duplicate event ignored" };
    }

    // Rate limit check — keyed on source name, not delivery ID, so bursts from the same source are throttled.
    const allowed = this.queue.checkSenderRateLimit(`webhook:${sourceName}`, 30);
    if (!allowed) {
      logger.warn(`[webhook] Rate limit hit for sender '${action.senderId}'`);
      return { status: 429, body: "Rate limited" };
    }

    this.queue.enqueueMessage({
      channel: action.channel,
      sender: action.sender,
      sender_id: action.senderId,
      message: action.message,
      agent: action.agent,
    });

    this.stats.messagesReceived++;
    logger.info(`[webhook] Enqueued ${event.type} from '${sourceName}'`);

    return { status: 200, body: "Event processed" };
  }
}

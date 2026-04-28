/**
 * Notification batcher — coalesces non-critical notifications into periodic digests.
 *
 * Priority tiers:
 * - critical: delivered immediately (0ms)
 * - medium:   flushed every hour
 * - low:      flushed every 4 hours
 */

import type { Channel } from "../channels/types.js";
import type { Proposal } from "../proposals/store.js";
import { formatProposalPlainText } from "../proposals/notifications.js";
import { logger } from "../utils/logger.js";

export type NotificationPriority = "critical" | "medium" | "low";

export interface QueuedNotification {
  type: string;
  priority: NotificationPriority;
  content: string;
  proposal?: Proposal;
  replyToId?: string;
  queuedAt: number;
}

export interface NotificationTarget {
  channel: string;
  recipient: string;
}

interface FlushConfig {
  critical: number;
  medium: number;
  low: number;
}

const DEFAULT_FLUSH_MS: FlushConfig = {
  critical: 0,
  medium: 60 * 60 * 1000,       // 1 hour
  low: 4 * 60 * 60 * 1000,      // 4 hours
};

type BufferKey = string; // `${channelName}:${recipientId}`

function bufferKey(target: NotificationTarget): BufferKey {
  return `${target.channel}:${target.recipient}`;
}

export class NotificationBatcher {
  private buffers = new Map<BufferKey, QueuedNotification[]>();
  private flushTimers = new Map<string, Timer>();
  private channels: Channel[] = [];
  private flushIntervals: FlushConfig;

  constructor(flushIntervals?: Partial<FlushConfig>) {
    this.flushIntervals = { ...DEFAULT_FLUSH_MS, ...flushIntervals };
  }

  setChannels(channels: Channel[]): void {
    this.channels = channels;
  }

  /**
   * Queue a notification. Critical notifications are sent immediately.
   * Medium/low are buffered and flushed on a timer.
   */
  async queue(target: NotificationTarget, notification: QueuedNotification): Promise<void> {
    if (notification.priority === "critical") {
      await this.sendImmediate(target, notification);
      return;
    }

    const key = bufferKey(target);
    const buffer = this.buffers.get(key) ?? [];
    buffer.push(notification);
    this.buffers.set(key, buffer);

    // Start flush timer for this priority tier if not already running
    const timerKey = `${key}:${notification.priority}`;
    if (!this.flushTimers.has(timerKey)) {
      const interval = this.flushIntervals[notification.priority];
      const timer = setTimeout(() => {
        this.flushTimers.delete(timerKey);
        this.flushBuffer(target, notification.priority).catch((err) => {
          logger.warn(`[batcher] Flush failed for ${key}: ${err}`);
        });
      }, interval);
      this.flushTimers.set(timerKey, timer);
    }
  }

  /**
   * Queue a proposal notification with automatic priority mapping.
   */
  async queueProposal(target: NotificationTarget, proposal: Proposal): Promise<void> {
    const priority = proposalPriority(proposal);

    // For critical proposals, try rich formatting first
    if (priority === "critical") {
      const ch = this.findChannel(target.channel);
      if (ch?.sendProposalNotification) {
        try {
          await ch.sendProposalNotification(target.recipient, proposal);
          return;
        } catch (err) {
          logger.warn(`[batcher] Rich proposal notification failed, falling back to text: ${err}`);
        }
      }
    }

    await this.queue(target, {
      type: "proposal",
      priority,
      content: formatProposalPlainText(proposal),
      proposal,
      queuedAt: Date.now(),
    });
  }

  private async sendImmediate(target: NotificationTarget, notification: QueuedNotification): Promise<void> {
    const ch = this.findChannel(target.channel);
    if (!ch?.sendOutbound) {
      logger.debug(`[batcher] No sendOutbound for channel "${target.channel}"`);
      return;
    }
    try {
      await ch.sendOutbound(target.recipient, notification.content, undefined, notification.replyToId);
    } catch (err) {
      logger.warn(`[batcher] Immediate send failed to ${target.channel}:${target.recipient}: ${err}`);
    }
  }

  private async flushBuffer(target: NotificationTarget, priority: NotificationPriority): Promise<void> {
    const key = bufferKey(target);
    const buffer = this.buffers.get(key);
    if (!buffer || buffer.length === 0) return;

    // Extract items matching this priority
    const toFlush = buffer.filter((n) => n.priority === priority);
    const remaining = buffer.filter((n) => n.priority !== priority);

    if (remaining.length > 0) {
      this.buffers.set(key, remaining);
    } else {
      this.buffers.delete(key);
    }

    if (toFlush.length === 0) return;

    const ch = this.findChannel(target.channel);
    if (!ch?.sendOutbound) return;

    const digest = this.formatDigest(toFlush);
    try {
      await ch.sendOutbound(target.recipient, digest);
      logger.info(`[batcher] Flushed ${toFlush.length} ${priority} notifications to ${key}`);
    } catch (err) {
      logger.warn(`[batcher] Digest delivery failed to ${key}: ${err}`);
    }
  }

  private formatDigest(items: QueuedNotification[]): string {
    if (items.length === 1) return items[0].content;

    // Group by type
    const grouped = new Map<string, QueuedNotification[]>();
    for (const item of items) {
      const list = grouped.get(item.type) ?? [];
      list.push(item);
      grouped.set(item.type, list);
    }

    const sections: string[] = [`Notification digest (${items.length} items):\n`];

    for (const [type, group] of grouped) {
      sections.push(`--- ${type.toUpperCase()} (${group.length}) ---`);
      for (const item of group) {
        // Use first line as summary, truncate long content
        const firstLine = item.content.split("\n")[0].slice(0, 200);
        sections.push(`  ${firstLine}`);
      }
      sections.push("");
    }

    return sections.join("\n");
  }

  /**
   * Flush all pending notifications. Call on shutdown.
   */
  async flushAll(): Promise<void> {
    // Clear all timers
    for (const timer of this.flushTimers.values()) {
      clearTimeout(timer);
    }
    this.flushTimers.clear();

    // Flush all buffers
    for (const [key, buffer] of this.buffers) {
      if (buffer.length === 0) continue;
      const colonIdx = key.indexOf(":");
      const target: NotificationTarget = {
        channel: key.substring(0, colonIdx),
        recipient: key.substring(colonIdx + 1),
      };
      const ch = this.findChannel(target.channel);
      if (!ch?.sendOutbound) continue;
      const digest = this.formatDigest(buffer);
      try {
        await ch.sendOutbound(target.recipient, digest);
      } catch (err) {
        logger.warn(`[batcher] Shutdown flush failed for ${key}: ${err}`);
      }
    }
    this.buffers.clear();
  }

  destroy(): void {
    for (const timer of this.flushTimers.values()) {
      clearTimeout(timer);
    }
    this.flushTimers.clear();
    this.buffers.clear();
  }

  /** Current buffer size for testing/monitoring */
  get pendingCount(): number {
    let total = 0;
    for (const buffer of this.buffers.values()) {
      total += buffer.length;
    }
    return total;
  }

  private findChannel(name: string): Channel | undefined {
    return this.channels.find((c) => c.name.toLowerCase() === name.toLowerCase());
  }
}

/** Map proposal priority to notification priority */
function proposalPriority(proposal: Proposal): NotificationPriority {
  switch (proposal.priority) {
    case "high": return "critical";
    case "medium": return "medium";
    default: return "low";
  }
}

/** Map notification type to default priority */
export function defaultPriorityForType(type: string): NotificationPriority {
  switch (type) {
    case "alerts": return "critical";
    case "proposals": return "medium";
    case "reports": return "low";
    case "activity": return "low";
    default: return "medium";
  }
}

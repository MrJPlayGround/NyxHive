import type { Channel, ChannelStats } from "../types.js";
import type { Proposal } from "../../proposals/store.js";
import { SlackChannel } from "../slack.js";
import type { SlackChannelOpts } from "../slack-types.js";
import { logger } from "../../utils/logger.js";

export class SlackAccountManager implements Channel {
  name = "slack";
  private accounts: SlackChannel[] = [];

  constructor(accountConfigs: SlackChannelOpts[]) {
    for (const config of accountConfigs) {
      this.accounts.push(new SlackChannel(config));
    }
  }

  async start(): Promise<void> {
    await Promise.all(this.accounts.map((a) => a.start()));
  }

  async stop(): Promise<void> {
    await Promise.all(this.accounts.map((a) => a.stop()));
  }

  isConnected(): boolean {
    return this.accounts.some((a) => a.isConnected());
  }

  getStats(): ChannelStats {
    const stats: ChannelStats = { messagesReceived: 0, messagesSent: 0, errors: 0 };
    for (const a of this.accounts) {
      const s = a.getStats();
      stats.messagesReceived += s.messagesReceived;
      stats.messagesSent += s.messagesSent;
      stats.errors += s.errors;
    }
    return stats;
  }

  async sendOutbound(recipientId: string, message: string): Promise<void> {
    // Try each account — the one that owns the channel will succeed
    for (const account of this.accounts) {
      try {
        await account.sendOutbound(recipientId, message);
        return;
      } catch {
      }
    }
    logger.warn(`[slack] sendOutbound: no account could deliver to ${recipientId}`);
  }

  async sendProposalNotification(recipientId: string, proposal: Proposal): Promise<void> {
    for (const account of this.accounts) {
      try {
        await account.sendProposalNotification(recipientId, proposal);
        return;
      } catch {
      }
    }
    logger.warn(`[slack] sendProposalNotification: no account could deliver to ${recipientId}`);
  }
}

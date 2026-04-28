import type { ChannelFactory } from "../types.js";

export const webhookChannel: ChannelFactory = {
  name: "webhook",
  async create(deps) {
    if (!deps.config.webhook?.enabled) throw new Error("Webhook not configured");
    const { WebhookChannel } = await import("../../channels/webhook.js");
    return new WebhookChannel({ config: deps.config, queue: deps.queue, processor: deps.processor });
  },
};

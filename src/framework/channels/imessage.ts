import type { ChannelFactory } from "../types.js";

export const imessageChannel: ChannelFactory = {
  name: "imessage",
  async create(deps) {
    if (!deps.config.imessage) throw new Error("iMessage not configured");
    const { IMessageChannel } = await import("../../channels/imessage.js");
    return new IMessageChannel({
      config: deps.config,
      queue: deps.queue,
      processor: deps.processor,
      pairing: deps.stores.pairing,
      crawlService: deps.stores.crawl,
      crawlSources: undefined,
      crawlIngest: undefined,
    });
  },
};

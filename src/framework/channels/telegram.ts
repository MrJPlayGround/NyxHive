import { resolveEnvKey } from "../../config.js";
import type { ChannelFactory } from "../types.js";

export const telegramChannel: ChannelFactory = {
  name: "telegram",
  async create(deps) {
    if (!deps.config.telegram) throw new Error("Telegram not configured");
    const botToken = resolveEnvKey(deps.config.telegram.bot_token_env);
    const { TelegramChannel } = await import("../../channels/telegram.js");
    return new TelegramChannel({
      botToken,
      config: deps.config,
      queue: deps.queue,
      processor: deps.processor,
      pairing: deps.stores.pairing,
      crawlService: deps.stores.crawl,
      crawlSources: undefined,
      crawlIngest: undefined,
      tradingDb: deps.stores.trading,
      runs: deps.stores.runs,
    });
  },
};

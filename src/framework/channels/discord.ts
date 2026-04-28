import { resolveEnvKey } from "../../config.js";
import type { ChannelFactory } from "../types.js";

export const discordChannel: ChannelFactory = {
  name: "discord",
  async create(deps) {
    if (!deps.config.discord) throw new Error("Discord not configured");
    const botToken = resolveEnvKey(deps.config.discord.bot_token_env);
    const { DiscordChannel } = await import("../../channels/discord.js");
    return new DiscordChannel({
      botToken,
      config: deps.config,
      queue: deps.queue,
      processor: deps.processor,
      pairing: deps.stores.pairing,
      crawlService: deps.stores.crawl,
      crawlSources: undefined,
      crawlIngest: undefined,
      runs: deps.stores.runs,
    });
  },
};

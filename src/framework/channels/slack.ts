import { resolveEnvKey } from "../../config.js";
import type { ChannelFactory } from "../types.js";

export const slackChannel: ChannelFactory = {
  name: "slack",
  async create(deps) {
    if (!deps.config.slack) throw new Error("Slack not configured");

    const slackCfg = deps.config.slack;

    // Multi-account mode: if `accounts` is defined, create one SlackChannel per account
    if (slackCfg.accounts && Object.keys(slackCfg.accounts).length > 0) {
      const { SlackAccountManager } = await import("../../channels/slack/account-manager.js");
      const { SlackChannel } = await import("../../channels/slack.js");

      const accountConfigs = Object.entries(slackCfg.accounts).map(([_name, acc]) => ({
        botToken: resolveEnvKey(acc.bot_token_env),
        appToken: resolveEnvKey(acc.app_token_env),
        config: {
          ...deps.config,
          slack: {
            ...slackCfg,
            bot_token_env: acc.bot_token_env,
            app_token_env: acc.app_token_env,
            channel_agents: acc.channel_agents ?? slackCfg.channel_agents,
            monitor_channels: acc.monitor_channels ?? slackCfg.monitor_channels,
          },
        },
        queue: deps.queue,
        processor: deps.processor,
        pairing: deps.stores.pairing,
        auditLog: deps.stores.audit,
        crawlService: deps.stores.crawl,
        crawlSources: undefined,
        crawlIngest: undefined,
        proposalStore: deps.stores.proposals,
        feedbackStore: deps.stores.feedback,
        slackSurfaces: deps.slackSurfaces,
      }));

      return new SlackAccountManager(accountConfigs);
    }

    // Single-account mode (backward compat)
    const botToken = resolveEnvKey(slackCfg.bot_token_env);
    const appToken = resolveEnvKey(slackCfg.app_token_env);
    const { SlackChannel } = await import("../../channels/slack.js");
    return new SlackChannel({
      botToken,
      appToken,
      config: deps.config,
      queue: deps.queue,
      processor: deps.processor,
      pairing: deps.stores.pairing,
      auditLog: deps.stores.audit,
      crawlService: deps.stores.crawl,
      crawlSources: undefined,
      crawlIngest: undefined,
      proposalStore: deps.stores.proposals,
      feedbackStore: deps.stores.feedback,
      slackSurfaces: deps.slackSurfaces,
    });
  },
};

export interface SlackIdentityConfig {
  slack_username?: string;
  slack_emoji?: string;
  slack_icon_url?: string;
}

export interface SlackIdentityPayload {
  username?: string;
  icon_emoji?: string;
  icon_url?: string;
}

export function resolveSlackIdentity(config: SlackIdentityConfig | undefined): SlackIdentityPayload {
  if (!config) return {};
  const result: SlackIdentityPayload = {};
  if (config.slack_username) result.username = config.slack_username;
  if (config.slack_icon_url) {
    result.icon_url = config.slack_icon_url;
  } else if (config.slack_emoji) {
    result.icon_emoji = config.slack_emoji;
  }
  return result;
}

export interface ReactionConfig {
  ack_reaction?: string;
  done_reaction?: string;
  error_reaction?: string;
  typing_reaction?: string;
}

export interface ResolvedReactions {
  ack: string;
  done: string;
  error: string;
  typing?: string;
}

function stripColons(emoji: string): string {
  return emoji.replace(/^:|:$/g, "");
}

export function resolveReactions(config: ReactionConfig | undefined): ResolvedReactions {
  return {
    ack: stripColons(config?.ack_reaction ?? "eyes"),
    done: stripColons(config?.done_reaction ?? "white_check_mark"),
    error: stripColons(config?.error_reaction ?? "x"),
    typing: config?.typing_reaction ? stripColons(config.typing_reaction) : undefined,
  };
}

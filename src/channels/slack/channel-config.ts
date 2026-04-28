export interface PerChannelConfig {
  agent?: string;
  require_mention?: boolean;
  system_prompt?: string;
  allowed_users?: string[];
  tools?: string[];
  allow_bots?: boolean;
  history_limit?: number;
  dm_history_limit?: number;
}

export function resolveChannelConfig(channelId: string, channels: Record<string, PerChannelConfig> | undefined): PerChannelConfig {
  if (!channels || !channels[channelId]) return { require_mention: false };
  return { require_mention: false, ...channels[channelId] };
}

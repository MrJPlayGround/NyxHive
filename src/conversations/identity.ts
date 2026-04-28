const LOCAL_IDENTITY_CHANNELS = new Set([
  "api",
  "background",
  "cli",
  "gateway",
  "relay",
  "scheduler",
  "system",
]);

export interface ConversationIdentityInput {
  channel: string;
  senderId?: string | null;
  sender?: string | null;
  allowLocalFallback?: boolean;
}

export interface ConversationIdentity {
  channel: string;
  identity: string;
  conversationKey: string;
  usedFallback: boolean;
}

function normalizePart(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function canUseLocalConversationFallback(channel: string): boolean {
  return LOCAL_IDENTITY_CHANNELS.has(channel.trim().toLowerCase());
}

export function resolveConversationIdentity(input: ConversationIdentityInput): ConversationIdentity {
  const channel = normalizePart(input.channel);
  if (!channel) {
    throw new Error("Conversation channel is required");
  }

  const senderId = normalizePart(input.senderId);
  const sender = normalizePart(input.sender);
  const identity = senderId ?? sender;
  if (identity) {
    return {
      channel,
      identity,
      conversationKey: `${channel}:${identity}`,
      usedFallback: false,
    };
  }

  if (input.allowLocalFallback !== false && canUseLocalConversationFallback(channel)) {
    return {
      channel,
      identity: "local",
      conversationKey: `${channel}:local`,
      usedFallback: true,
    };
  }

  throw new Error(`Missing sender identity for multi-user channel '${channel}'`);
}

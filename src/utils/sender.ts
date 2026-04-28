/**
 * Normalize sender IDs to a canonical format for cross-channel tracking.
 * Format: {platform_user_id}[:{scope_id}]
 *
 * The channel name is NOT included in the sender_id because it's stored
 * separately in the queue. This just normalizes the user+scope part.
 */
export function normalizeSenderId(
  platformUserId: string,
  scopeId?: string,
): string {
  if (!scopeId || scopeId === platformUserId) {
    return platformUserId;
  }
  return `${platformUserId}:${scopeId}`;
}

/**
 * Get the platform user ID from a normalized sender ID.
 */
export function extractUserId(senderId: string): string {
  return senderId.split(":")[0];
}

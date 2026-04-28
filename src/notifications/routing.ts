import type { NyxHiveConfig, NotificationTargetConfig } from "../types.js";

export type NotificationType = "proposals" | "alerts" | "reports" | "activity" | "trades";

export interface NotificationTarget {
  channel: string;
  recipient: string;
}

/**
 * Resolve where to send a notification of the given type.
 * Returns an array of targets — supports both single and multi-channel configs.
 * Priority: type-specific config > daemon.owner_channel/owner_id > empty array.
 */
export function resolveNotificationTargets(
  config: NyxHiveConfig,
  type: NotificationType,
): NotificationTarget[] {
  const typed = config.notifications?.[type];
  if (typed) {
    const entries = Array.isArray(typed) ? typed : [typed];
    const targets: NotificationTarget[] = [];
    for (const entry of entries) {
      if (entry.channel && entry.recipient) {
        targets.push({ channel: entry.channel, recipient: entry.recipient });
      }
    }
    if (targets.length > 0) return targets;
  }

  const ownerChannel = config.daemon?.owner_channel;
  const ownerId = config.daemon?.owner_id;
  if (ownerChannel && ownerId) {
    return [{ channel: ownerChannel, recipient: ownerId }];
  }

  return [];
}

/**
 * Backward-compatible single-target resolver.
 * Returns the first target or null. Use resolveNotificationTargets for multi-channel.
 */
export function resolveNotificationTarget(
  config: NyxHiveConfig,
  type: NotificationType,
): NotificationTarget | null {
  const targets = resolveNotificationTargets(config, type);
  return targets[0] ?? null;
}

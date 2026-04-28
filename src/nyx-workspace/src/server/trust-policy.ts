export type TrustIndicator =
  | 'current-info-used'
  | 'memory-used'
  | 'tool-failed'
  | 'scheduled-task-created'

export type TrustBoundary = 'operator' | 'paired_dm' | 'public_safe'

export type TrustSurface =
  | 'workspace'
  | 'telegram_dm'
  | 'discord_dm'
  | 'discord_public'
  | 'slack_dm'
  | 'slack_public'
  | 'api'

export type WorkspaceActionIntent =
  | 'chat-answer'
  | 'live-info'
  | 'remember-this'
  | 'create-reminder'
  | 'file-write'
  | 'external-send'

export type TrustDecision = {
  allowed: boolean
  reason: string
  requiresExplicitUserIntent: boolean
  indicator?: TrustIndicator
  boundary: TrustBoundary
}

export function evaluateWorkspaceActionTrust(input: {
  intent: WorkspaceActionIntent
  explicitUserIntent: boolean
  toolAvailable?: boolean
  toolSucceeded?: boolean
  surface?: TrustSurface
  pairedSurface?: boolean
}): TrustDecision {
  const boundary: TrustBoundary =
    input.surface === 'workspace' || input.surface === 'api'
      ? 'operator'
      : input.surface === 'discord_public' || input.surface === 'slack_public'
        ? 'public_safe'
        : input.pairedSurface
          ? 'paired_dm'
          : 'operator'

  if (input.intent === 'live-info') {
    if (input.toolAvailable === false) {
      return {
        allowed: false,
        reason: 'Live/current information requires an available current-info tool.',
        requiresExplicitUserIntent: false,
        indicator: 'tool-failed',
        boundary,
      }
    }
    if (input.toolSucceeded === false) {
      return {
        allowed: false,
        reason: 'Live/current information tool failed; do not invent current facts.',
        requiresExplicitUserIntent: false,
        indicator: 'tool-failed',
        boundary,
      }
    }
    return {
      allowed: true,
      reason: 'Live/current information is grounded by tool access.',
      requiresExplicitUserIntent: false,
      indicator: 'current-info-used',
      boundary,
    }
  }

  if (input.intent === 'chat-answer') {
    return {
      allowed: true,
      reason: 'Direct chat answers are allowed without side effects.',
      requiresExplicitUserIntent: false,
      boundary,
    }
  }

  if (boundary === 'public_safe') {
    return {
      allowed: false,
      reason: `Public surfaces stay public-safe; ${input.intent} is blocked there.`,
      requiresExplicitUserIntent: true,
      boundary,
    }
  }

  if (!input.explicitUserIntent) {
    return {
      allowed: false,
      reason: `${input.intent} requires explicit user intent.`,
      requiresExplicitUserIntent: true,
      boundary,
    }
  }

  if (input.intent === 'remember-this') {
    return {
      allowed: true,
      reason: 'User explicitly requested memory write.',
      requiresExplicitUserIntent: true,
      indicator: 'memory-used',
      boundary,
    }
  }

  if (input.intent === 'create-reminder') {
    return {
      allowed: true,
      reason: 'User explicitly requested a scheduled reminder.',
      requiresExplicitUserIntent: true,
      indicator: 'scheduled-task-created',
      boundary,
    }
  }

  if (boundary === 'paired_dm') {
    return {
      allowed: true,
      reason: `Paired DM surface accepted explicit ${input.intent}.`,
      requiresExplicitUserIntent: true,
      boundary,
    }
  }

  return {
    allowed: true,
    reason: `User explicitly requested ${input.intent}.`,
    requiresExplicitUserIntent: true,
    boundary,
  }
}

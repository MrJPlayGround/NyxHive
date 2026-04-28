import { getConversationModePosture } from '../conversation-mode-router'

export type ComposerIntent =
  | 'ready'
  | 'drafting'
  | 'code'
  | 'command'
  | 'attaching'
  | 'running'
  | 'queued-followup'

export type ComposerThinkingLevel = 'off' | 'low' | 'medium' | 'high'
export type ComposerConversationMode =
  | 'auto'
  | 'quick'
  | 'task'
  | 'build'
  | 'deep'

export type ComposerStateInput = {
  value: string
  attachmentCount: number
  attachmentProcessingCount: number
  fastMode: boolean
  thinkingLevel: ComposerThinkingLevel
  conversationMode?: ComposerConversationMode
  isLoading: boolean
  queuedFollowupActive?: boolean
}

export type ComposerState = {
  intent: ComposerIntent
  headline: string
  detail: string
  badges: Array<string>
  tokenEstimate: number
  lineCount: number
}

function countLines(value: string): number {
  if (!value) return 0
  return value.split(/\r\n|\r|\n/).length
}

function estimateTokens(value: string): number {
  const trimmed = value.trim()
  if (!trimmed) return 0
  return Math.max(1, Math.ceil(trimmed.length / 4))
}

function hasCodeContext(value: string): boolean {
  const trimmed = value.trim()
  return (
    trimmed.includes('```') ||
    /^ {4,}\S/m.test(value) ||
    /^\s*(const|let|var|function|class|type|interface|import|export)\s/m.test(
      value,
    )
  )
}

function isSlashCommandDraft(value: string): boolean {
  return /^\/[a-z][a-z0-9-]*(?:\s|$)/i.test(value.trim())
}

function formatThinkingBadge(level: ComposerThinkingLevel): string {
  if (level === 'off') return 'Reasoning off'
  return `Reasoning ${level}`
}

function formatConversationModeBadge(
  mode: ComposerConversationMode | undefined,
): string | null {
  if (!mode) return null
  if (mode === 'auto') return 'Auto'
  if (mode === 'quick') return 'Quick'
  if (mode === 'task') return 'Task'
  if (mode === 'deep') return 'Deep'
  return 'Build'
}

function describeConversationMode(
  mode: ComposerConversationMode | undefined,
): string | null {
  if (!mode || mode === 'auto') return null
  return getConversationModePosture(mode).detail
}

export function shouldAcceptSlashSuggestionKey(
  key: string,
  shiftKey: boolean,
): boolean {
  return key === 'Tab' && !shiftKey
}

export function deriveComposerState(input: ComposerStateInput): ComposerState {
  const trimmed = input.value.trim()
  const lineCount = countLines(trimmed)
  const tokenEstimate = estimateTokens(trimmed)
  const hasAttachments = input.attachmentCount > 0
  const isProcessingAttachments = input.attachmentProcessingCount > 0
  const badges: Array<string> = []

  if (input.attachmentCount === 1) {
    badges.push('1 attachment')
  } else if (input.attachmentCount > 1) {
    badges.push(`${input.attachmentCount} attachments`)
  }

  if (isProcessingAttachments) {
    badges.push(`${input.attachmentProcessingCount} processing`)
  }

  const modeBadge = formatConversationModeBadge(input.conversationMode)
  const modeDetail = describeConversationMode(input.conversationMode)
  if (modeBadge) badges.push(modeBadge)

  if (input.fastMode && input.thinkingLevel === 'off') {
    badges.push('Fast')
  } else {
    badges.push(formatThinkingBadge(input.thinkingLevel))
  }

  if (lineCount >= 2) {
    badges.push(`${lineCount} lines`)
  }

  if (tokenEstimate >= 25) {
    badges.push(`~${tokenEstimate} tokens`)
  }

  if (input.isLoading && input.queuedFollowupActive) {
    badges.unshift('Queued')
    return {
      intent: 'queued-followup',
      headline: 'Follow-up queued',
      detail: trimmed
        ? 'Send again to steer the active run.'
        : 'The queued follow-up will send after this response.',
      badges,
      tokenEstimate,
      lineCount,
    }
  }

  if (input.isLoading) {
    return {
      intent: 'running',
      headline: 'Nyx is working',
      detail: trimmed
        ? 'Draft a follow-up while this run finishes.'
        : 'You can prepare the next instruction here.',
      badges,
      tokenEstimate,
      lineCount,
    }
  }

  if (isProcessingAttachments) {
    return {
      intent: 'attaching',
      headline: 'Preparing context',
      detail:
        input.attachmentProcessingCount === 1
          ? 'Processing 1 attachment before sending.'
          : `Processing ${input.attachmentProcessingCount} attachments before sending.`,
      badges,
      tokenEstimate,
      lineCount,
    }
  }

  if (hasCodeContext(trimmed)) {
    badges.unshift('Code')
    return {
      intent: 'code',
      headline: 'Code context draft',
      detail: 'Structured prompt with code context.',
      badges,
      tokenEstimate,
      lineCount,
    }
  }

  if (isSlashCommandDraft(trimmed)) {
    badges.unshift('Action')
    return {
      intent: 'command',
      headline: 'Action command',
      detail: 'Preparing a workspace action.',
      badges,
      tokenEstimate,
      lineCount,
    }
  }

  if (trimmed || hasAttachments) {
    return {
      intent: 'drafting',
      headline: hasAttachments ? 'Context attached' : 'Draft ready',
      detail: hasAttachments
        ? 'Nyx will receive the attached context with this message.'
        : modeDetail ?? 'Ready to send to Nyx.',
      badges,
      tokenEstimate,
      lineCount,
    }
  }

  return {
    intent: 'ready',
    headline: 'Agent workspace',
    detail: modeDetail ?? 'Give Nyx a task, context, or question.',
    badges,
    tokenEstimate,
    lineCount,
  }
}

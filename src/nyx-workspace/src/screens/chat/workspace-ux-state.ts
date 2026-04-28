import type { ChatAttachment, SessionMeta } from './types'

export type SessionBucketId = 'working' | 'today' | 'week' | 'older'

export type SessionBucketItem = {
  session: SessionMeta
  title: string
  subtitle: string
  activeRuntime: boolean
}

export type SessionBucket = {
  id: SessionBucketId
  label: string
  items: Array<SessionBucketItem>
}

export type ActionRiskTier = 'low' | 'medium' | 'high'

export type ActionRisk = {
  tier: ActionRiskTier
  label: string
  detail: string
}

export type ArtifactSummaryKind =
  | 'markdown'
  | 'code'
  | 'diff'
  | 'file'
  | 'attachment'

export type ArtifactSummary = {
  kind: ArtifactSummaryKind
  label: string
  detail: string
  count: number
}

export type ArtifactToolSection = {
  type: string
  input?: Record<string, unknown>
  outputText?: string
  errorText?: string
  state?: string
}

export type SetupReadinessStatus = 'blocked' | 'needs-config' | 'ready'

export type SetupReadiness = {
  status: SetupReadinessStatus
  headline: string
  detail: string
  nextAction: string
}

const DAY_MS = 86_400_000
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function isRuntimeActiveSession(
  session: Pick<SessionMeta, 'key' | 'friendlyId'>,
  activeRuntimeSessionKeys?: Set<string>,
): boolean {
  if (!activeRuntimeSessionKeys || activeRuntimeSessionKeys.size === 0) {
    return false
  }
  return (
    activeRuntimeSessionKeys.has(session.key) ||
    activeRuntimeSessionKeys.has(session.friendlyId)
  )
}

function normalizeTitle(value: string | undefined): string {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim()
  if (!trimmed || UUID_PATTERN.test(trimmed)) return ''
  return trimmed
}

export function getSessionUxTitle(session: SessionMeta): string {
  const label = normalizeTitle(session.label)
  if (label) return label
  const derived = normalizeTitle(session.derivedTitle)
  if (derived) return derived
  const title = normalizeTitle(session.title)
  if (title) return title
  return `Session ${(session.friendlyId || session.key).slice(0, 8)}`
}

export function formatSessionAge(
  timestamp: number | undefined,
  now = Date.now(),
): string {
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return ''
  const diff = Math.max(0, now - timestamp)
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < DAY_MS) return `${Math.floor(diff / 3_600_000)}h ago`
  if (diff < DAY_MS * 7) return `${Math.floor(diff / DAY_MS)}d ago`
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
  }).format(new Date(timestamp))
}

function bucketForSession(
  session: SessionMeta,
  activeRuntime: boolean,
  now: number,
): SessionBucketId {
  if (activeRuntime) return 'working'
  const updatedAt =
    typeof session.updatedAt === 'number' && Number.isFinite(session.updatedAt)
      ? session.updatedAt
      : 0
  const diff = Math.max(0, now - updatedAt)
  if (diff < DAY_MS) return 'today'
  if (diff < DAY_MS * 7) return 'week'
  return 'older'
}

function sessionSubtitle(input: {
  session: SessionMeta
  activeRuntime: boolean
  now: number
}): string {
  const parts: Array<string> = []
  if (input.activeRuntime) parts.push('Working')
  const age = formatSessionAge(input.session.updatedAt, input.now)
  if (age) parts.push(age)
  const id = input.session.friendlyId || input.session.key
  if (id) parts.push(`ID ${id.slice(0, 8)}`)
  return parts.join(' · ')
}

export function deriveSessionBuckets(input: {
  sessions: Array<SessionMeta>
  activeRuntimeSessionKeys?: Set<string>
  now?: number
}): Array<SessionBucket> {
  const now = input.now ?? Date.now()
  const buckets: Record<SessionBucketId, SessionBucket> = {
    working: { id: 'working', label: 'Working now', items: [] },
    today: { id: 'today', label: 'Today', items: [] },
    week: { id: 'week', label: 'This week', items: [] },
    older: { id: 'older', label: 'Older', items: [] },
  }

  for (const session of input.sessions) {
    const activeRuntime = isRuntimeActiveSession(
      session,
      input.activeRuntimeSessionKeys,
    )
    const bucketId = bucketForSession(session, activeRuntime, now)
    buckets[bucketId].items.push({
      session,
      title: getSessionUxTitle(session),
      subtitle: sessionSubtitle({ session, activeRuntime, now }),
      activeRuntime,
    })
  }

  return (['working', 'today', 'week', 'older'] as const)
    .map((id) => buckets[id])
    .filter((bucket) => bucket.items.length > 0)
}

function readStringArg(
  args: Record<string, unknown> | undefined,
  ...keys: Array<string>
): string {
  if (!args) return ''
  for (const key of keys) {
    const value = args[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return ''
}

export function deriveActionRisk(
  toolName: string,
  args?: Record<string, unknown>,
): ActionRisk {
  const name = toolName.trim().toLowerCase()
  const command = readStringArg(args, 'command', 'cmd', 'script').toLowerCase()
  const target = readStringArg(args, 'path', 'file_path', 'target_file')
  const text = `${name} ${command} ${target}`.toLowerCase()
  const destructive =
    /\b(rm\s+-rf|git\s+reset\s+--hard|git\s+push\s+--force|drop\s+table|delete\s+from|truncate\s+table|kill-session|chmod\s+-r|chown\s+-r)\b/.test(
      text,
    ) ||
    /\b(delete|remove|destroy|overwrite|write_file|create_file|edit|patch|apply_patch|migration|deploy)\b/.test(
      text,
    )

  if (destructive) {
    return {
      tier: 'high',
      label: 'High risk',
      detail: 'Review carefully: this is a destructive or persistent action.',
    }
  }

  if (
    /\b(exec|terminal|shell|bash|process|browser_click|browser_type|send_message|delegate|spawn)\b/.test(
      name,
    )
  ) {
    return {
      tier: 'medium',
      label: 'Action',
      detail: 'This action can affect runtime state or external surfaces.',
    }
  }

  return {
    tier: 'low',
    label: 'Read-only',
    detail: 'Inspection only; no workspace state should change.',
  }
}

function countMarkdownDeliverables(text: string): number {
  const matches = text.match(/```(?:md|markdown)\n[\s\S]*?```/gi)
  if (matches?.length) return matches.length
  if (/^#{1,3}\s+\S/m.test(text) && /^[-*]\s+\S/m.test(text)) return 1
  return 0
}

function countCodeFences(text: string): number {
  const matches = text.match(/```(?!md|markdown)([a-z0-9_-]+)?\n[\s\S]*?```/gi)
  return matches?.length ?? 0
}

export function deriveArtifactSummary(input: {
  text: string
  attachments: Array<ChatAttachment>
  toolSections: Array<ArtifactToolSection>
}): ArtifactSummary | null {
  const attachmentCount = input.attachments.length
  if (attachmentCount > 0) {
    return {
      kind: 'attachment',
      label: attachmentCount === 1 ? 'Attached artifact' : 'Attached artifacts',
      detail:
        attachmentCount === 1
          ? '1 file is part of this turn.'
          : `${attachmentCount} files are part of this turn.`,
      count: attachmentCount,
    }
  }

  const writeTools = input.toolSections.filter((tool) => {
    const name = tool.type.toLowerCase()
    return (
      /write|edit|patch|create/.test(name) &&
      (tool.state === 'output-available' || Boolean(tool.outputText))
    )
  })
  if (writeTools.length > 0) {
    return {
      kind: 'file',
      label: writeTools.length === 1 ? 'File artifact' : 'File artifacts',
      detail:
        writeTools.length === 1
          ? 'Nyx produced or changed a file.'
          : `Nyx produced or changed ${writeTools.length} files.`,
      count: writeTools.length,
    }
  }

  if (/^(diff --git|--- |\+\+\+ |@@ )/m.test(input.text)) {
    return {
      kind: 'diff',
      label: 'Patch artifact',
      detail: 'Structured diff output is available in this message.',
      count: 1,
    }
  }

  const markdownCount = countMarkdownDeliverables(input.text)
  if (markdownCount > 0) {
    return {
      kind: 'markdown',
      label: 'Markdown deliverable',
      detail: 'Structured markdown output is available to reuse.',
      count: markdownCount,
    }
  }

  const codeCount = countCodeFences(input.text)
  if (codeCount > 0) {
    return {
      kind: 'code',
      label: codeCount === 1 ? 'Code artifact' : 'Code artifacts',
      detail:
        codeCount === 1
          ? 'A code block is ready to copy or inspect.'
          : `${codeCount} code blocks are ready to copy or inspect.`,
      count: codeCount,
    }
  }

  return null
}

export function deriveSetupReadiness(input: {
  connected: boolean
  sessionsAvailable: boolean
  configAvailable: boolean
  skillsAvailable: boolean
  sessionCount: number
}): SetupReadiness {
  if (!input.connected || !input.sessionsAvailable) {
    return {
      status: 'blocked',
      headline: 'Runtime not connected',
      detail: 'Connect the NyxHive gateway before starting a workspace run.',
      nextAction: 'Open settings',
    }
  }

  if (!input.configAvailable) {
    return {
      status: 'needs-config',
      headline: 'Provider setup needed',
      detail: 'Runtime is reachable, but provider configuration is unavailable.',
      nextAction: 'Review providers',
    }
  }

  return {
    status: 'ready',
    headline: input.sessionCount > 0 ? 'Workspace ready' : 'Ready for first run',
    detail: input.skillsAvailable
      ? 'Core chat, runtime configuration, and skills are available.'
      : 'Core chat and runtime configuration are available.',
    nextAction: input.sessionCount > 0 ? 'Open recent session' : 'Start chat',
  }
}

export type StreamToolPhase =
  | 'calling'
  | 'running'
  | 'done'
  | 'complete'
  | 'completed'
  | 'result'
  | 'error'

export type StreamToolCall = {
  id: string
  name: string
  phase: StreamToolPhase
  args?: unknown
  preview?: string
  result?: string
}

export type LifecycleEvent = {
  text: string
  emoji: string
  timestamp: number
  isError: boolean
}

import { WORKSPACE_AGENT_NAME } from '@/lib/workspace-branding'

export type InlineToolSection = {
  key: string
  type: string
  input?: Record<string, unknown>
  preview?: string
  outputText: string
  errorText?: string
  state:
    | 'input-streaming'
    | 'input-available'
    | 'output-available'
    | 'output-error'
}

export type ToolEvidenceTier = 'status' | 'tool_evidence' | 'debug_trace'

export type StreamingActivityStep = {
  key: string
  label: string
  detail?: string
  state: 'active' | 'done' | 'error' | 'muted'
  category?: StreamingActivityCategory
}

export type StreamingActivityCategory =
  | 'inspecting'
  | 'reading'
  | 'searching'
  | 'running_command'
  | 'editing'
  | 'verifying'
  | 'waiting'
  | 'retrying'
  | 'synthesizing'
  | 'completed'
  | 'blocked'

export type StreamingExecutionPhase =
  | 'inspecting'
  | 'running'
  | 'verifying'
  | 'waiting'
  | 'retrying'
  | 'synthesizing'
  | 'completed'
  | 'blocked'

export type StreamingActivityState = {
  phase: StreamingExecutionPhase
  header: string
  sublabel: string
  elapsedLabel: string
  activeStep: StreamingActivityStep | null
  recentSteps: Array<StreamingActivityStep>
  allSteps: Array<StreamingActivityStep>
  detail: string
}

export function normalizeStreamToolPhase(
  phase: unknown,
): 'calling' | 'running' | 'done' | 'error' {
  if (phase === 'calling' || phase === 'start' || phase === 'started') {
    return 'calling'
  }
  if (phase === 'running') return 'running'
  if (
    phase === 'done' ||
    phase === 'result' ||
    phase === 'complete' ||
    phase === 'completed'
  ) {
    return 'done'
  }
  if (phase === 'error' || phase === 'failed' || phase === 'failure') {
    return 'error'
  }
  return 'running'
}

export function hasRecordEntries(
  value: Record<string, unknown> | undefined,
): boolean {
  return Boolean(value && Object.keys(value).length > 0)
}

export function hasNonEmptyText(value: string | undefined): boolean {
  return Boolean(value && value.trim().length > 0)
}

function normalizeToolType(type: string): string {
  return type.trim().toLowerCase()
}

function isRunningToolSection(section: InlineToolSection): boolean {
  return (
    section.state === 'input-available' || section.state === 'input-streaming'
  )
}

function isFileChangeTool(type: string): boolean {
  const normalized = normalizeToolType(type)
  return (
    normalized === 'edit' ||
    normalized === 'write' ||
    normalized === 'patch_file' ||
    normalized === 'create_file' ||
    normalized === 'write_file' ||
    normalized === 'file_write' ||
    normalized.startsWith('artifact')
  )
}

function isLowLevelRuntimeTool(type: string): boolean {
  const normalized = normalizeToolType(type)
  return (
    normalized === 'command_execution' ||
    normalized === 'exec' ||
    normalized === 'terminal' ||
    normalized === 'shell' ||
    normalized === 'bash' ||
    normalized === 'process' ||
    normalized === 'running command' ||
    normalized === 'command run complete' ||
    normalized.startsWith('running ')
  )
}

export function hasToolSectionDetail(section: InlineToolSection): boolean {
  return (
    hasRecordEntries(section.input) ||
    hasNonEmptyText(section.preview) ||
    hasNonEmptyText(section.outputText) ||
    hasNonEmptyText(section.errorText)
  )
}

export function classifyToolSection(
  section: InlineToolSection,
): ToolEvidenceTier {
  if (section.state === 'output-error' || hasNonEmptyText(section.errorText)) {
    return 'tool_evidence'
  }

  if (hasNonEmptyText(section.outputText)) {
    return 'tool_evidence'
  }

  if (isRunningToolSection(section)) {
    return 'status'
  }

  if (isFileChangeTool(section.type) && hasRecordEntries(section.input)) {
    return 'tool_evidence'
  }

  if (
    hasNonEmptyText(section.preview) &&
    !isLowLevelRuntimeTool(section.type)
  ) {
    return 'tool_evidence'
  }

  return 'debug_trace'
}

export function selectVisibleToolSections(
  sections: Array<InlineToolSection>,
  isStreaming: boolean,
): Array<InlineToolSection> {
  if (isStreaming) return []
  return sections.filter(
    (section) => classifyToolSection(section) === 'tool_evidence',
  )
}

export function selectStreamingStatusToolSections(
  sections: Array<InlineToolSection>,
): Array<InlineToolSection> {
  return sections.filter((section) => {
    if (isRunningToolSection(section)) return true
    return classifyToolSection(section) === 'tool_evidence'
  })
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function stripDecorativePrefix(value: string): string {
  return value
    .replace(/^[\p{Emoji_Presentation}\p{Extended_Pictographic}\s]+/u, '')
    .trim()
}

function visibleStepKey(label: string): string {
  return compactWhitespace(label)
    .toLowerCase()
    .replace(/[.?!:;]+$/g, '')
}

function isGenericStatusLine(value: string): boolean {
  const line = visibleStepKey(stripDecorativePrefix(value))
  return (
    line === 'nyx is working' ||
    line === 'nyx is thinking' ||
    line === 'working' ||
    line === 'thinking' ||
    line === 'live run connected' ||
    line === 'current activity' ||
    line === 'runtime status' ||
    line === 'work status'
  )
}

function isWorkflowDiaryLine(value: string): boolean {
  const line = compactWhitespace(stripDecorativePrefix(value))
  return /^(?:Using\s+`?(?:superpowers:|[^.\n]{0,160}\b(?:using-superpowers|test-driven-development|systematic-debugging|verification-before-completion|writing-plans|brainstorming))|I(?:'| a)m\s+(?:starting|checking|locating|reading|running|adding|making|moving|rerunning|backfilling|committing|pushing|drilling|treating|skipping|opening|looking|inspecting|verifying|patching|testing|fixing)\b|I(?:'ll| will)\s+(?:start|check|locate|read|run|add|make|move|rerun|backfill|commit|push|drill|treat|skip|open|inspect|verify|patch|test|fix)\b|The\s+(?:narrow|targeted|full|live|regression|failing)\b.*\b(?:tests?|logs?|coverage|suite|checks?)\b|Verification is clean\b|Implementation is now wired\b)/i.test(line)
}

function normalizeActivityLabel(value: string): string {
  const line = compactWhitespace(stripDecorativePrefix(value))
  const delegationMatch = /^delegating to @?([a-z0-9_-]+)/i.exec(line)
  if (delegationMatch) {
    const agent = delegationMatch[1]
    return `Consulting ${agent.charAt(0).toUpperCase()}${agent.slice(1)}`
  }
  const waitingMatch = /^waiting for @?([a-z0-9_-]+)/i.exec(line)
  if (
    waitingMatch
    && !/^(command|output|backend|network|response)$/i.test(waitingMatch[1] ?? '')
  ) {
    const agent = waitingMatch[1]
    return `Waiting on ${agent.charAt(0).toUpperCase()}${agent.slice(1)}`
  }
  if (/synthesizing delegation results/i.test(line)) {
    return 'Reviewing specialist results'
  }
  if (
    /starting .*runtime|full-capability runtime|codex sdk runtime|codex sdk turn started|codex turn started/i.test(
      line,
    )
  ) {
    return 'Starting workspace runtime'
  }
  if (/^running git$/i.test(line)) return 'Checking repository state'
  if (/^running sleep$/i.test(line)) return 'Running requested command'
  return line
}

function firstStringArg(
  args: Record<string, unknown> | undefined,
  ...keys: Array<string>
): string | null {
  if (!args) return null
  for (const key of keys) {
    const value = args[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

function fileNameFromPath(value: string): string {
  const normalized = value.trim().replace(/[\\/]+$/, '')
  if (!normalized) return value.trim()
  const parts = normalized.split(/[\\/]/)
  return parts[parts.length - 1] || normalized
}

export function coerceToolInput(
  value: unknown,
): Record<string, unknown> | undefined {
  if (!value) return undefined
  if (typeof value === 'string' && value.trim()) return { command: value.trim() }
  if (typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  return undefined
}

function cleanToolName(type: string): string {
  return type
    .trim()
    .replace(/^functions[._-]/i, '')
    .replace(/^mcp__[^_]+__/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function summarizeCommand(command: string): string {
  const compact = compactWhitespace(command)
  if (!compact) return 'Run command'
  if (/git\s+status\b/i.test(compact)) return 'Check git status'
  if (/^(cat|sed|awk|rg|grep|find|ls|tree|git show|git diff|git status|git log)\b/i.test(compact)) {
    return 'Inspect workspace files'
  }
  if (/^(bun|npm|pnpm|yarn)\s+(test|run test|x tsc|run typecheck|typecheck)\b/i.test(compact)) {
    return 'Verify the workspace'
  }
  if (/^(bun|npm|pnpm|yarn)\s+(run\s+)?(dev|start|workspace:dev)\b/i.test(compact)) {
    return 'Start the workspace'
  }
  if (compact.length <= 48) return `Run ${compact}`
  return `Run ${compact.slice(0, 45)}...`
}

function commandCategory(command: string | null): StreamingActivityCategory {
  if (!command) return 'running_command'
  const compact = compactWhitespace(command)
  if (
    /^(bun|npm|pnpm|yarn)\s+(test|run test|x tsc|run typecheck|typecheck|run build|build)\b/i.test(
      compact,
    )
  ) {
    return 'verifying'
  }
  if (
    /^(cat|sed|awk|rg|grep|find|ls|tree|git show|git diff|git status|git log)\b/i.test(
      compact,
    )
  ) {
    return 'inspecting'
  }
  return 'running_command'
}

function toolActivityCategory(
  section: InlineToolSection,
): StreamingActivityCategory {
  const type = normalizeToolType(section.type)
  const command = firstStringArg(section.input, 'command', 'cmd')

  if (section.state === 'output-error' || hasNonEmptyText(section.errorText)) {
    return 'blocked'
  }
  if (type === 'read' || type === 'read_file' || type === 'file_read') {
    return 'reading'
  }
  if (type.includes('search')) return 'searching'
  if (
    type === 'edit' ||
    type === 'patch_file' ||
    type === 'write' ||
    type === 'write_file' ||
    type === 'create_file' ||
    type === 'file_write'
  ) {
    return 'editing'
  }
  if (isLowLevelRuntimeTool(type)) return commandCategory(command)
  if (type.includes('web') || type.includes('browser')) return 'inspecting'
  return 'running_command'
}

export function defaultToolActivityLabel(section: InlineToolSection): string {
  const type = normalizeToolType(section.type)
  const input = section.input
  const targetPath = firstStringArg(
    input,
    'file_path',
    'path',
    'target_file',
    'uri',
  )
  const query = firstStringArg(input, 'query', 'q', 'search_query', 'pattern')
  const url = firstStringArg(input, 'url', 'href')
  const command = firstStringArg(input, 'command', 'cmd')

  if (type === 'read' || type === 'read_file' || type === 'file_read') {
    return targetPath ? `Read ${fileNameFromPath(targetPath)}` : 'Read file'
  }

  if (
    type === 'edit' ||
    type === 'patch_file' ||
    type === 'write' ||
    type === 'write_file' ||
    type === 'create_file' ||
    type === 'file_write'
  ) {
    return targetPath ? `Update ${fileNameFromPath(targetPath)}` : 'Update files'
  }

  if (type.includes('search')) {
    return query ? `Search ${query}` : 'Search relevant context'
  }

  if (type.includes('web') || type.includes('browser')) {
    return url ? `Open ${url}` : 'Check external context'
  }

  if (isLowLevelRuntimeTool(type)) {
    if (command) return summarizeCommand(command)
    const runtimeLabel = normalizeActivityLabel(cleanToolName(section.type))
    return runtimeLabel && runtimeLabel !== cleanToolName(section.type)
      ? runtimeLabel
      : 'Run command'
  }

  const cleaned = normalizeActivityLabel(cleanToolName(section.type))
  return cleaned ? cleaned.charAt(0).toUpperCase() + cleaned.slice(1) : 'Use tool'
}

function lifecycleStepLabel(event: LifecycleEvent): string | null {
  const raw = normalizeActivityLabel(event.text)
  if (!raw || isGenericStatusLine(raw)) return null
  if (isWorkflowDiaryLine(raw)) return null

  const lower = raw.toLowerCase()
  if (event.isError || /failed|failure|error|aborted|cancelled/.test(lower)) {
    return 'Run needs attention'
  }
  if (/retry|retrying/.test(lower)) {
    return raw.length <= 96 ? raw : `${raw.slice(0, 93)}...`
  }
  if (/waiting for command output|waiting for output/.test(lower)) {
    return 'Waiting for command output'
  }
  if (/waiting for backend|waiting for network|waiting for response/.test(lower)) {
    return 'Waiting for backend response'
  }
  if (/compacting|compaction|context/.test(lower)) {
    return 'Checking context'
  }
  if (/queued|submitted|waiting/.test(lower)) {
    return 'Queueing the request'
  }
  if (/connected|stream opened|sse|live run/.test(lower)) {
    return 'Connected to the live run'
  }
  if (/started|active|running/.test(lower)) {
    return 'Started the run'
  }
  if (/completed|finished|done/.test(lower)) {
    return 'Finished the turn'
  }
  if (/tool|runtime|status/.test(lower)) return null

  return raw.length <= 96 ? raw : `${raw.slice(0, 93)}...`
}

function lifecycleActivityCategory(
  event: LifecycleEvent,
  label: string,
): StreamingActivityCategory {
  const lower = `${event.text} ${label}`.toLowerCase()
  if (event.isError || /failed|failure|error|aborted|cancelled/.test(lower)) {
    return 'blocked'
  }
  if (/retry|retrying/.test(lower)) return 'retrying'
  if (/waiting|queued|submitted/.test(lower)) return 'waiting'
  if (/completed|finished|done/.test(lower)) return 'completed'
  if (/compacting|compaction|context|connected|stream opened|sse|live run|started|active|running/.test(lower)) {
    return 'inspecting'
  }
  return 'synthesizing'
}

function pushUniqueStep(
  steps: Array<StreamingActivityStep>,
  seen: Set<string>,
  step: StreamingActivityStep,
): void {
  const key = visibleStepKey(step.label)
  if (!key || seen.has(key)) return
  const previous = steps[steps.length - 1]
  if (previous && visibleStepKey(previous.label) === key) return
  seen.add(key)
  steps.push({ ...step, key: step.key || key })
}

function toolStepState(section: InlineToolSection): StreamingActivityStep['state'] {
  if (section.state === 'output-error' || hasNonEmptyText(section.errorText)) {
    return 'error'
  }
  if (isRunningToolSection(section)) return 'active'
  if (section.state === 'output-available') return 'done'
  return 'muted'
}

export function buildStreamingActivityTimeline({
  thinking,
  lifecycleEvents,
  toolSections,
  formatToolLabel,
  maxSteps = 6,
}: {
  thinking?: string | null
  lifecycleEvents: Array<LifecycleEvent>
  toolSections: Array<InlineToolSection>
  formatToolLabel?: (section: InlineToolSection) => string
  maxSteps?: number
}): Array<StreamingActivityStep> {
  const steps: Array<StreamingActivityStep> = []
  const seen = new Set<string>()
  const cleanedThinking = typeof thinking === 'string' ? thinking.trim() : ''

  if (cleanedThinking) {
    for (const line of cleanedThinking
      .split('\n')
      .map(normalizeActivityLabel)
      .filter(Boolean)
      .slice(-3)) {
      if (isWorkflowDiaryLine(line)) continue
      if (isGenericStatusLine(line)) continue
      pushUniqueStep(steps, seen, {
        key: `thinking:${line}`,
        label: line.length <= 96 ? line : `${line.slice(0, 93)}...`,
        state: 'active',
      })
    }
  }

  for (const event of lifecycleEvents.slice(-8)) {
    const label = lifecycleStepLabel(event)
    if (!label) continue
    const category = lifecycleActivityCategory(event, label)
    pushUniqueStep(steps, seen, {
      key: `lifecycle:${event.timestamp}:${label}`,
      label,
      state:
        event.isError || category === 'blocked'
          ? 'error'
          : category === 'waiting' || category === 'retrying'
            ? 'active'
            : 'muted',
      category,
    })
  }

  for (const section of toolSections.slice(-8)) {
    const category = toolActivityCategory(section)
    const fallback = defaultToolActivityLabel(section)
    const formatted = isLowLevelRuntimeTool(section.type)
      ? undefined
      : formatToolLabel?.(section)
    const label = compactWhitespace(formatted || fallback)
    const visibleLabel =
      !label || isGenericStatusLine(label) || label === section.type
        ? fallback
        : label
    if (!visibleLabel || isGenericStatusLine(visibleLabel)) continue
    pushUniqueStep(steps, seen, {
      key: `tool:${section.key}:${visibleLabel}`,
      label: visibleLabel,
      detail: hasNonEmptyText(section.preview) ? section.preview : undefined,
      state: toolStepState(section),
      category,
    })
  }

  return steps.slice(-maxSteps)
}

function phaseForStep(
  step: StreamingActivityStep | null,
): StreamingExecutionPhase {
  if (!step) return 'synthesizing'
  if (step.state === 'error') return 'blocked'
  switch (step.category) {
    case 'waiting':
      return 'waiting'
    case 'retrying':
      return 'retrying'
    case 'verifying':
      return 'verifying'
    case 'completed':
      return 'completed'
    case 'blocked':
      return 'blocked'
    case 'inspecting':
    case 'reading':
    case 'searching':
      return 'inspecting'
    case 'editing':
    case 'running_command':
      return 'running'
    case 'synthesizing':
    default:
      return 'synthesizing'
  }
}

function headerForPhase(phase: StreamingExecutionPhase): string {
  switch (phase) {
    case 'inspecting':
      return `${WORKSPACE_AGENT_NAME} is inspecting the workspace...`
    case 'running':
      return `${WORKSPACE_AGENT_NAME} is running a command...`
    case 'verifying':
      return `${WORKSPACE_AGENT_NAME} is verifying the result...`
    case 'waiting':
      return `${WORKSPACE_AGENT_NAME} is waiting for output...`
    case 'retrying':
      return `${WORKSPACE_AGENT_NAME} is retrying...`
    case 'completed':
      return `${WORKSPACE_AGENT_NAME} finished the live run.`
    case 'blocked':
      return `${WORKSPACE_AGENT_NAME} needs attention.`
    case 'synthesizing':
    default:
      return `${WORKSPACE_AGENT_NAME} is drafting the response...`
  }
}

function phaseElapsedLabel(phase: StreamingExecutionPhase): string {
  switch (phase) {
    case 'inspecting':
      return 'reading code'
    case 'running':
      return 'running'
    case 'verifying':
      return 'verifying'
    case 'waiting':
      return 'waiting'
    case 'retrying':
      return 'retrying'
    case 'completed':
      return 'finished'
    case 'blocked':
      return 'blocked'
    case 'synthesizing':
    default:
      return 'synthesizing'
  }
}

function formatElapsedSeconds(seconds: number): string {
  if (seconds <= 0) return ''
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

export function formatStateAwareElapsedLabel(
  seconds: number,
  phase: StreamingExecutionPhase,
): string {
  const elapsed = formatElapsedSeconds(seconds)
  if (!elapsed) return ''
  if (seconds < 10) return elapsed
  return `${elapsed}, ${phaseElapsedLabel(phase)}`
}

function fallbackActiveStep({
  isStreaming,
  hasRevealedText,
}: {
  isStreaming: boolean
  hasRevealedText: boolean
}): StreamingActivityStep | null {
  if (!isStreaming) return null
  return {
    key: hasRevealedText ? 'fallback:drafting' : 'fallback:preparing',
    label: hasRevealedText ? 'Drafting response' : 'Preparing response',
    state: 'active',
    category: 'synthesizing',
  }
}

export function deriveStreamingActivityState({
  thinking,
  lifecycleEvents,
  toolSections,
  formatToolLabel,
  elapsedSeconds,
  isStreaming,
  hasRevealedText,
  maxRecentSteps = 3,
}: {
  thinking?: string | null
  lifecycleEvents: Array<LifecycleEvent>
  toolSections: Array<InlineToolSection>
  formatToolLabel?: (section: InlineToolSection) => string
  elapsedSeconds: number
  isStreaming: boolean
  hasRevealedText: boolean
  maxRecentSteps?: number
}): StreamingActivityState {
  const allSteps = buildStreamingActivityTimeline({
    thinking,
    lifecycleEvents,
    toolSections,
    formatToolLabel,
    maxSteps: 10,
  })
  const activeStep =
    [...allSteps]
      .reverse()
      .find((step) => step.state === 'active' || step.state === 'error') ??
    fallbackActiveStep({ isStreaming, hasRevealedText })
  const phase = phaseForStep(activeStep)
  const activeKey = activeStep?.key
  const recentSteps = allSteps
    .filter((step) => step.key !== activeKey)
    .slice(-maxRecentSteps)

  return {
    phase,
    header: headerForPhase(phase),
    sublabel: activeStep?.label ?? `${WORKSPACE_AGENT_NAME} is preparing the response.`,
    elapsedLabel: formatStateAwareElapsedLabel(elapsedSeconds, phase),
    activeStep,
    recentSteps,
    allSteps,
    detail:
      allSteps.length === 0
        ? `${WORKSPACE_AGENT_NAME} is preparing the response.`
        : allSteps.map((step) => `• ${step.label}`).join('\n'),
  }
}

export function buildStreamingStatusDetail({
  thinking,
  lifecycleEvents,
  toolSections,
  formatToolLabel,
}: {
  thinking?: string | null
  lifecycleEvents: Array<LifecycleEvent>
  toolSections: Array<InlineToolSection>
  formatToolLabel?: (section: InlineToolSection) => string
}): string {
  const steps = buildStreamingActivityTimeline({
    thinking,
    lifecycleEvents,
    toolSections,
    formatToolLabel,
  })

  if (steps.length === 0) {
    return `${WORKSPACE_AGENT_NAME} is preparing the response.`
  }
  return steps.map((step) => `• ${step.label}`).join('\n')
}

export function shouldShowStreamingStatusWindow({
  isUser,
  isStreaming,
  hasRevealedText,
  hasStatusActivity,
}: {
  isUser: boolean
  isStreaming: boolean
  hasRevealedText: boolean
  hasStatusActivity: boolean
}): boolean {
  if (isUser || !isStreaming || hasRevealedText) return false
  return hasStatusActivity
}

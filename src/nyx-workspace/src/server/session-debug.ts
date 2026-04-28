import {
  isActivePersistedRunStatus,
  type PersistedRunState,
} from './run-store'

type DebugMessage = {
  role?: string
  content?: unknown
  timestamp?: number | string | null
}

type DebugSession = {
  id: string
  title?: string | null
  model?: string | null
  started_at?: number | null
  ended_at?: number | null
  input_tokens?: number | null
  output_tokens?: number | null
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((part) => {
      if (!part || typeof part !== 'object') return ''
      const record = part as Record<string, unknown>
      if (typeof record.text === 'string') return record.text
      if (typeof record.content === 'string') return record.content
      return ''
    })
    .join('')
    .trim()
}

export function buildSessionDebugSummary(input: {
  session: DebugSession
  messages: Array<DebugMessage>
  activeRun: PersistedRunState | null
  generatedAt?: string
}) {
  const lastMessage = input.messages[input.messages.length - 1] ?? null
  const lastText = lastMessage ? extractText(lastMessage.content) : ''
  const activeRun = input.activeRun
  const runIsActive = activeRun
    ? isActivePersistedRunStatus(activeRun.status)
    : false
  const terminal = !runIsActive

  return {
    ok: true,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    session: {
      id: input.session.id,
      title: input.session.title ?? '',
      model: input.session.model ?? '',
      status: input.session.ended_at ? 'ended' : 'idle',
      startedAt: input.session.started_at ?? null,
      endedAt: input.session.ended_at ?? null,
      tokenUsage: {
        input: input.session.input_tokens ?? 0,
        output: input.session.output_tokens ?? 0,
        total: (input.session.input_tokens ?? 0) + (input.session.output_tokens ?? 0),
      },
    },
    messages: {
      count: input.messages.length,
      lastRole: lastMessage?.role ?? null,
      lastTextPreview: lastText.slice(0, 240),
      hasAssistantResponse: input.messages.some((message) => message.role === 'assistant'),
    },
    run: activeRun
      ? {
          active: true,
          runId: activeRun.runId,
          status: activeRun.status,
          startedAt: activeRun.createdAt,
          updatedAt: activeRun.updatedAt,
          lastEventAt: activeRun.lastEventAt,
          assistantTextPreview: activeRun.assistantText.slice(0, 240),
          thinkingTextPreview: activeRun.thinkingText.slice(0, 240),
          toolCallCount: activeRun.toolCalls.length,
          lifecycleEventCount: activeRun.lifecycleEvents.length,
          errorMessage: activeRun.errorMessage ?? null,
        }
      : {
          active: false,
          status: 'idle',
        },
    diagnostics: {
      uiShouldShowWorking: runIsActive,
      terminalState: terminal,
      staleThinkingLikely: !activeRun && lastMessage?.role === 'assistant',
    },
  }
}

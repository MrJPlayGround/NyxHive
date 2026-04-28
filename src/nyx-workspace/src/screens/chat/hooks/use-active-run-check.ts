import { useEffect, useRef } from 'react'
import {
  useChatStore,
  type StreamingState,
} from '../../../stores/chat-store'

type ActiveRunStatus =
  | 'accepted'
  | 'active'
  | 'handoff'
  | 'stalled'
  | 'complete'
  | 'error'

type ActiveRunResponse = {
  ok: boolean
  run: {
    runId: string
    status: ActiveRunStatus
    sessionKey: string
    startedAt?: number
    assistantText?: string
    thinkingText?: string
    toolCalls?: Array<{
      id?: string
      name?: string
      phase?: string
      args?: unknown
      preview?: string
      result?: string
    }>
    lifecycleEvents?: Array<{
      text?: string
      emoji?: string
      timestamp?: number
      isError?: boolean
    }>
  } | null
}

type ChatStoreForActiveRunCheck = Pick<
  ReturnType<typeof useChatStore.getState>,
  | 'setSessionWaiting'
  | 'isSessionWaiting'
  | 'clearSessionWaiting'
  | 'clearStreamingSession'
  | 'getStreamingState'
  | 'hydrateStreamingSession'
  | 'isSendStreamRun'
>

const ACTIVE_STATUSES: ReadonlySet<string> = new Set([
  'accepted',
  'active',
  'handoff',
])

function activeRunToStreamingState(
  run: NonNullable<ActiveRunResponse['run']>,
): StreamingState {
  return {
    runId: run.runId,
    text: typeof run.assistantText === 'string' ? run.assistantText : '',
    thinking: typeof run.thinkingText === 'string' ? run.thinkingText : '',
    lifecycleEvents: Array.isArray(run.lifecycleEvents)
      ? run.lifecycleEvents
          .map((event) => ({
            text: typeof event.text === 'string' ? event.text : '',
            emoji: typeof event.emoji === 'string' ? event.emoji : '',
            timestamp:
              typeof event.timestamp === 'number' &&
              Number.isFinite(event.timestamp)
                ? event.timestamp
                : Date.now(),
            isError: event.isError === true,
          }))
          .filter((event) => event.text.length > 0)
      : [],
    toolCalls: Array.isArray(run.toolCalls)
      ? run.toolCalls
          .map((toolCall) => ({
            id:
              typeof toolCall.id === 'string' && toolCall.id.trim()
                ? toolCall.id
                : `${run.runId}:tool`,
            name:
              typeof toolCall.name === 'string' && toolCall.name.trim()
                ? toolCall.name
                : 'tool',
            phase:
              typeof toolCall.phase === 'string' && toolCall.phase.trim()
                ? toolCall.phase
                : 'calling',
            args: toolCall.args,
            preview:
              typeof toolCall.preview === 'string'
                ? toolCall.preview
                : undefined,
            result:
              typeof toolCall.result === 'string'
                ? toolCall.result
                : undefined,
          }))
      : [],
  }
}

export function applyActiveRunCheckResult(
  sessionKey: string,
  data: ActiveRunResponse,
  store: ChatStoreForActiveRunCheck = useChatStore.getState(),
): void {
  if (!data.ok) return

  if (data.run && ACTIVE_STATUSES.has(data.run.status)) {
    store.setSessionWaiting(sessionKey, data.run.runId)
    const streaming = store.getStreamingState(sessionKey)
    if (!(streaming?.runId && store.isSendStreamRun(streaming.runId))) {
      store.hydrateStreamingSession(
        sessionKey,
        activeRunToStreamingState(data.run),
      )
    }
    return
  }

  const streaming = store.getStreamingState(sessionKey)
  if (streaming?.runId && store.isSendStreamRun(streaming.runId)) {
    return
  }

  if (store.isSessionWaiting(sessionKey)) {
    store.clearSessionWaiting(sessionKey)
  }
  store.clearStreamingSession(sessionKey)
}

/**
 * On mount, checks whether the server has an active run for this session.
 * If so, marks the session as waiting in the persistent Zustand store.
 * If the server says the run is done, clears the stale waiting state.
 *
 * This closes the gap where a user navigates away during streaming,
 * the component unmounts (losing local state), and on remount the UI
 * doesn't know a run was in progress.
 */
export function useActiveRunCheck({
  sessionKey,
  enabled,
}: {
  sessionKey: string
  enabled: boolean
}): void {
  const hasCheckedRef = useRef(false)
  const sessionKeyRef = useRef(sessionKey)
  sessionKeyRef.current = sessionKey

  useEffect(() => {
    if (!enabled || !sessionKey || sessionKey === 'new') return
    if (hasCheckedRef.current) return
    hasCheckedRef.current = true

    const controller = new AbortController()

    async function check() {
      try {
        const response = await fetch(
          `/api/sessions/${encodeURIComponent(sessionKey)}/active-run`,
          { signal: controller.signal },
        )
        if (!response.ok) return

        const data = (await response.json()) as ActiveRunResponse
        if (!data.ok) return

        applyActiveRunCheckResult(sessionKey, data)
      } catch {
        // Network error or abort — ignore
      }
    }

    void check()

    return () => {
      controller.abort()
    }
  }, [sessionKey, enabled])

  // Reset check flag when session changes
  useEffect(() => {
    hasCheckedRef.current = false
  }, [sessionKey])
}

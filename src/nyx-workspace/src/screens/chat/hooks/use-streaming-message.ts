import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChatAttachment, ChatMessage } from '../types'
import { useChatStore } from '@/stores/chat-store'
import { pushActivity } from '@/components/inspector/activity-store'
import { WORKSPACE_AGENT_NAME } from '@/lib/workspace-branding'
import { createSseParser } from '@/lib/sse-parser'

type StreamingState = {
  isStreaming: boolean
  streamingMessageId: string | null
  streamingText: string
  error: string | null
}

type StreamLifecyclePhase =
  | 'idle'
  | 'requesting'
  | 'accepted'
  | 'active'
  | 'handoff'
  | 'complete'
  | 'error'

type StreamChunk = {
  text?: string
  delta?: string
  content?: string
  chunk?: string
}

type StepUsagePayload = {
  inputTokens?: number
  outputTokens?: number
  cacheRead?: number
  cacheWrite?: number
  contextPercent?: number
  model?: string
}

type PortableHistoryMessage = {
  role: string
  content: string
}

function appendThinkingProgress(current: string, next: string): string {
  const cleaned = next.replace(/\s+/g, ' ').trim()
  if (!cleaned) return current
  const lines = current
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines[lines.length - 1] !== cleaned) {
    lines.push(cleaned)
  }
  return lines.slice(-8).join('\n')
}

type UseStreamingMessageOptions = {
  onStarted?: (payload: { runId: string | null }) => void
  onChunk?: (text: string, fullText: string) => void
  onComplete?: (message: ChatMessage) => void
  onError?: (error: string) => void
  onThinking?: (thinking: string) => void
  onTool?: (tool: unknown) => void
  onMessageAccepted?: (
    sessionKey: string,
    friendlyId: string,
    clientId: string,
  ) => void
  onSessionResolved?: (payload: {
    sessionKey: string
    friendlyId: string
  }) => void
}

export function useStreamingMessage(options: UseStreamingMessageOptions = {}) {
  const {
    onStarted,
    onChunk,
    onComplete,
    onError,
    onThinking,
    onTool,
    onMessageAccepted,
    onSessionResolved,
  } = options

  const [state, setState] = useState<StreamingState>({
    isStreaming: false,
    streamingMessageId: null,
    streamingText: '',
    error: null,
  })

  const eventSourceRef = useRef<AbortController | null>(null)
  const fullTextRef = useRef<string>('')
  const renderedTextRef = useRef<string>('')
  const targetTextRef = useRef<string>('')
  const frameRef = useRef<number | null>(null)
  const finishedRef = useRef(false)
  const thinkingRef = useRef<string>('')
  const activeRunIdRef = useRef<string | null>(null)
  const activeSessionKeyRef = useRef<string>('main')
  const lifecyclePhaseRef = useRef<StreamLifecyclePhase>('idle')
  const acceptedAtRef = useRef<number | null>(null)
  const lastActivityAtRef = useRef<number | null>(null)
  const handoffTimerRef = useRef<number | null>(null)
  const stepUsageRef = useRef<StepUsagePayload>({})

  const registerSendStreamRun = useChatStore((s) => s.registerSendStreamRun)
  const unregisterSendStreamRun = useChatStore((s) => s.unregisterSendStreamRun)
  const processStoreEvent = useChatStore((s) => s.processEvent)
  const clearStreamingSession = useChatStore((s) => s.clearStreamingSession)

  // Nyx tool calls can take 60-120s (file reads, terminal commands, web searches)
  const ACCEPTED_NO_ACTIVITY_TIMEOUT_MS = 120_000
  const HANDOFF_NO_ACTIVITY_TIMEOUT_MS = 180_000

  const stopFrame = useCallback(() => {
    if (frameRef.current !== null) {
      window.cancelAnimationFrame(frameRef.current)
      frameRef.current = null
    }
  }, [])

  const clearHandoffTimer = useCallback(() => {
    if (handoffTimerRef.current !== null) {
      window.clearTimeout(handoffTimerRef.current)
      handoffTimerRef.current = null
    }
  }, [])

  const clearSendStreamRun = useCallback(() => {
    if (activeRunIdRef.current) {
      unregisterSendStreamRun(activeRunIdRef.current)
      activeRunIdRef.current = null
    }
  }, [unregisterSendStreamRun])

  const resetActiveStreamState = useCallback(
    (nextSessionKey?: string) => {
      stopFrame()
      clearHandoffTimer()
      clearSendStreamRun()
      clearStreamingSession(activeSessionKeyRef.current)
      if (nextSessionKey) {
        activeSessionKeyRef.current = nextSessionKey
      }
      fullTextRef.current = ''
      renderedTextRef.current = ''
      targetTextRef.current = ''
      thinkingRef.current = ''
      stepUsageRef.current = {}
      lifecyclePhaseRef.current = 'idle'
      acceptedAtRef.current = null
      lastActivityAtRef.current = null
      setState({
        isStreaming: false,
        streamingMessageId: null,
        streamingText: '',
        error: null,
      })
    },
    [clearHandoffTimer, clearSendStreamRun, clearStreamingSession, stopFrame],
  )

  const markActivity = useCallback(() => {
    lastActivityAtRef.current = Date.now()
    if (
      lifecyclePhaseRef.current === 'accepted' ||
      lifecyclePhaseRef.current === 'requesting' ||
      lifecyclePhaseRef.current === 'handoff'
    ) {
      lifecyclePhaseRef.current = 'active'
    }
  }, [])

  const markAccepted = useCallback(() => {
    const now = Date.now()
    acceptedAtRef.current = now
    lastActivityAtRef.current = now
    lifecyclePhaseRef.current = 'accepted'
  }, [])

  const markFailed = useCallback(
    (message: string) => {
      if (finishedRef.current) return
      finishedRef.current = true
      eventSourceRef.current = null
      stopFrame()
      lifecyclePhaseRef.current = 'error'
      clearHandoffTimer()
      clearSendStreamRun()
      clearStreamingSession(activeSessionKeyRef.current)
      setState((prev) => ({
        ...prev,
        isStreaming: false,
        error: message,
      }))
      onError?.(message)
    },
    [
      clearHandoffTimer,
      clearSendStreamRun,
      clearStreamingSession,
      onError,
      stopFrame,
    ],
  )

  const schedulePostAcceptanceTimeout = useCallback(
    (reason: 'accepted' | 'handoff') => {
      clearHandoffTimer()
      const timeoutMs =
        reason === 'handoff'
          ? HANDOFF_NO_ACTIVITY_TIMEOUT_MS
          : ACCEPTED_NO_ACTIVITY_TIMEOUT_MS
      handoffTimerRef.current = window.setTimeout(() => {
        if (finishedRef.current) return
        if (
          lifecyclePhaseRef.current !== 'accepted' &&
          lifecyclePhaseRef.current !== 'handoff'
        ) {
          return
        }
        if (reason === 'handoff') {
          const store = useChatStore.getState()
          const streamingState =
            store.streamingState.get(activeSessionKeyRef.current) ?? null
          const lastEventTimestamp = store.lastEventAt
          if (
            streamingState !== null ||
            (lastEventTimestamp > 0 &&
              Date.now() - lastEventTimestamp < timeoutMs)
          ) {
            schedulePostAcceptanceTimeout(reason)
            return
          }
        }
        const lastActivityAt =
          lastActivityAtRef.current ?? acceptedAtRef.current
        if (lastActivityAt && Date.now() - lastActivityAt < timeoutMs - 250) {
          schedulePostAcceptanceTimeout(reason)
          return
        }
        lifecyclePhaseRef.current = 'handoff'
        clearSendStreamRun()
        clearHandoffTimer()
        stopFrame()
        setState((prev) => ({
          ...prev,
          isStreaming: false,
        }))
      }, timeoutMs)
    },
    [clearHandoffTimer, clearSendStreamRun, stopFrame],
  )

  const transitionToHandoff = useCallback(() => {
    if (finishedRef.current) return
    lifecyclePhaseRef.current = 'handoff'
    clearSendStreamRun()
    clearHandoffTimer()
    stopFrame()
    setState((prev) => ({
      ...prev,
      isStreaming: false,
    }))
    schedulePostAcceptanceTimeout('handoff')
  }, [
    clearHandoffTimer,
    clearSendStreamRun,
    schedulePostAcceptanceTimeout,
    stopFrame,
  ])

  useEffect(
    function cleanupStreamingOnUnmount() {
      return function cleanup() {
        if (eventSourceRef.current) {
          eventSourceRef.current.abort()
          eventSourceRef.current = null
        }
        finishedRef.current = true
        resetActiveStreamState()
      }
    },
    [resetActiveStreamState],
  )

  const pushTargetText = useCallback(
    (target: string) => {
      fullTextRef.current = target
      targetTextRef.current = target

      if (
        renderedTextRef.current.length > target.length ||
        !target.startsWith(renderedTextRef.current)
      ) {
        renderedTextRef.current = ''
      }

      if (frameRef.current !== null) return

      const tick = () => {
        const current = renderedTextRef.current
        const nextTarget = targetTextRef.current

        if (current === nextTarget) {
          frameRef.current = null
          return
        }

        const remaining = nextTarget.length - current.length
        const step = remaining > 48 ? Math.ceil(remaining / 6) : 1
        const nextLength = Math.min(nextTarget.length, current.length + step)
        const nextText = nextTarget.slice(0, nextLength)
        const delta = nextText.slice(current.length)

        renderedTextRef.current = nextText
        setState((prev) => ({
          ...prev,
          streamingText: nextText,
        }))

        if (delta) {
          onChunk?.(delta, nextText)
        }

        frameRef.current = window.requestAnimationFrame(tick)
      }

      frameRef.current = window.requestAnimationFrame(tick)
    },
    [onChunk],
  )

  const finishStream = useCallback(
    (payload?: unknown) => {
      if (finishedRef.current) return
      finishedRef.current = true
      eventSourceRef.current = null
      stopFrame()
      lifecyclePhaseRef.current = 'complete'
      clearHandoffTimer()
      clearSendStreamRun()

      const finalText = fullTextRef.current
      const thinking = thinkingRef.current
      renderedTextRef.current = finalText
      targetTextRef.current = finalText

      setState((prev) => ({
        ...prev,
        isStreaming: false,
        streamingText: finalText,
      }))

      const message: ChatMessage = {
        role: 'assistant',
        content: [
          ...(thinking ? [{ type: 'thinking' as const, thinking }] : []),
          { type: 'text' as const, text: finalText },
        ],
        timestamp: Date.now(),
        __streamingStatus: 'complete',
        ...stepUsageRef.current,
        ...(payload as Record<string, unknown>),
      }

      onComplete?.(message)
    },
    [clearHandoffTimer, clearSendStreamRun, onComplete, stopFrame],
  )

  const processEvent = useCallback(
    (event: string, data: unknown) => {
      const payload = data as Record<string, unknown>

      switch (event) {
        case 'started': {
          const resolvedSessionKey =
            typeof payload.sessionKey === 'string' && payload.sessionKey.trim()
              ? payload.sessionKey.trim()
              : activeSessionKeyRef.current
          const resolvedFriendlyId =
            typeof payload.friendlyId === 'string' && payload.friendlyId.trim()
              ? payload.friendlyId.trim()
              : resolvedSessionKey
          if (resolvedSessionKey !== activeSessionKeyRef.current) {
            activeSessionKeyRef.current = resolvedSessionKey
            onSessionResolved?.({
              sessionKey: resolvedSessionKey,
              friendlyId: resolvedFriendlyId,
            })
          }
          // Register runId so chat-events skips duplicate chunks for this run
          const runId = payload.runId as string | undefined
          if (runId) {
            activeRunIdRef.current = runId
            registerSendStreamRun(runId)
          }
          markActivity()
          pushActivity({
            type: 'assistant_start',
            time: new Date().toLocaleTimeString(),
            text: 'Assistant started',
          })
          processStoreEvent({
            type: 'chunk',
            text: '',
            runId: runId ?? undefined,
            sessionKey: activeSessionKeyRef.current,
            transport: 'send-stream',
          })
          onStarted?.({ runId: runId ?? null })
          break
        }
        case 'assistant': {
          const text = (payload as { text?: string }).text ?? ''
          if (text) {
            markActivity()
            processStoreEvent({
              type: 'chunk',
              text,
              runId: activeRunIdRef.current ?? undefined,
              sessionKey: activeSessionKeyRef.current,
              transport: 'send-stream',
            })
            pushTargetText(text)
          }
          break
        }
        case 'chunk': {
          const chunk = payload as StreamChunk
          const fullReplace =
            (chunk as Record<string, unknown>).fullReplace === true
          const newText =
            chunk.delta ?? chunk.text ?? chunk.content ?? chunk.chunk ?? ''
          if (newText) {
            markActivity()
            const accumulated = fullReplace
              ? newText
              : fullTextRef.current + newText
            pushTargetText(accumulated)
            processStoreEvent({
              type: 'chunk',
              text: accumulated,
              fullReplace: true,
              runId: activeRunIdRef.current ?? undefined,
              sessionKey: activeSessionKeyRef.current,
              transport: 'send-stream',
            })
          }
          break
        }
        case 'thinking': {
          const thinking =
            (payload as { text?: string; thinking?: string }).text ??
            (payload as { thinking?: string }).thinking ??
            ''
          if (thinking) {
            markActivity()
            const thinkingProgress = appendThinkingProgress(
              thinkingRef.current,
              thinking,
            )
            thinkingRef.current = thinkingProgress
            pushActivity({
              type: 'progress',
              time: new Date().toLocaleTimeString(),
              text: thinking,
            })
            processStoreEvent({
              type: 'thinking',
              text: thinkingProgress,
              runId: activeRunIdRef.current ?? undefined,
              sessionKey: activeSessionKeyRef.current,
              transport: 'send-stream',
            })
            onThinking?.(thinkingProgress)
          }
          break
        }
        case 'status':
        case 'lifecycle': {
          const text = (payload as { text?: string }).text ?? ''
          if (text) {
            markActivity()
            pushActivity({
              type: 'progress',
              time: new Date().toLocaleTimeString(),
              text,
            })
            processStoreEvent({
              type: event as 'status' | 'lifecycle',
              text,
              runId: activeRunIdRef.current ?? undefined,
              sessionKey: activeSessionKeyRef.current,
              transport: 'send-stream',
            })
          }
          break
        }
        case 'tool': {
          markActivity()
          {
            const toolName =
              typeof payload.name === 'string' ? payload.name : 'tool'
            const phase =
              typeof payload.phase === 'string' ? payload.phase : 'calling'
            const isMemory = /memory|remember|recall|save_memory/i.test(
              toolName,
            )
            const isFileWrite = /^(write_file|write|edit|Edit|Write)$/i.test(
              toolName,
            )
            const isFileRead = /^(read_file|read|Read|search_files)$/i.test(
              toolName,
            )
            const eventType = isMemory
              ? 'memory_write'
              : isFileWrite
                ? 'file_write'
                : isFileRead
                  ? 'file_read'
                  : 'tool_call'
            pushActivity({
              type: eventType,
              time: new Date().toLocaleTimeString(),
              text: `${toolName} (${phase})`,
            })
          }
          processStoreEvent({
            type: 'tool',
            phase:
              typeof payload.phase === 'string' ? payload.phase : 'calling',
            name: typeof payload.name === 'string' ? payload.name : 'tool',
            toolCallId:
              typeof payload.toolCallId === 'string'
                ? payload.toolCallId
                : undefined,
            args: payload.args,
            preview:
              typeof payload.preview === 'string' ? payload.preview : undefined,
            result:
              typeof payload.result === 'string' ? payload.result : undefined,
            runId: activeRunIdRef.current ?? undefined,
            sessionKey: activeSessionKeyRef.current,
            transport: 'send-stream',
          })
          onTool?.(payload)
          break
        }
        case 'artifact': {
          markActivity()
          const title =
            typeof payload.title === 'string' && payload.title.trim()
              ? payload.title.trim()
              : 'Artifact created'
          const kind =
            typeof payload.kind === 'string' && payload.kind.trim()
              ? payload.kind.trim()
              : 'artifact'
          const path =
            typeof payload.path === 'string' && payload.path.trim()
              ? payload.path.trim()
              : ''
          pushActivity({
            type: 'artifact',
            time: new Date().toLocaleTimeString(),
            text: path ? `${title} — ${path}` : title,
          })
          processStoreEvent({
            type: 'tool',
            phase: 'complete',
            name: `artifact:${kind}`,
            result: path ? `${title} — ${path}` : title,
            runId: activeRunIdRef.current ?? undefined,
            sessionKey: activeSessionKeyRef.current,
            transport: 'send-stream',
          })
          break
        }
        case 'step': {
          const nextUsage: StepUsagePayload = {
            inputTokens:
              typeof payload.inputTokens === 'number'
                ? payload.inputTokens
                : stepUsageRef.current.inputTokens,
            outputTokens:
              typeof payload.outputTokens === 'number'
                ? payload.outputTokens
                : stepUsageRef.current.outputTokens,
            cacheRead:
              typeof payload.cacheRead === 'number'
                ? payload.cacheRead
                : stepUsageRef.current.cacheRead,
            cacheWrite:
              typeof payload.cacheWrite === 'number'
                ? payload.cacheWrite
                : stepUsageRef.current.cacheWrite,
            contextPercent:
              typeof payload.contextPercent === 'number'
                ? payload.contextPercent
                : stepUsageRef.current.contextPercent,
            model:
              typeof payload.model === 'string'
                ? payload.model
                : stepUsageRef.current.model,
          }
          stepUsageRef.current = nextUsage
          break
        }
        case 'done': {
          const doneState = (payload as { state?: string }).state
          const errorMessage = (payload as { errorMessage?: string })
            .errorMessage
          pushActivity({
            type: 'assistant_complete',
            time: new Date().toLocaleTimeString(),
            text: doneState === 'error' ? `Error: ${errorMessage}` : 'Complete',
          })
          processStoreEvent({
            type: 'done',
            state: doneState ?? 'final',
            errorMessage,
            message: payload.message as Record<string, unknown> | undefined,
            runId: activeRunIdRef.current ?? undefined,
            sessionKey: activeSessionKeyRef.current,
            transport: 'send-stream',
          })
          if (doneState === 'error' && errorMessage) {
            markFailed(errorMessage)
            break
          }
          finishStream(payload)
          break
        }
        case 'complete': {
          finishStream(payload)
          break
        }
        case 'error': {
          // Ignore late error events after stream already completed or finished
          if (
            finishedRef.current ||
            lifecyclePhaseRef.current === 'complete' ||
            lifecyclePhaseRef.current === 'idle' ||
            lifecyclePhaseRef.current === 'error'
          ) {
            break
          }
          const errorMessage =
            (payload as { message?: string }).message ?? 'Stream error'
          markFailed(errorMessage)
          break
        }
        case 'timeout': {
          if (
            lifecyclePhaseRef.current === 'accepted' ||
            lifecyclePhaseRef.current === 'active' ||
            lifecyclePhaseRef.current === 'handoff'
          ) {
            transitionToHandoff()
          } else {
            markFailed('Request timed out')
          }
          break
        }
        case 'close': {
          if (fullTextRef.current) {
            finishStream()
          } else if (
            lifecyclePhaseRef.current === 'accepted' ||
            lifecyclePhaseRef.current === 'active' ||
            lifecyclePhaseRef.current === 'handoff'
          ) {
            transitionToHandoff()
          } else {
            markFailed(`${WORKSPACE_AGENT_NAME} connection closed`)
          }
          break
        }
      }
    },
    [
      finishStream,
      markFailed,
      onStarted,
      onSessionResolved,
      onThinking,
      onTool,
      markActivity,
      processStoreEvent,
      pushTargetText,
      registerSendStreamRun,
      transitionToHandoff,
    ],
  )

  const startStreaming = useCallback(
    async (params: {
      sessionKey: string
      friendlyId: string
      message: string
      history?: Array<PortableHistoryMessage>
      thinking?: string
      conversationMode?: 'quick' | 'task' | 'build' | 'deep'
      fastMode?: boolean
      attachments?: Array<ChatAttachment>
      idempotencyKey?: string
      model?: string
    }) => {
      if (eventSourceRef.current) {
        eventSourceRef.current.abort()
      }

      const abortController = new AbortController()
      eventSourceRef.current = abortController
      finishedRef.current = false
      resetActiveStreamState(params.sessionKey)
      lifecyclePhaseRef.current = 'requesting'

      const messageId = `streaming-${Date.now()}`

      setState({
        isStreaming: true,
        streamingMessageId: messageId,
        streamingText: '',
        error: null,
      })

      try {
        const response = await fetch('/api/send-stream', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            sessionKey: params.sessionKey,
            friendlyId: params.friendlyId,
            message: params.message,
            history: params.history,
            thinking: params.thinking,
            conversationMode: params.conversationMode,
            fastMode: params.fastMode,
            attachments: params.attachments,
            idempotencyKey: params.idempotencyKey ?? crypto.randomUUID(),
            model: params.model || undefined,
            locale:
              typeof window !== 'undefined'
                ? localStorage.getItem('nyx-workspace-locale') ||
                  localStorage.getItem('hermes-workspace-locale') ||
                  'en'
                : 'en',
          }),
          signal: abortController.signal,
        })

        if (!response.ok) {
          const errorText = await response.text()
          throw new Error(errorText || 'Stream request failed')
        }

        const resolvedSessionKey =
          response.headers.get('x-nyx-session-key')?.trim() ||
          response.headers.get('x-hermes-session-key')?.trim() ||
          params.sessionKey
        const resolvedFriendlyId =
          response.headers.get('x-nyx-friendly-id')?.trim() ||
          response.headers.get('x-hermes-friendly-id')?.trim() ||
          resolvedSessionKey
        if (resolvedSessionKey !== activeSessionKeyRef.current) {
          activeSessionKeyRef.current = resolvedSessionKey
          onSessionResolved?.({
            sessionKey: resolvedSessionKey,
            friendlyId: resolvedFriendlyId,
          })
        }

        markAccepted()
        schedulePostAcceptanceTimeout('accepted')

        // HTTP 200 — message accepted by Nyx. Clear optimistic "sending"
        // status so the Retry timer never fires. Nyx does NOT echo
        // user messages via SSE, so this is the only confirmation we get.
        if (params.idempotencyKey && onMessageAccepted) {
          onMessageAccepted(
            activeSessionKeyRef.current,
            activeSessionKeyRef.current,
            params.idempotencyKey,
          )
        }

        const reader = response.body?.getReader()
        if (!reader) {
          throw new Error('No response body')
        }

        const decoder = new TextDecoder()
        const parser = createSseParser(({ event, data }) => {
          if (!event || !data) return
          try {
            processEvent(event, JSON.parse(data))
          } catch {
            // Ignore invalid SSE data.
          }
        })

        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- runtime safety
        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          parser.push(decoder.decode(value, { stream: true }))
        }
        parser.push(decoder.decode())
        parser.finish()

        const lifecyclePhase = lifecyclePhaseRef.current as StreamLifecyclePhase
        if (!finishedRef.current && lifecyclePhase !== 'handoff') {
          finishStream()
        }
      } catch (err) {
        if ((err as Error).name === 'AbortError') return
        const errorMessage = err instanceof Error ? err.message : String(err)
        markFailed(errorMessage)
      }
    },
    [
      finishStream,
      markAccepted,
      markFailed,
      onMessageAccepted,
      onSessionResolved,
      processEvent,
      resetActiveStreamState,
      schedulePostAcceptanceTimeout,
    ],
  )

  const cancelStreaming = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.abort()
      eventSourceRef.current = null
    }
    finishedRef.current = true
    resetActiveStreamState()
  }, [resetActiveStreamState])

  const resetStreaming = useCallback(() => {
    cancelStreaming()
    setState({
      isStreaming: false,
      streamingMessageId: null,
      streamingText: '',
      error: null,
    })
  }, [cancelStreaming])

  return {
    ...state,
    startStreaming,
    cancelStreaming,
    resetStreaming,
  }
}

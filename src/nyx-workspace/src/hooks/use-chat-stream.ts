import { useCallback, useEffect, useRef, useState } from 'react'
import {
  useChatStore,
  type ChatStreamEvent,
  type StreamingState,
} from '../stores/chat-store'
import type { ChatMessage } from '../screens/chat/types'

type UseChatStreamOptions = {
  sessionKey?: string
  enabled?: boolean
  onReconnect?: () => void
  onSilentTimeout?: (ms: number) => void
  onUserMessage?: (message: any, source?: string) => void
  onApprovalRequest?: (approval: Record<string, unknown>) => void
  onCompactionStart?: () => void
  onCompactionEnd?: () => void
  onCompaction?: (...args: Array<any>) => void
  onDone?: (
    state: string,
    sessionKey: string,
    streamingSnapshot: StreamingState | null,
  ) => void
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : null
}

function readString(value: unknown): string {
  return typeof value === 'string' && value.trim().length > 0
    ? value.trim()
    : ''
}

export function chatEventToStoreEvent(
  event: string,
  data: unknown,
  fallbackSessionKey?: string,
): ChatStreamEvent | null {
  const payload = readRecord(data)
  if (!payload) return null

  const sessionKey = readString(payload.sessionKey) || fallbackSessionKey || ''
  if (!sessionKey) return null

  const runId = readString(payload.runId) || undefined

  switch (event) {
    case 'message': {
      const message = readRecord(payload.message)
      if (!message) return null
      return {
        type: 'message',
        message: message as unknown as ChatMessage,
        sessionKey,
        runId,
        transport: 'chat-events',
      }
    }
    case 'user_message': {
      const message = readRecord(payload.message)
      if (!message) return null
      return {
        type: 'user_message',
        message: message as unknown as ChatMessage,
        source: readString(payload.source) || undefined,
        sessionKey,
        runId,
        transport: 'chat-events',
      }
    }
    case 'chunk': {
      const text = readString(payload.text)
      if (!text) return null
      return {
        type: 'chunk',
        text,
        fullReplace: payload.fullReplace === true,
        sessionKey,
        runId,
        transport: 'chat-events',
      }
    }
    case 'thinking': {
      const text = readString(payload.text) || readString(payload.thinking)
      if (!text) return null
      return {
        type: 'thinking',
        text,
        sessionKey,
        runId,
        transport: 'chat-events',
      }
    }
    case 'status':
    case 'lifecycle': {
      const text = readString(payload.text)
      if (!text) return null
      return {
        type: event,
        text,
        sessionKey,
        runId,
        transport: 'chat-events',
      }
    }
    case 'tool': {
      const name = readString(payload.name) || 'tool'
      return {
        type: 'tool',
        phase: readString(payload.phase) || 'calling',
        name,
        toolCallId: readString(payload.toolCallId) || undefined,
        args: payload.args,
        preview: readString(payload.preview) || undefined,
        result: readString(payload.result) || undefined,
        sessionKey,
        runId,
        transport: 'chat-events',
      }
    }
    case 'artifact': {
      const kind = readString(payload.kind) || 'artifact'
      const title = readString(payload.title) || 'Artifact created'
      const artifactPath = readString(payload.path)
      return {
        type: 'tool',
        phase: 'complete',
        name: `artifact:${kind}`,
        result: artifactPath ? `${title} - ${artifactPath}` : title,
        sessionKey,
        runId,
        transport: 'chat-events',
      }
    }
    case 'done': {
      const state = readString(payload.state) || 'complete'
      const message = readRecord(payload.message)
      return {
        type: 'done',
        state,
        errorMessage: readString(payload.errorMessage) || undefined,
        message: message
          ? (message as unknown as ChatMessage)
          : undefined,
        sessionKey,
        runId,
        transport: 'chat-events',
      }
    }
    case 'error': {
      return {
        type: 'done',
        state: 'error',
        errorMessage:
          readString(payload.errorMessage) ||
          readString(payload.message) ||
          'Stream error',
        sessionKey,
        runId,
        transport: 'chat-events',
      }
    }
    default:
      return null
  }
}

export function useChatStream(opts: UseChatStreamOptions) {
  const {
    sessionKey,
    enabled = true,
    onReconnect,
    onSilentTimeout: _onSilentTimeout,
    onUserMessage,
    onApprovalRequest: _onApprovalRequest,
    onCompactionStart: _onCompactionStart,
    onCompactionEnd: _onCompactionEnd,
    onCompaction: _onCompaction,
    onDone,
  } = opts
  const connectionState = useChatStore((s) => s.connectionState)
  const lastError = useChatStore((s) => s.lastError)
  const processStoreEvent = useChatStore((s) => s.processEvent)
  const setConnectionState = useChatStore((s) => s.setConnectionState)
  const getStreamingState = useChatStore((s) => s.getStreamingState)
  const callbacksRef = useRef({ onDone, onReconnect, onUserMessage })
  const [reconnectNonce, setReconnectNonce] = useState(0)

  callbacksRef.current = { onDone, onReconnect, onUserMessage }

  useEffect(() => {
    if (!enabled || !sessionKey || sessionKey === 'new') return undefined
    if (typeof EventSource === 'undefined') {
      setConnectionState('error', 'EventSource unavailable')
      return undefined
    }

    const query = new URLSearchParams({ sessionKey })
    const source = new EventSource(`/api/chat-events?${query.toString()}`)
    const handledEvents = [
      'message',
      'user_message',
      'chunk',
      'thinking',
      'status',
      'lifecycle',
      'tool',
      'artifact',
      'done',
      'error',
    ] as const

    const handleConnected = () => {
      setConnectionState('connected')
      callbacksRef.current.onReconnect?.()
    }

    const handleEvent = (messageEvent: MessageEvent) => {
      const eventType = messageEvent.type
      let payload: unknown
      try {
        payload = JSON.parse(messageEvent.data)
      } catch {
        return
      }

      const storeEvent = chatEventToStoreEvent(eventType, payload, sessionKey)
      if (!storeEvent) return

      const streamingSnapshot =
        storeEvent.type === 'done'
          ? getStreamingState(storeEvent.sessionKey)
          : null
      processStoreEvent(storeEvent)

      if (storeEvent.type === 'user_message') {
        callbacksRef.current.onUserMessage?.(
          storeEvent.message,
          storeEvent.source,
        )
      }
      if (storeEvent.type === 'done') {
        callbacksRef.current.onDone?.(
          storeEvent.state,
          storeEvent.sessionKey,
          streamingSnapshot,
        )
      }
    }

    const handleError = () => {
      setConnectionState('error', 'Chat event stream disconnected')
    }

    setConnectionState('connecting')
    source.addEventListener('connected', handleConnected)
    source.onerror = handleError
    for (const event of handledEvents) {
      source.addEventListener(event, handleEvent)
    }

    return () => {
      source.removeEventListener('connected', handleConnected)
      for (const event of handledEvents) {
        source.removeEventListener(event, handleEvent)
      }
      source.close()
      setConnectionState('disconnected')
    }
  }, [
    enabled,
    getStreamingState,
    processStoreEvent,
    reconnectNonce,
    sessionKey,
    setConnectionState,
  ])

  const reconnect = useCallback(() => {
    setReconnectNonce((value) => value + 1)
  }, [])

  return {
    connectionState,
    lastError,
    reconnect,
  }
}

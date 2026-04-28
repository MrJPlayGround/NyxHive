import type { ChatAttachment, ChatMessage } from './types'

export type UiSlashCommandAction =
  | {
      kind: 'navigate'
      to: '/chat/$sessionKey'
      params: { sessionKey: 'new' }
    }
  | {
      kind: 'navigate'
      to: '/skills'
    }
  | {
      kind: 'settings'
      section: 'appearance' | 'nyx'
    }

export type WaitingBaseline = {
  messageCount: number
  lastAssistantId: string | null
}

export type ActiveSubmitBehavior = 'send' | 'queue' | 'steer'

export function decideActiveSubmitBehavior(input: {
  sessionBusy: boolean
  hasQueuedFollowup: boolean
}): ActiveSubmitBehavior {
  if (!input.sessionBusy) return 'send'
  return input.hasQueuedFollowup ? 'steer' : 'queue'
}

export function resolveUiSlashCommandAction(
  command: string,
): UiSlashCommandAction | null {
  switch (command.trim()) {
    case '/new':
      return {
        kind: 'navigate',
        to: '/chat/$sessionKey',
        params: { sessionKey: 'new' },
      }
    case '/skills':
      return { kind: 'navigate', to: '/skills' }
    case '/model':
      return { kind: 'settings', section: 'nyx' }
    case '/skin':
      return { kind: 'settings', section: 'appearance' }
    default:
      return null
  }
}

function stableAssistantId(message: ChatMessage): string {
  const raw = message as Record<string, unknown>
  return String(
    raw.__optimisticId ??
      raw.id ??
      raw.messageId ??
      raw.__realtimeSequence ??
      '',
  )
}

export function captureWaitingBaseline(
  messages: Array<ChatMessage>,
): WaitingBaseline {
  const lastAssistant = [...messages]
    .reverse()
    .find((message) => message.role === 'assistant')

  return {
    messageCount: messages.length,
    lastAssistantId: lastAssistant ? stableAssistantId(lastAssistant) : null,
  }
}

export function nextWaitingBaseline(input: {
  current: WaitingBaseline
  messages: Array<ChatMessage>
  waitingForResponse: boolean
  wasWaitingForResponse: boolean
}): WaitingBaseline {
  if (!input.waitingForResponse || !input.wasWaitingForResponse) {
    return captureWaitingBaseline(input.messages)
  }

  const last = input.messages[input.messages.length - 1]
  if (!last || last.role !== 'assistant') {
    return captureWaitingBaseline(input.messages)
  }

  return input.current
}

export function shouldFinishWaitingForAssistant(
  messages: Array<ChatMessage>,
  baseline: WaitingBaseline,
): boolean {
  const last = messages[messages.length - 1]
  if (!last || last.role !== 'assistant') return false
  if (last.__streamingStatus === 'streaming') return false

  const currentAssistantId = stableAssistantId(last)
  return (
    messages.length > baseline.messageCount ||
    baseline.lastAssistantId === null ||
    (currentAssistantId.length > 0 &&
      currentAssistantId !== baseline.lastAssistantId)
  )
}

type OptimisticMessagePayload = {
  clientId: string
  optimisticId: string
  optimisticMessage: ChatMessage
}

export type DeferredNewChatSend = OptimisticMessagePayload & {
  threadId: string
  pendingSend: {
    sessionKey: string
    friendlyId: string
    message: string
    attachments: Array<ChatAttachment>
    optimisticMessage: ChatMessage
  }
}

export function createOptimisticMessage(
  body: string,
  attachments: Array<ChatAttachment> = [],
): OptimisticMessagePayload {
  const clientId = crypto.randomUUID()
  const optimisticId = `opt-${clientId}`
  const timestamp = Date.now()
  const textContent =
    body.length > 0 ? [{ type: 'text' as const, text: body }] : []

  const optimisticMessage: ChatMessage = {
    role: 'user',
    content: textContent.length > 0 ? textContent : undefined,
    attachments: attachments.length > 0 ? attachments : undefined,
    __optimisticId: optimisticId,
    __createdAt: timestamp,
    clientId,
    client_id: clientId,
    status: 'sending',
    timestamp,
  }

  return { clientId, optimisticId, optimisticMessage }
}

export function createDeferredNewChatSend(input: {
  body: string
  attachments: Array<ChatAttachment>
  portableMode: boolean
  threadId?: string
}): DeferredNewChatSend {
  const threadId = input.portableMode
    ? 'main'
    : input.threadId || crypto.randomUUID()
  const { clientId, optimisticId, optimisticMessage } = createOptimisticMessage(
    input.body,
    input.attachments,
  )

  return {
    threadId,
    clientId,
    optimisticId,
    optimisticMessage,
    pendingSend: {
      sessionKey: threadId,
      friendlyId: threadId,
      message: input.body,
      attachments: input.attachments,
      optimisticMessage,
    },
  }
}

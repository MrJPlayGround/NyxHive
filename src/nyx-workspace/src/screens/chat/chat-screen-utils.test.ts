import { describe, expect, test } from 'bun:test'

import {
  captureWaitingBaseline,
  createDeferredNewChatSend,
  decideActiveSubmitBehavior,
  nextWaitingBaseline,
  resolveUiSlashCommandAction,
  shouldFinishWaitingForAssistant,
} from './chat-screen-utils'
import type { ChatMessage } from './types'

const user = (text: string): ChatMessage => ({
  role: 'user',
  content: [{ type: 'text', text }],
})

const assistant = (id: string, text: string): ChatMessage =>
  ({
    role: 'assistant',
    id,
    content: [{ type: 'text', text }],
  }) as ChatMessage

describe('chat screen waiting baseline', () => {
  test('keeps the send baseline stable while waiting so a new assistant clears thinking state', () => {
    const baseline = captureWaitingBaseline([user('go for it')])
    const messagesAfterResponse = [
      user('go for it'),
      assistant('answer-1', 'Done.'),
    ]
    const nextBaseline = nextWaitingBaseline({
      current: baseline,
      messages: messagesAfterResponse,
      waitingForResponse: true,
      wasWaitingForResponse: true,
    })

    expect(
      shouldFinishWaitingForAssistant(messagesAfterResponse, nextBaseline),
    ).toBe(true)
  })

  test('can advance the baseline to include the optimistic user message before an assistant arrives', () => {
    const baseline = captureWaitingBaseline([])
    const nextBaseline = nextWaitingBaseline({
      current: baseline,
      messages: [user('go for it')],
      waitingForResponse: true,
      wasWaitingForResponse: true,
    })

    expect(nextBaseline.messageCount).toBe(1)
    expect(nextBaseline.lastAssistantId).toBeNull()
  })

  test('does not finish waiting for the same assistant that existed before the send', () => {
    const existingMessages = [
      user('previous'),
      assistant('answer-0', 'Previous answer.'),
    ]
    const baseline = captureWaitingBaseline(existingMessages)

    expect(shouldFinishWaitingForAssistant(existingMessages, baseline)).toBe(
      false,
    )
  })
})

describe('chat screen slash commands', () => {
  test('routes /new directly to the empty new chat session', () => {
    expect(resolveUiSlashCommandAction('/new')).toEqual({
      kind: 'navigate',
      to: '/chat/$sessionKey',
      params: { sessionKey: 'new' },
    })
  })

  test('does not treat slash-prefixed prose as a local workspace command', () => {
    expect(resolveUiSlashCommandAction('/new Hi')).toBeNull()
  })
})

describe('active submit behavior', () => {
  test('sends immediately when the session is idle', () => {
    expect(
      decideActiveSubmitBehavior({
        sessionBusy: false,
        hasQueuedFollowup: false,
      }),
    ).toBe('send')
  })

  test('queues the first submit while a session is busy', () => {
    expect(
      decideActiveSubmitBehavior({
        sessionBusy: true,
        hasQueuedFollowup: false,
      }),
    ).toBe('queue')
  })

  test('escalates a second busy submit to steer instead of opening another send', () => {
    expect(
      decideActiveSubmitBehavior({
        sessionBusy: true,
        hasQueuedFollowup: true,
      }),
    ).toBe('steer')
  })
})

describe('new chat send handoff', () => {
  test('defers the first send until the routed session is mounted', () => {
    const attachment = {
      id: 'file-1',
      name: 'notes.txt',
      contentType: 'text/plain',
      dataUrl: 'hello',
      size: 5,
    }

    const deferred = createDeferredNewChatSend({
      body: 'Ship it',
      attachments: [attachment],
      portableMode: false,
      threadId: 'thread-123',
    })

    expect(deferred.threadId).toBe('thread-123')
    expect(deferred.pendingSend).toMatchObject({
      sessionKey: 'thread-123',
      friendlyId: 'thread-123',
      message: 'Ship it',
      attachments: [attachment],
    })
    expect(deferred.clientId).toBeTruthy()
    expect(deferred.optimisticMessage.clientId).toBe(deferred.clientId)
    expect(deferred.optimisticMessage.__optimisticId).toBe(
      `opt-${deferred.clientId}`,
    )
  })

  test('uses the portable main session when workspace sessions are disabled', () => {
    const deferred = createDeferredNewChatSend({
      body: 'Portable',
      attachments: [],
      portableMode: true,
      threadId: 'ignored-thread',
    })

    expect(deferred.threadId).toBe('main')
    expect(deferred.pendingSend.sessionKey).toBe('main')
    expect(deferred.pendingSend.friendlyId).toBe('main')
  })
})

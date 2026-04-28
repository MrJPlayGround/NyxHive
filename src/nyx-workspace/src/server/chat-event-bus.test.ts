import { describe, expect, test } from 'bun:test'
import {
  publishChatEvent,
  subscribeToChatEvents,
} from './chat-event-bus'
import {
  registerActiveSendRun,
  unregisterActiveSendRun,
} from './send-run-tracker'

describe('chat event bus', () => {
  test('fans out active send run events for sibling views', () => {
    const received: Array<Record<string, unknown>> = []
    const unsubscribe = subscribeToChatEvents((event) => {
      received.push(event.data)
    }, 'session-a')

    registerActiveSendRun('run-a')
    try {
      publishChatEvent('thinking', {
        sessionKey: 'session-a',
        runId: 'run-a',
        text: 'Running rg',
      })
    } finally {
      unregisterActiveSendRun('run-a')
      unsubscribe()
    }

    expect(received).toEqual([
      {
        sessionKey: 'session-a',
        runId: 'run-a',
        text: 'Running rg',
      },
    ])
  })
})

import { describe, expect, test } from 'bun:test'
import { chatEventToStoreEvent } from './use-chat-stream'

describe('chatEventToStoreEvent', () => {
  test('maps lifecycle events without treating them as message thinking', () => {
    expect(
      chatEventToStoreEvent('lifecycle', {
        sessionKey: 'session-a',
        runId: 'run-a',
        text: 'Running rg',
      }),
    ).toEqual({
      type: 'lifecycle',
      sessionKey: 'session-a',
      runId: 'run-a',
      text: 'Running rg',
      transport: 'chat-events',
    })
  })

  test('maps shared thinking events into streaming lifecycle events', () => {
    expect(
      chatEventToStoreEvent('thinking', {
        sessionKey: 'session-a',
        runId: 'run-a',
        text: 'Running rg',
      }),
    ).toEqual({
      type: 'thinking',
      sessionKey: 'session-a',
      runId: 'run-a',
      text: 'Running rg',
      transport: 'chat-events',
    })
  })

  test('maps shared tool events into streaming tool events', () => {
    expect(
      chatEventToStoreEvent('tool', {
        sessionKey: 'session-a',
        runId: 'run-a',
        phase: 'complete',
        name: 'Command run complete',
        toolCallId: 'run-a:item-1',
        result: 'ok',
      }),
    ).toEqual({
      type: 'tool',
      sessionKey: 'session-a',
      runId: 'run-a',
      phase: 'complete',
      name: 'Command run complete',
      toolCallId: 'run-a:item-1',
      result: 'ok',
      transport: 'chat-events',
    })
  })
})

import { describe, expect, test } from 'bun:test'
import { useChatStore } from '../../../stores/chat-store'
import { applyActiveRunCheckResult } from './use-active-run-check'

describe('active run check reconciliation', () => {
  test('clears restored streaming state when the server reports no active run', () => {
    const store = useChatStore.getState()
    store.clearSession('active-run-done')
    store.setSessionWaiting('active-run-done', 'run-done')
    store.processEvent({
      type: 'chunk',
      sessionKey: 'active-run-done',
      runId: 'run-done',
      text: '',
    })

    expect(store.isSessionWaiting('active-run-done')).toBe(true)
    expect(store.getStreamingState('active-run-done')).not.toBeNull()

    applyActiveRunCheckResult('active-run-done', { ok: true, run: null })

    expect(useChatStore.getState().isSessionWaiting('active-run-done')).toBe(
      false,
    )
    expect(
      useChatStore.getState().getStreamingState('active-run-done'),
    ).toBeNull()
  })

  test('marks the session waiting when the server reports an active run', () => {
    const store = useChatStore.getState()
    store.clearSession('active-run-live')

    applyActiveRunCheckResult('active-run-live', {
      ok: true,
      run: {
        runId: 'run-live',
        status: 'active',
        sessionKey: 'active-run-live',
        startedAt: Date.now(),
      },
    })

    expect(useChatStore.getState().isSessionWaiting('active-run-live')).toBe(
      true,
    )
  })

  test('hydrates persisted active run trace when joining a live session', () => {
    const store = useChatStore.getState()
    store.clearSession('active-run-hydrate')

    applyActiveRunCheckResult('active-run-hydrate', {
      ok: true,
      run: {
        runId: 'run-hydrate',
        status: 'active',
        sessionKey: 'active-run-hydrate',
        startedAt: Date.now(),
        assistantText: 'partial answer',
        thinkingText: '',
        lifecycleEvents: [
          {
            text: 'Running rg',
            emoji: '',
            timestamp: 123,
            isError: false,
          },
        ],
        toolCalls: [
          {
            id: 'run-hydrate:item-1',
            name: 'Command run complete',
            phase: 'complete',
            result: 'ok',
          },
        ],
      },
    })

    expect(
      useChatStore.getState().getStreamingState('active-run-hydrate'),
    ).toEqual({
      runId: 'run-hydrate',
      text: 'partial answer',
      thinking: '',
      lifecycleEvents: [
        {
          text: 'Running rg',
          emoji: '',
          timestamp: 123,
          isError: false,
        },
      ],
      toolCalls: [
        {
          id: 'run-hydrate:item-1',
          name: 'Command run complete',
          phase: 'complete',
          result: 'ok',
        },
      ],
    })
  })

  test('keeps live send-stream tracing when active-run persistence has not caught up yet', () => {
    const store = useChatStore.getState()
    store.clearSession('active-run-race')
    store.registerSendStreamRun('run-race')
    store.setSessionWaiting('active-run-race', 'run-race')
    store.processEvent({
      type: 'chunk',
      sessionKey: 'active-run-race',
      runId: 'run-race',
      text: '',
      transport: 'send-stream',
    })

    applyActiveRunCheckResult('active-run-race', { ok: true, run: null })

    expect(useChatStore.getState().isSessionWaiting('active-run-race')).toBe(
      true,
    )
    expect(
      useChatStore.getState().getStreamingState('active-run-race'),
    ).toMatchObject({ runId: 'run-race' })

    store.unregisterSendStreamRun('run-race')
  })
})

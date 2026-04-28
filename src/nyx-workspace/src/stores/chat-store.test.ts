import { afterEach, describe, expect, test } from 'bun:test'
import { useChatStore } from './chat-store'

const originalSessionStorage = globalThis.sessionStorage

function installSessionStorage() {
  const values = new Map<string, string>()
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    value: {
      get length() {
        return values.size
      },
      key(index: number) {
        return Array.from(values.keys())[index] ?? null
      },
      getItem(key: string) {
        return values.get(key) ?? null
      },
      setItem(key: string, value: string) {
        values.set(key, value)
      },
      removeItem(key: string) {
        values.delete(key)
      },
      clear() {
        values.clear()
      },
    },
  })
}

afterEach(() => {
  useChatStore.getState().clearSession('session-delete')
  useChatStore.getState().clearSession('session-restore')
  useChatStore.getState().clearSession('terminal-session')
  useChatStore.getState().clearSession('stale-session')
  useChatStore.getState().clearSession('portable-dedupe')
  useChatStore.getState().clearSession('send-stream-dedupe')
  if (originalSessionStorage === undefined) {
    delete (globalThis as any).sessionStorage
  } else {
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      value: originalSessionStorage,
    })
  }
})

describe('chat-store waiting lifecycle', () => {
  test('clears waiting state when a terminal event arrives for the session', () => {
    const store = useChatStore.getState()
    store.clearSession('terminal-session')
    store.setSessionWaiting('terminal-session', 'run-terminal')

    store.processEvent({
      type: 'done',
      state: 'complete',
      runId: 'run-terminal',
      sessionKey: 'terminal-session',
    })

    expect(useChatStore.getState().isSessionWaiting('terminal-session')).toBe(
      false,
    )
  })

  test('self-prunes stale waiting state when queried', () => {
    const store = useChatStore.getState()
    store.clearSession('stale-session')
    store.setSessionWaiting('stale-session', 'run-stale')
    useChatStore.setState((state) => ({
      waitingSessionMeta: {
        ...state.waitingSessionMeta,
        'stale-session': {
          since: Date.now() - 121_000,
          runId: 'run-stale',
        },
      },
    }))

    expect(useChatStore.getState().isSessionWaiting('stale-session')).toBe(
      false,
    )
  })

  test('clears every candidate waiting key for a terminal run', () => {
    const store = useChatStore.getState()
    store.clearSessionWaitingForKeys(['new', 'session-1', 'friendly-1'])

    store.setSessionWaiting('new', 'run-1')
    store.setSessionWaiting('session-1', 'run-1')
    store.setSessionWaiting('friendly-1', 'run-1')

    expect(useChatStore.getState().isSessionWaiting('new')).toBe(true)
    expect(useChatStore.getState().isSessionWaiting('session-1')).toBe(true)
    expect(useChatStore.getState().isSessionWaiting('friendly-1')).toBe(true)

    useChatStore
      .getState()
      .clearSessionWaitingForKeys([null, '', 'new', 'session-1', 'friendly-1'])

    expect(useChatStore.getState().isSessionWaiting('new')).toBe(false)
    expect(useChatStore.getState().isSessionWaiting('session-1')).toBe(false)
    expect(useChatStore.getState().isSessionWaiting('friendly-1')).toBe(false)
  })
})

describe('chat-store session cleanup', () => {
  test('clearSession removes realtime, streaming, and waiting state for deleted sessions', () => {
    const store = useChatStore.getState()
    store.clearSession('session-delete')
    store.processEvent({
      type: 'chunk',
      text: 'partial',
      sessionKey: 'session-delete',
      runId: 'run-delete',
    })
    store.processEvent({
      type: 'message',
      sessionKey: 'session-delete',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'hello' }],
      },
    })
    store.setSessionWaiting('session-delete', 'run-delete')

    expect(
      useChatStore.getState().getRealtimeMessages('session-delete'),
    ).toHaveLength(1)
    expect(
      useChatStore.getState().getStreamingState('session-delete'),
    ).not.toBeNull()
    expect(useChatStore.getState().isSessionWaiting('session-delete')).toBe(
      true,
    )

    useChatStore.getState().clearSession('session-delete')

    expect(
      useChatStore.getState().getRealtimeMessages('session-delete'),
    ).toEqual([])
    expect(
      useChatStore.getState().getStreamingState('session-delete'),
    ).toBeNull()
    expect(useChatStore.getState().isSessionWaiting('session-delete')).toBe(
      false,
    )
  })
})

describe('chat-store streaming restoration', () => {
  test('restores recent streaming state from session storage', () => {
    installSessionStorage()
    sessionStorage.setItem(
      'nyx_streaming_session-restore',
      JSON.stringify({
        runId: 'run-restore',
        text: 'partial answer',
        thinking: 'checking context',
        lifecycleEvents: [
          { text: 'Reading files', emoji: '', timestamp: 123, isError: false },
        ],
        toolCalls: [],
        _savedAt: Date.now(),
      }),
    )

    expect(
      useChatStore.getState().getStreamingState('session-restore'),
    ).toBeNull()
    expect(
      useChatStore.getState().restoreStreamingSession('session-restore'),
    ).toBe(true)

    expect(
      useChatStore.getState().getStreamingState('session-restore'),
    ).toEqual({
      runId: 'run-restore',
      text: 'partial answer',
      thinking: 'checking context',
      lifecycleEvents: [
        { text: 'Reading files', emoji: '', timestamp: 123, isError: false },
      ],
      toolCalls: [],
    })
  })
})

describe('chat-store response sanitization', () => {
  test('keeps workflow diary text out of streamed assistant chunks', () => {
    const store = useChatStore.getState()
    store.clearSession('workflow-diary-stream')

    store.processEvent({
      type: 'chunk',
      sessionKey: 'workflow-diary-stream',
      runId: 'run-workflow-diary',
      fullReplace: true,
      text: [
        'Using superpowers:using-superpowers, test-driven-development, and verification-before-completion. I will inspect files.',
        'I am starting with the recent instability surface.',
        'Targeted tests are green. I am running the full suite now.',
        'Fixed: progress diary stays out of chat.',
        'Evidence: full suite passed.',
      ].join('\n'),
    })

    expect(
      useChatStore.getState().getStreamingState('workflow-diary-stream')?.text,
    ).toBe('Fixed: progress diary stays out of chat.\n\nEvidence: full suite passed.')
  })

  test('keeps run-context-prefixed workflow diary text out of streamed assistant chunks', () => {
    const store = useChatStore.getState()
    store.clearSession('workflow-context-diary-stream')

    store.processEvent({
      type: 'chunk',
      sessionKey: 'workflow-context-diary-stream',
      runId: 'run-workflow-context-diary',
      fullReplace: true,
      text: [
        '[Run Context]',
        'Run ID: def9480a-584e-4480-8401-6062e1a4ba7d',
        'Scratchpad: /home/user/dev/nyxhive/.nyxhive/data/scratchpads/def9480a-584e-4480-8401-6062e1a4ba7d',
        'Using superpowers:using-superpowers, test-driven-development, and verification-before-completion. I will inspect files.',
        'I am starting with the recent instability surface.',
        'Targeted tests are green. I am running the full suite now.',
        'Fixed: progress diary stays out of chat.',
        'Evidence: full suite passed.',
      ].join('\n'),
    })

    expect(
      useChatStore.getState().getStreamingState('workflow-context-diary-stream')?.text,
    ).toBe('Fixed: progress diary stays out of chat.\n\nEvidence: full suite passed.')
  })

  test('keeps run-context-prefixed progress text out without skill announcement', () => {
    const store = useChatStore.getState()
    store.clearSession('workflow-context-progress-stream')

    store.processEvent({
      type: 'chunk',
      sessionKey: 'workflow-context-progress-stream',
      runId: 'run-workflow-context-progress',
      fullReplace: true,
      text: [
        '[Current Message]',
        '[Run Context]',
        'Run ID: def9480a-584e-4480-8401-6062e1a4ba7d',
        'Scratchpad: /home/user/dev/nyxhive/.nyxhive/data/scratchpads/def9480a-584e-4480-8401-6062e1a4ba7d',
        'Use the scratchpad for temporary notes, intermediate artifacts, and machine-readable outputs you want preserved with this run.',
        'I’ll fix the reply leak, verify it, and restart the daemon.',
        'The repo is clean at a sanitizer-focused HEAD.',
        'Fixed: run context stays out of chat.',
        'Evidence: targeted test passed.',
      ].join('\n'),
    })

    expect(
      useChatStore.getState().getStreamingState('workflow-context-progress-stream')?.text,
    ).toBe('Fixed: run context stays out of chat.\n\nEvidence: targeted test passed.')
  })
})

describe('chat-store interrupt and dedupe audit', () => {
  test('deduplicates optimistic portable user messages against streamed echoes', () => {
    const store = useChatStore.getState()
    store.clearSession('portable-dedupe')
    store.processEvent({
      type: 'user_message',
      sessionKey: 'portable-dedupe',
      transport: 'send-stream',
      message: {
        role: 'user',
        content: [{ type: 'text', text: 'Ship the mission control screen' }],
      },
    })

    const merged = store.mergeHistoryMessages('portable-dedupe', [
      {
        role: 'user',
        status: 'sending',
        __optimisticId: 'msg-1',
        content: [{ type: 'text', text: 'Ship the mission control screen' }],
      } as any,
    ])

    expect(merged).toHaveLength(1)
    expect(merged[0]?.role).toBe('user')
  })

  test('ignores duplicate assistant message events while send-stream owns the run', () => {
    const store = useChatStore.getState()
    store.clearSession('send-stream-dedupe')
    store.registerSendStreamRun('run-dedupe')

    store.processEvent({
      type: 'message',
      sessionKey: 'send-stream-dedupe',
      runId: 'run-dedupe',
      transport: 'chat-events',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'stale duplicate' }],
      },
    })

    expect(store.getRealtimeMessages('send-stream-dedupe')).toEqual([])

    store.processEvent({
      type: 'message',
      sessionKey: 'send-stream-dedupe',
      runId: 'run-dedupe',
      transport: 'send-stream',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'authoritative response' }],
      },
    })

    expect(store.getRealtimeMessages('send-stream-dedupe')).toHaveLength(1)
    expect(store.getRealtimeMessages('send-stream-dedupe')[0]?.content).toEqual([
      { type: 'text', text: 'authoritative response' },
    ])
  })
})

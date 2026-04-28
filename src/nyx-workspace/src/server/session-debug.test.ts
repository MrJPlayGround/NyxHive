import { describe, expect, test } from 'bun:test'
import { buildSessionDebugSummary } from './session-debug'

describe('session debug summary', () => {
  test('marks completed assistant sessions as terminal with no working UI', () => {
    const summary = buildSessionDebugSummary({
      generatedAt: '2026-04-16T10:00:00.000Z',
      session: { id: 's1', title: 'Smoke', model: 'gpt-5.4' },
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
      ],
      activeRun: null,
    })

    expect(summary.diagnostics.uiShouldShowWorking).toBe(false)
    expect(summary.diagnostics.terminalState).toBe(true)
    expect(summary.diagnostics.staleThinkingLikely).toBe(true)
    expect(summary.messages.hasAssistantResponse).toBe(true)
  })

  test('does not report stalled runs as working UI', () => {
    const summary = buildSessionDebugSummary({
      generatedAt: '2026-04-16T10:00:00.000Z',
      session: { id: 's1', title: 'Smoke', model: 'gpt-5.4' },
      messages: [{ role: 'user', content: 'hi' }],
      activeRun: {
        runId: 'run-stalled',
        sessionKey: 's1',
        friendlyId: 's1',
        status: 'stalled',
        createdAt: 1,
        updatedAt: 2,
        lastEventAt: 2,
        assistantText: '',
        thinkingText: '',
        toolCalls: [],
        lifecycleEvents: [],
      },
    })

    expect(summary.diagnostics.uiShouldShowWorking).toBe(false)
    expect(summary.diagnostics.terminalState).toBe(true)
  })
})

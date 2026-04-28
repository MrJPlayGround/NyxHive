import { describe, expect, test } from 'bun:test'

import {
  deriveComposerState,
  shouldAcceptSlashSuggestionKey,
} from './chat-composer-state'

describe('deriveComposerState', () => {
  test('describes an empty composer as ready for agent work', () => {
    const state = deriveComposerState({
      value: '',
      attachmentCount: 0,
      attachmentProcessingCount: 0,
      fastMode: false,
      thinkingLevel: 'high',
      isLoading: false,
    })

    expect(state.intent).toBe('ready')
    expect(state.headline).toBe('Agent workspace')
    expect(state.detail).toBe('Give Nyx a task, context, or question.')
    expect(state.badges).toEqual(['Reasoning high'])
  })

  test('promotes code-heavy drafts into a structured prompt state', () => {
    const state = deriveComposerState({
      value: 'Fix this:\n```ts\nconst broken = true\n```',
      attachmentCount: 0,
      attachmentProcessingCount: 0,
      fastMode: false,
      thinkingLevel: 'high',
      isLoading: false,
    })

    expect(state.intent).toBe('code')
    expect(state.headline).toBe('Code context draft')
    expect(state.detail).toBe('Structured prompt with code context.')
    expect(state.badges).toContain('Code')
    expect(state.badges).toContain('Reasoning high')
    expect(state.badges).toContain('4 lines')
  })

  test('makes attachment processing explicit before send', () => {
    const state = deriveComposerState({
      value: 'Review this screenshot',
      attachmentCount: 1,
      attachmentProcessingCount: 2,
      fastMode: true,
      thinkingLevel: 'off',
      isLoading: false,
    })

    expect(state.intent).toBe('attaching')
    expect(state.headline).toBe('Preparing context')
    expect(state.detail).toBe('Processing 2 attachments before sending.')
    expect(state.badges).toEqual([
      '1 attachment',
      '2 processing',
      'Fast',
    ])
  })

  test('shows running state while Nyx is working', () => {
    const state = deriveComposerState({
      value: 'Follow up after this finishes',
      attachmentCount: 0,
      attachmentProcessingCount: 0,
      fastMode: false,
      thinkingLevel: 'low',
      isLoading: true,
    })

    expect(state.intent).toBe('running')
    expect(state.headline).toBe('Nyx is working')
    expect(state.detail).toBe('Draft a follow-up while this run finishes.')
  })

  test('labels medium and high reasoning explicitly', () => {
    expect(
      deriveComposerState({
        value: '',
        attachmentCount: 0,
        attachmentProcessingCount: 0,
        fastMode: false,
        thinkingLevel: 'medium',
        isLoading: false,
      }).badges,
    ).toEqual(['Reasoning medium'])

    expect(
      deriveComposerState({
        value: '',
        attachmentCount: 0,
        attachmentProcessingCount: 0,
        fastMode: false,
        thinkingLevel: 'high',
        isLoading: false,
      }).badges,
    ).toEqual(['Reasoning high'])
  })

  test('surfaces the selected conversation mode in composer badges', () => {
    const state = deriveComposerState({
      value: '',
      attachmentCount: 0,
      attachmentProcessingCount: 0,
      fastMode: false,
      thinkingLevel: 'low',
      conversationMode: 'quick',
      isLoading: false,
    })

    expect(state.badges).toEqual(['Quick', 'Reasoning low'])
    expect(state.detail).toContain('Direct conversation')
  })

  test('surfaces auto conversation mode in composer badges', () => {
    const state = deriveComposerState({
      value: '',
      attachmentCount: 0,
      attachmentProcessingCount: 0,
      fastMode: false,
      thinkingLevel: 'low',
      conversationMode: 'auto',
      isLoading: false,
    })

    expect(state.badges).toEqual(['Auto', 'Reasoning low'])
  })

  test('surfaces the semantic promise of build and deep modes', () => {
    const buildState = deriveComposerState({
      value: '',
      attachmentCount: 0,
      attachmentProcessingCount: 0,
      fastMode: false,
      thinkingLevel: 'high',
      conversationMode: 'build',
      isLoading: false,
    })
    const deepState = deriveComposerState({
      value: '',
      attachmentCount: 0,
      attachmentProcessingCount: 0,
      fastMode: false,
      thinkingLevel: 'high',
      conversationMode: 'deep',
      isLoading: false,
    })

    expect(buildState.detail).toContain('Execution posture')
    expect(buildState.detail).toContain('verification')
    expect(deepState.detail).toContain('Reflective or investigative depth')
    expect(deepState.detail).not.toContain('execution ceremony')
  })

  test('makes queued follow-up behavior explicit while Nyx is working', () => {
    const state = deriveComposerState({
      value: 'Actually, prioritize the migration first',
      attachmentCount: 0,
      attachmentProcessingCount: 0,
      fastMode: false,
      thinkingLevel: 'high',
      isLoading: true,
      queuedFollowupActive: true,
    })

    expect(state.intent).toBe('queued-followup')
    expect(state.headline).toBe('Follow-up queued')
    expect(state.detail).toBe('Send again to steer the active run.')
    expect(state.badges).toContain('Queued')
  })

  test('keeps Enter as send while slash suggestions are open', () => {
    expect(shouldAcceptSlashSuggestionKey('Enter', false)).toBe(false)
    expect(shouldAcceptSlashSuggestionKey('Tab', false)).toBe(true)
  })
})

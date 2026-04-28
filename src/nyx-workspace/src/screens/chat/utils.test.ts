import { describe, expect, test } from 'bun:test'
import { normalizeSessions, streamingTextForMessageList } from './utils'

describe('normalizeSessions', () => {
  test('uses id as the canonical session key when key is missing', () => {
    expect(
      normalizeSessions([
        {
          id: 'canonical-id',
          title: 'Session',
        },
      ]),
    ).toMatchObject([
      {
        key: 'canonical-id',
        friendlyId: 'canonical-id',
        title: 'Session',
      },
    ])
  })

  test('prefers explicit friendly id for routes while preserving canonical key', () => {
    expect(
      normalizeSessions([
        {
          id: 'canonical-id',
          friendlyId: 'friendly-id',
          title: 'Session',
        },
      ]),
    ).toMatchObject([
      {
        key: 'canonical-id',
        friendlyId: 'friendly-id',
        title: 'Session',
      },
    ])
  })
})

describe('streamingTextForMessageList', () => {
  test('hides buffered assistant text while the run is actively streaming', () => {
    expect(streamingTextForMessageList(true, 'partial answer')).toBe('')
  })

  test('returns completed text once the stream is no longer active', () => {
    expect(streamingTextForMessageList(false, 'final answer')).toBe(
      'final answer',
    )
  })

  test('normalizes empty completed text to undefined', () => {
    expect(streamingTextForMessageList(false, '')).toBeUndefined()
  })
})

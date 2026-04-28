import { describe, expect, test } from 'bun:test'
import { isMissingSessionError } from './session-errors'

describe('session error helpers', () => {
  test('detects stale Nyx session 404s', () => {
    expect(
      isMissingSessionError(
        new Error('Nyx chat stream: 404 {"error":"Session not found"}'),
      ),
    ).toBe(true)
  })

  test('does not treat unrelated 404s as stale sessions', () => {
    expect(
      isMissingSessionError('Nyx chat stream: 404 {"error":"No route"}'),
    ).toBe(false)
  })
})

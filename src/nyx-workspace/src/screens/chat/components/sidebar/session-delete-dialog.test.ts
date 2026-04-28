import { describe, expect, it } from 'vitest'
import { SESSION_DELETE_DEFAULT_ACTION } from './session-delete-dialog'

describe('session delete dialog defaults', () => {
  it('defaults Enter to the destructive delete action for fast cleanup', () => {
    expect(SESSION_DELETE_DEFAULT_ACTION).toBe('delete')
  })
})

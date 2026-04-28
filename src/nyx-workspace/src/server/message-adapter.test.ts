import { describe, expect, test } from 'bun:test'
import { nyxMessageToWorkspace, toChatMessage } from './message-adapter'

describe('Nyx message adapter', () => {
  test('preserves Nyx string message ids across history refetches', () => {
    const converted = nyxMessageToWorkspace(
      {
        id: 'thread-message-uuid',
        role: 'user',
        content: 'Hi Nyx',
        created_at: 1776297982000,
      },
      'session-1',
    )

    expect(converted.id).toBe('thread-message-uuid')
    expect(toChatMessage(converted)).toMatchObject({
      id: 'msg-thread-message-uuid',
      role: 'user',
      text: 'Hi Nyx',
      timestamp: 1776297982000,
      sessionKey: 'session-1',
    })
  })
})

import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_CHAT_DISPLAY_NAME,
  getChatProfileDisplayName,
} from './use-chat-settings'

describe('chat profile settings', () => {
  test('defaults the local user identity to User', () => {
    expect(DEFAULT_CHAT_DISPLAY_NAME).toBe('User')
    expect(getChatProfileDisplayName('')).toBe('User')
    expect(getChatProfileDisplayName('  ')).toBe('User')
  })
})

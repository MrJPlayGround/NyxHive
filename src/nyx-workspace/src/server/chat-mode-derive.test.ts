import { describe, expect, test } from 'bun:test'
import { deriveWorkspaceChatMode } from './chat-mode-derive'

describe('deriveWorkspaceChatMode', () => {
  test('uses Nyx enhanced mode whenever sessions are available', () => {
    expect(
      deriveWorkspaceChatMode({
        health: true,
        sessions: true,
        enhancedChat: false,
        chatCompletions: false,
      }),
    ).toBe('enhanced-nyx')
  })

  test('does not treat health-only backends as OpenAI-compatible chat', () => {
    expect(
      deriveWorkspaceChatMode({
        health: true,
        sessions: false,
        chatCompletions: false,
      }),
    ).toBe('disconnected')
  })

  test('uses portable mode only for real chat-completions backends', () => {
    expect(
      deriveWorkspaceChatMode({
        health: true,
        sessions: false,
        chatCompletions: true,
      }),
    ).toBe('portable')
  })
})

export type WorkspaceChatMode = 'enhanced-nyx' | 'portable' | 'disconnected'

export type WorkspaceChatCapabilities = {
  health?: boolean
  sessions?: boolean
  enhancedChat?: boolean
  chatCompletions?: boolean
}

export function deriveWorkspaceChatMode(
  capabilities: WorkspaceChatCapabilities,
): WorkspaceChatMode {
  if (capabilities.sessions) return 'enhanced-nyx'
  if (capabilities.chatCompletions) return 'portable'
  return 'disconnected'
}

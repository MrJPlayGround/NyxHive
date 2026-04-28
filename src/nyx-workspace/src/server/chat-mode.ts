import { getChatMode } from './gateway-capabilities'

export type { ChatMode } from './gateway-capabilities'

export type ChatBackend = 'nyx-enhanced' | 'openai-compat' | 'none'

export function resolveChatBackend(): ChatBackend {
  const mode = getChatMode()
  if (mode === 'enhanced-nyx') return 'nyx-enhanced'
  if (mode === 'portable') return 'openai-compat'
  return 'none'
}

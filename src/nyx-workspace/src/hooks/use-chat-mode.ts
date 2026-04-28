import { useQuery } from '@tanstack/react-query'
import { deriveWorkspaceChatMode } from '@/server/chat-mode-derive'

export type ChatMode = 'enhanced-nyx' | 'portable' | 'disconnected'

interface GatewayStatus {
  capabilities: Record<string, boolean>
  nyxApiUrl: string
}

function deriveChatMode(capabilities: Record<string, boolean>): ChatMode {
  return deriveWorkspaceChatMode(capabilities)
}

export function useChatMode(): ChatMode {
  const { data } = useQuery({
    queryKey: ['gateway-status'],
    queryFn: async () => {
      const res = await fetch('/api/gateway-status')
      if (!res.ok) return null
      return (await res.json()) as GatewayStatus
    },
    staleTime: 60_000,
    refetchInterval: 60_000,
  })

  if (!data?.capabilities) return 'disconnected'
  return deriveChatMode(data.capabilities)
}

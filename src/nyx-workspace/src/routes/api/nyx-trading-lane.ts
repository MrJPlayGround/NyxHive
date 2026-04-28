import { createFileRoute } from '@tanstack/react-router'
import { isAuthenticated } from '../../server/auth-middleware'
import { BEARER_TOKEN, NYX_API_URL } from '../../server/gateway-capabilities'
import { createGatewayAuthHeaders } from '../../server/gateway-auth-headers'

function authHeaders(): Record<string, string> {
  return createGatewayAuthHeaders(BEARER_TOKEN)
}

export const Route = createFileRoute('/api/nyx-trading-lane')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
          })
        }

        const res = await fetch(`${NYX_API_URL}/api/trading/lane`, {
          headers: authHeaders(),
        })
        const body = await res.text()
        return new Response(body, {
          status: res.status,
          headers: { 'Content-Type': 'application/json' },
        })
      },
    },
  },
})

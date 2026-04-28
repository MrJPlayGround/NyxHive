import { createFileRoute } from '@tanstack/react-router'
import { isAuthenticated } from '../../../server/auth-middleware'
import { BEARER_TOKEN, NYX_API_URL } from '../../../server/gateway-capabilities'
import { createGatewayAuthHeaders } from '../../../server/gateway-auth-headers'

type AuthResult = Response | true

function authHeaders(): Record<string, string> {
  return createGatewayAuthHeaders(BEARER_TOKEN)
}

const RELOAD_PATHS = ['/api/reload-mcp', '/api/mcp/reload']

export const Route = createFileRoute('/api/mcp/reload')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const authResult = isAuthenticated(request) as AuthResult
        if (authResult !== true) return authResult

        for (const path of RELOAD_PATHS) {
          try {
            const response = await fetch(`${NYX_API_URL}${path}`, {
              method: 'POST',
              headers: authHeaders(),
            })

            if (response.ok) {
              return Response.json({
                ok: true,
                message: 'MCP server reload requested.',
              })
            }
          } catch {
            // Try the next candidate endpoint.
          }
        }

        return Response.json({
          ok: false,
          message: 'Use /reload-mcp in chat to reload MCP servers.',
        })
      },
    },
  },
})

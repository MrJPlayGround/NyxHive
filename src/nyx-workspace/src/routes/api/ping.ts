import { createFileRoute } from '@tanstack/react-router'
import {
  NYX_API_URL,
  ensureGatewayProbed,
} from '../../server/gateway-capabilities'
import { requireLocalOrAuth } from '../../server/auth-middleware'
import { WORKSPACE_AGENT_NAME } from '../../lib/workspace-branding'

type PingResponse = {
  ok: boolean
  error?: string
  status?: number
  nyxApiUrl: string
}

export const Route = createFileRoute('/api/ping')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!requireLocalOrAuth(request)) {
          return Response.json(
            {
              ok: false,
              error: 'Authentication required',
              status: 401,
              nyxApiUrl: NYX_API_URL,
            } satisfies PingResponse,
            { status: 401 },
          )
        }

        const caps = await ensureGatewayProbed()
        if (!caps.health) {
          return Response.json(
            {
              ok: false,
              error: `${WORKSPACE_AGENT_NAME} unavailable`,
              status: 503,
              nyxApiUrl: NYX_API_URL,
            } satisfies PingResponse,
            { status: 503 },
          )
        }

        return Response.json(
          {
            ok: true,
            status: 200,
            nyxApiUrl: NYX_API_URL,
          } satisfies PingResponse,
          { status: 200 },
        )
      },
    },
  },
})

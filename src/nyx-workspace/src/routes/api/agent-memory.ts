import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { requireLocalOrAuth } from '../../server/auth-middleware'
import {
  NYX_API_URL,
  ensureGatewayProbed,
  getCapabilities,
} from '../../server/gateway-capabilities'
import {
  getAgentMemoryBucket,
  getAgentMemoryOverview,
} from '../../server/nyx-api'

function readPositiveInt(value: string | null, fallback: number, max: number) {
  const parsed = Number(value ?? fallback)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(1, Math.min(max, Math.trunc(parsed)))
}

function readOffset(value: string | null) {
  const parsed = Number(value ?? 0)
  if (!Number.isFinite(parsed)) return 0
  return Math.max(0, Math.trunc(parsed))
}

export const Route = createFileRoute('/api/agent-memory')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!requireLocalOrAuth(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }

        await ensureGatewayProbed()
        if (!getCapabilities().memory) {
          return json(
            {
              ok: false,
              error: `Gateway does not support NyxHive memory APIs on ${NYX_API_URL}`,
            },
            { status: 503 },
          )
        }

        try {
          const url = new URL(request.url)
          const type = url.searchParams.get('type')?.trim()
          if (type) {
            return json(
              await getAgentMemoryBucket({
                type,
                query: url.searchParams.get('q') ?? undefined,
                limit: readPositiveInt(url.searchParams.get('limit'), 50, 200),
                offset: readOffset(url.searchParams.get('offset')),
              }),
            )
          }

          return json(await getAgentMemoryOverview())
        } catch (err) {
          return json(
            { ok: false, error: err instanceof Error ? err.message : String(err) },
            { status: 500 },
          )
        }
      },
    },
  },
})

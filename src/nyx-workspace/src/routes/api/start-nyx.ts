import { json } from '@tanstack/react-start'
import { createFileRoute } from '@tanstack/react-router'
import { isAuthenticated } from '../../server/auth-middleware'
import { startNyxHive } from '../../server/nyxhive-starter'

export const Route = createFileRoute('/api/start-nyx')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        try {
          if (!isAuthenticated(request)) {
            return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
          }

          const result = await startNyxHive()
          return json(result, { status: result.ok ? 200 : 500 })
        } catch (err) {
          return json(
            {
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            },
            { status: 500 },
          )
        }
      },
    },
  },
})

import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../server/auth-middleware'
import { startNyxAgent } from '../../server/nyx-agent'

export const Route = createFileRoute('/api/start-agent')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }

        const result = await startNyxAgent()
        return json(result, { status: result.ok ? 200 : 500 })
      },
    },
  },
})

import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../../server/auth-middleware'
import { buildSessionDebugSummary } from '../../../../server/session-debug'
import { getMessages, getSession } from '../../../../server/nyx-api'
import { getActiveRunForSession } from '../../../../server/run-store'

export const Route = createFileRoute('/api/debug/session/$sessionKey')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }

        const sessionKey = params.sessionKey?.trim()
        if (!sessionKey) {
          return json({ ok: false, error: 'sessionKey required' }, { status: 400 })
        }

        try {
          const [session, messages, activeRun] = await Promise.all([
            getSession(sessionKey),
            getMessages(sessionKey),
            getActiveRunForSession(sessionKey),
          ])
          return json(buildSessionDebugSummary({ session, messages, activeRun }))
        } catch (error) {
          return json(
            { ok: false, error: error instanceof Error ? error.message : String(error) },
            { status: 500 },
          )
        }
      },
    },
  },
})

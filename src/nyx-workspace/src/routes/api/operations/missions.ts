import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../server/auth-middleware'
import { listOperationMissionSnapshots } from '../../../server/operations-adapter'

export const Route = createFileRoute('/api/operations/missions')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }

        try {
          const missions = await listOperationMissionSnapshots()
          return json({ missions, fetchedAt: Date.now() })
        } catch (error) {
          return json(
            {
              error:
                error instanceof Error
                  ? error.message
                  : 'Failed to load operations missions',
              missions: [],
            },
            { status: 500 },
          )
        }
      },
    },
  },
})

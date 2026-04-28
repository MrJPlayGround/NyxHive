import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../server/auth-middleware'
import { listPersistedRuns } from '../../../server/run-store'

export const Route = createFileRoute('/api/operations/runs')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }

        const url = new URL(request.url)
        const limit = Number.parseInt(url.searchParams.get('limit') ?? '20', 10)

        try {
          const runs = await listPersistedRuns({
            limit: Number.isFinite(limit) ? limit : 20,
          })
          return json({
            runs: runs.map((run) => ({
              runId: run.runId,
              sessionKey: run.sessionKey,
              friendlyId: run.friendlyId,
              conversationMode: run.conversationMode ?? null,
              runtimePosture: run.runtimePosture ?? null,
              status: run.status,
              createdAt: run.createdAt,
              updatedAt: run.updatedAt,
              lastEventAt: run.lastEventAt,
              assistantText: run.assistantText,
              thinkingText: run.thinkingText,
              errorMessage: run.errorMessage ?? null,
              toolCallCount: run.toolCalls.length,
              lifecycleEventCount: run.lifecycleEvents.length,
              lastLifecycleEvent:
                run.lifecycleEvents.length > 0
                  ? run.lifecycleEvents[run.lifecycleEvents.length - 1]
                  : null,
            })),
            fetchedAt: Date.now(),
          })
        } catch (error) {
          return json(
            {
              error:
                error instanceof Error
                  ? error.message
                  : 'Failed to load run ledger',
              runs: [],
            },
            { status: 500 },
          )
        }
      },
    },
  },
})

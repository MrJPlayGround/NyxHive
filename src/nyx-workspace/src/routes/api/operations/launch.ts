import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../../server/auth-middleware'
import {
  ensureGatewayProbed,
  getCapabilities,
} from '../../../server/gateway-capabilities'
import {
  launchOperationMission,
  type LaunchOperationMissionInput,
} from '../../../server/operations-adapter'

function normalizeInput(body: Record<string, unknown>): LaunchOperationMissionInput {
  return {
    goal: typeof body.goal === 'string' ? body.goal.trim() : '',
    mode:
      body.mode === 'quick' ||
      body.mode === 'task' ||
      body.mode === 'build' ||
      body.mode === 'deep'
        ? body.mode
        : 'task',
    profile:
      typeof body.profile === 'string' && body.profile.trim()
        ? body.profile.trim()
        : 'nyx',
    autonomy:
      body.autonomy === 'low' ||
      body.autonomy === 'medium' ||
      body.autonomy === 'high'
        ? body.autonomy
        : 'medium',
    model:
      typeof body.model === 'string' && body.model.trim()
        ? body.model.trim()
        : null,
  }
}

export const Route = createFileRoute('/api/operations/launch')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }

        await ensureGatewayProbed()
        if (!getCapabilities().jobs) {
          return json(
            {
              error: 'Operations launch requires scheduler/jobs support from the Nyx gateway.',
            },
            { status: 503 },
          )
        }

        const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
        const input = normalizeInput(body)
        if (!input.goal) {
          return json({ error: 'Mission goal is required.' }, { status: 400 })
        }

        try {
          const mission = await launchOperationMission(input)
          return json({ mission }, { status: 201 })
        } catch (error) {
          return json(
            {
              error: error instanceof Error ? error.message : 'Failed to launch mission',
            },
            { status: 500 },
          )
        }
      },
    },
  },
})

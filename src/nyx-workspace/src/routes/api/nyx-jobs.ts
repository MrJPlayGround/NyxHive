/**
 * Jobs API proxy — forwards to the Nyx gateway /api/jobs
 */
import { createFileRoute } from '@tanstack/react-router'
import { isAuthenticated } from '../../server/auth-middleware'
import {
  BEARER_TOKEN,
  NYX_API_URL,
  NYX_UPGRADE_INSTRUCTIONS,
  ensureGatewayProbed,
  getCapabilities,
} from '../../server/gateway-capabilities'
import { createGatewayAuthHeaders } from '../../server/gateway-auth-headers'
import {
  jobInputToSchedulerTask,
  schedulerTaskToJob,
  type SchedulerTaskRecord,
  type WorkspaceJobInput,
} from '../../server/job-scheduler-adapter'
import { createCapabilityUnavailablePayload } from '@/lib/feature-gates'

function authHeaders(): Record<string, string> {
  return createGatewayAuthHeaders(BEARER_TOKEN)
}

export const Route = createFileRoute('/api/nyx-jobs')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
          })
        }
        await ensureGatewayProbed()
        if (!getCapabilities().jobs) {
          return new Response(
            JSON.stringify({
              ...createCapabilityUnavailablePayload('jobs'),
              items: [],
              jobs: [],
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          )
        }
        const res = await fetch(`${NYX_API_URL}/api/scheduler/tasks?all=true`, {
          headers: authHeaders(),
        })
        if (!res.ok) {
          return new Response(await res.text(), {
            status: res.status,
            headers: { 'Content-Type': 'application/json' },
          })
        }
        const tasks = (await res.json().catch(() => [])) as unknown
        const jobs = Array.isArray(tasks)
          ? tasks.map((task) => schedulerTaskToJob(task as SchedulerTaskRecord))
          : []
        return Response.json({ jobs, items: jobs })
      },
      POST: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
          })
        }
        await ensureGatewayProbed()
        if (!getCapabilities().jobs) {
          return new Response(
            JSON.stringify({
              ...createCapabilityUnavailablePayload('jobs', {
                error: `Gateway does not support /api/jobs. ${NYX_UPGRADE_INSTRUCTIONS}`,
              }),
            }),
            { status: 503, headers: { 'Content-Type': 'application/json' } },
          )
        }
        const input = (await request.json()) as WorkspaceJobInput
        const createPayload = jobInputToSchedulerTask(input)
        const res = await fetch(`${NYX_API_URL}/api/scheduler/tasks`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify(createPayload),
        })
        const payload = (await res.json().catch(() => ({}))) as {
          id?: string
          error?: string
        }
        if (!res.ok || !payload.id) return Response.json(payload, { status: res.status })

        const taskRes = await fetch(
          `${NYX_API_URL}/api/scheduler/tasks/${encodeURIComponent(payload.id)}`,
          { headers: authHeaders() },
        )
        const task = (await taskRes.json().catch(() => null)) as
          | SchedulerTaskRecord
          | null
        return Response.json(
          { job: task ? schedulerTaskToJob(task) : { id: payload.id } },
          { status: 201 },
        )
      },
    },
  },
})

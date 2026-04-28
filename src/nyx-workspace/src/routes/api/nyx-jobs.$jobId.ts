/**
 * Jobs API proxy — forwards individual job operations to the Nyx gateway
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
  schedulerTaskResultToJobOutput,
  schedulerTaskToJob,
  type SchedulerTaskRecord,
  type SchedulerTaskResult,
  type WorkspaceJobInput,
} from '../../server/job-scheduler-adapter'

function authHeaders(): Record<string, string> {
  return createGatewayAuthHeaders(BEARER_TOKEN)
}

async function fetchSchedulerJob(jobId: string) {
  const taskRes = await fetch(
    `${NYX_API_URL}/api/scheduler/tasks/${encodeURIComponent(jobId)}`,
    { headers: authHeaders() },
  )
  const task = (await taskRes.json().catch(() => null)) as
    | SchedulerTaskRecord
    | null
  return task ? schedulerTaskToJob(task) : { id: jobId }
}

export const Route = createFileRoute('/api/nyx-jobs/$jobId')({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        if (!isAuthenticated(request)) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
          })
        }
        await ensureGatewayProbed()
        if (!getCapabilities().jobs) {
          return new Response(
            JSON.stringify({
              error: `Gateway does not support /api/jobs. ${NYX_UPGRADE_INSTRUCTIONS}`,
            }),
            { status: 404, headers: { 'Content-Type': 'application/json' } },
          )
        }
        const url = new URL(request.url)
        const subPath = url.searchParams.get('action') || ''
        if (subPath === 'output') {
          const resultRes = await fetch(
            `${NYX_API_URL}/api/scheduler/tasks/${encodeURIComponent(params.jobId)}/result`,
            { headers: authHeaders() },
          )
          if (!resultRes.ok) {
            return new Response(await resultRes.text(), {
              status: resultRes.status,
              headers: { 'Content-Type': 'application/json' },
            })
          }
          const result = (await resultRes.json()) as SchedulerTaskResult
          return Response.json({
            outputs: schedulerTaskResultToJobOutput(result),
          })
        }
        const target = `${NYX_API_URL}/api/scheduler/tasks/${encodeURIComponent(params.jobId)}`
        const res = await fetch(target, { headers: authHeaders() })
        if (!res.ok) {
          return new Response(await res.text(), {
            status: res.status,
            headers: { 'Content-Type': 'application/json' },
          })
        }
        const task = (await res.json()) as SchedulerTaskRecord
        return Response.json({ job: schedulerTaskToJob(task) })
      },
      POST: async ({ request, params }) => {
        if (!isAuthenticated(request)) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
          })
        }
        await ensureGatewayProbed()
        if (!getCapabilities().jobs) {
          return new Response(
            JSON.stringify({
              error: `Gateway does not support /api/jobs. ${NYX_UPGRADE_INSTRUCTIONS}`,
            }),
            { status: 404, headers: { 'Content-Type': 'application/json' } },
          )
        }
        const url = new URL(request.url)
        const action = url.searchParams.get('action') || ''
        if (action === 'run') {
          const res = await fetch(
            `${NYX_API_URL}/api/scheduler/tasks/${encodeURIComponent(params.jobId)}/trigger`,
            { method: 'POST', headers: authHeaders() },
          )
          if (!res.ok) {
            return new Response(await res.text(), {
              status: res.status,
              headers: { 'Content-Type': 'application/json' },
            })
          }
          return Response.json({ job: await fetchSchedulerJob(params.jobId) })
        }
        if (action === 'pause' || action === 'resume') {
          const res = await fetch(
            `${NYX_API_URL}/api/scheduler/tasks/${encodeURIComponent(params.jobId)}`,
            {
              method: 'PATCH',
              headers: { 'Content-Type': 'application/json', ...authHeaders() },
              body: JSON.stringify({ enabled: action === 'resume' }),
            },
          )
          if (!res.ok) {
            return new Response(await res.text(), {
              status: res.status,
              headers: { 'Content-Type': 'application/json' },
            })
          }
          return Response.json({ job: await fetchSchedulerJob(params.jobId) })
        }

        return Response.json({ error: 'Unsupported job action' }, { status: 400 })
      },
      PATCH: async ({ request, params }) => {
        if (!isAuthenticated(request)) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
          })
        }
        await ensureGatewayProbed()
        if (!getCapabilities().jobs) {
          return new Response(
            JSON.stringify({
              error: `Gateway does not support /api/jobs. ${NYX_UPGRADE_INSTRUCTIONS}`,
            }),
            { status: 404, headers: { 'Content-Type': 'application/json' } },
          )
        }
        const input = (await request.json()) as WorkspaceJobInput
        const updatePayload = jobInputToSchedulerTask(input)
        const res = await fetch(
          `${NYX_API_URL}/api/scheduler/tasks/${encodeURIComponent(params.jobId)}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', ...authHeaders() },
            body: JSON.stringify(updatePayload),
          },
        )
        const payload = await res.json().catch(() => ({}))
        if (!res.ok) return Response.json(payload, { status: res.status })
        return Response.json({ job: await fetchSchedulerJob(params.jobId) })
      },
      DELETE: async ({ request, params }) => {
        if (!isAuthenticated(request)) {
          return new Response(JSON.stringify({ error: 'Unauthorized' }), {
            status: 401,
          })
        }
        await ensureGatewayProbed()
        if (!getCapabilities().jobs) {
          return new Response(
            JSON.stringify({
              error: `Gateway does not support /api/jobs. ${NYX_UPGRADE_INSTRUCTIONS}`,
            }),
            { status: 404, headers: { 'Content-Type': 'application/json' } },
          )
        }
        const res = await fetch(
          `${NYX_API_URL}/api/scheduler/tasks/${encodeURIComponent(params.jobId)}`,
          {
            method: 'DELETE',
            headers: authHeaders(),
          },
        )
        return new Response(await res.text(), {
          status: res.status,
          headers: { 'Content-Type': 'application/json' },
        })
      },
    },
  },
})

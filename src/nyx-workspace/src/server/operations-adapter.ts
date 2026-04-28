import type { SchedulerTaskRecord } from './job-scheduler-adapter'
import {
  createOperationMission,
  listOperationMissions,
  updateOperationMission,
  type OperationMissionAutonomy,
  type OperationMissionMode,
  type OperationMissionRecord,
  type OperationMissionStatus,
} from './operations-store'

export type LaunchOperationMissionInput = {
  goal: string
  mode: OperationMissionMode
  profile: string
  autonomy: OperationMissionAutonomy
  model: string | null
}

export type OperationMissionSnapshot = OperationMissionRecord & {
  jobName: string | null
  lastRunAt: string | null
  lastStatus: string | null
}

type SchedulerTaskPayload = Record<string, unknown>

type OperationsAdapterDeps = {
  createSchedulerTask?: (
    payload: SchedulerTaskPayload,
  ) => Promise<
    Pick<
      SchedulerTaskRecord,
      'id' | 'name' | 'prompt' | 'enabled' | 'last_status' | 'run_count' | 'last_run_at'
    >
  >
  triggerSchedulerTask?: (jobId: string) => Promise<void>
  listSchedulerTasks?: () => Promise<SchedulerTaskRecord[]>
}

async function getGatewayRuntime(): Promise<{
  apiUrl: string
  headers: Record<string, string>
}> {
  const [{ BEARER_TOKEN, NYX_API_URL }, { createGatewayAuthHeaders }] =
    await Promise.all([
      import('./gateway-capabilities'),
      import('./gateway-auth-headers'),
    ])

  return {
    apiUrl: NYX_API_URL,
    headers: createGatewayAuthHeaders(BEARER_TOKEN),
  }
}

function buildMissionName(goal: string): string {
  const trimmed = goal.trim()
  return `Mission: ${trimmed.length > 72 ? `${trimmed.slice(0, 72).trimEnd()}…` : trimmed}`
}

function composeMissionPrompt(input: LaunchOperationMissionInput): string {
  const lines = [
    `Mission goal: ${input.goal.trim()}`,
    '',
    'Execution envelope:',
    `- Conversation mode: ${input.mode}`,
    `- Profile: ${input.profile.trim() || 'nyx'}`,
    `- Autonomy: ${input.autonomy}`,
  ]

  if (input.model?.trim()) {
    lines.push(`- Model override: ${input.model.trim()}`)
  }

  lines.push(
    '',
    'Treat this as operations-launched work.',
    'Do the work directly, keep runtime chatter minimal, and return a usable outcome.',
  )

  return lines.join('\n')
}

function toIso(value: number | null | undefined): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return new Date(value).toISOString()
}

function mapTaskStatusToMissionStatus(
  task: SchedulerTaskRecord | null,
  fallback: OperationMissionStatus,
): OperationMissionStatus {
  if (!task) return fallback
  if (task.enabled === false || task.enabled === 0) return 'paused'

  const lastStatus = task.last_status?.toLowerCase().trim() ?? ''
  if (!lastStatus) return fallback
  if (
    lastStatus.includes('running') ||
    lastStatus.includes('active') ||
    lastStatus.includes('progress')
  ) {
    return 'running'
  }
  if (
    lastStatus.includes('complete') ||
    lastStatus.includes('success') ||
    lastStatus.includes('done')
  ) {
    return 'completed'
  }
  if (
    lastStatus.includes('error') ||
    lastStatus.includes('fail') ||
    lastStatus.includes('cancel')
  ) {
    return 'failed'
  }
  return fallback
}

async function createSchedulerTaskViaGateway(
  payload: SchedulerTaskPayload,
): Promise<SchedulerTaskRecord> {
  const gateway = await getGatewayRuntime()
  const response = await fetch(`${gateway.apiUrl}/api/scheduler/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...gateway.headers },
    body: JSON.stringify(payload),
  })
  const body = (await response.json().catch(() => ({}))) as { id?: string; error?: string }
  if (!response.ok || !body.id) {
    throw new Error(body.error || `Failed to create scheduler task (${response.status})`)
  }

  return {
    id: body.id,
    name: String(payload.name ?? body.id),
    prompt: String(payload.prompt ?? ''),
    enabled: true,
    last_status: null,
    run_count: 0,
  }
}

async function triggerSchedulerTaskViaGateway(jobId: string): Promise<void> {
  const gateway = await getGatewayRuntime()
  const response = await fetch(
    `${gateway.apiUrl}/api/scheduler/tasks/${encodeURIComponent(jobId)}/trigger`,
    { method: 'POST', headers: gateway.headers },
  )
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(body || `Failed to trigger scheduler task (${response.status})`)
  }
}

async function listSchedulerTasksViaGateway(): Promise<SchedulerTaskRecord[]> {
  const gateway = await getGatewayRuntime()
  const response = await fetch(`${gateway.apiUrl}/api/scheduler/tasks?all=true`, {
    headers: gateway.headers,
  })
  if (!response.ok) {
    throw new Error(`Failed to list scheduler tasks (${response.status})`)
  }
  const body = (await response.json().catch(() => [])) as unknown
  return Array.isArray(body) ? (body as SchedulerTaskRecord[]) : []
}

export async function launchOperationMission(
  input: LaunchOperationMissionInput,
  deps: OperationsAdapterDeps = {},
): Promise<OperationMissionRecord> {
  const mission = await createOperationMission(input)
  const createSchedulerTask = deps.createSchedulerTask ?? createSchedulerTaskViaGateway
  const triggerSchedulerTask = deps.triggerSchedulerTask ?? triggerSchedulerTaskViaGateway

  try {
    const createdTask = await createSchedulerTask({
      name: buildMissionName(input.goal),
      prompt: composeMissionPrompt(input),
      agent: input.profile.trim() || 'nyx',
      channel: 'api',
      authority_profile: 'scheduled',
    })

    await updateOperationMission(mission.id, {
      jobId: createdTask.id,
      status: 'queued',
      lastError: null,
    })
    await triggerSchedulerTask(createdTask.id)

    return (
      (await updateOperationMission(mission.id, {
        jobId: createdTask.id,
        status: 'queued',
        lastError: null,
      })) ?? mission
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return (
      (await updateOperationMission(mission.id, {
        status: 'failed',
        lastError: message,
      })) ?? mission
    )
  }
}

export async function listOperationMissionSnapshots(
  deps: OperationsAdapterDeps = {},
): Promise<OperationMissionSnapshot[]> {
  const [missions, schedulerTasks] = await Promise.all([
    listOperationMissions(),
    (deps.listSchedulerTasks ?? listSchedulerTasksViaGateway)().catch(() => []),
  ])
  const tasksById = new Map(schedulerTasks.map((task) => [task.id, task]))

  return Promise.all(
    missions.map(async (mission) => {
      const task = mission.jobId ? tasksById.get(mission.jobId) ?? null : null
      const status = mapTaskStatusToMissionStatus(task, mission.status)
      if (status !== mission.status) {
        await updateOperationMission(mission.id, { status })
      }
      return {
        ...mission,
        status,
        jobName: task?.name ?? null,
        lastRunAt: toIso(task?.last_run_at),
        lastStatus: task?.last_status ?? null,
      }
    }),
  )
}

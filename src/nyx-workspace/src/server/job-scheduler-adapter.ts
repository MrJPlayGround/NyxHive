export type SchedulerTaskRecord = {
  id: string
  name: string
  prompt: string
  agent?: string | null
  description?: string | null
  cron_expression?: string | null
  run_at?: number | null
  schedule_human?: string | null
  enabled: number | boolean
  next_run_at?: number | null
  last_run_at?: number | null
  last_status?: string | null
  last_error?: string | null
  last_result?: string | null
  run_count?: number
  channel?: string | null
  recipient?: string | null
}

export type WorkspaceJobInput = {
  name?: string
  schedule?: string
  prompt?: string
  deliver?: Array<string>
}

export type WorkspaceJob = {
  id: string
  name: string
  prompt: string
  agent?: string | null
  schedule: Record<string, unknown>
  schedule_display?: string
  enabled: boolean
  state: string
  next_run_at?: string | null
  last_run_at?: string | null
  last_run_success?: boolean | null
  deliver?: Array<string>
  run_count?: number
}

export type SchedulerTaskResult = {
  task_name: string
  agent: string
  last_status: string | null
  last_result: string | null
  last_run_at: number | null
}

export type WorkspaceJobOutput = {
  filename: string
  timestamp: string
  content: string
  size: number
}

function toIso(value: number | null | undefined): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  return new Date(value).toISOString()
}

function scheduleToCron(schedule: string | undefined): string | undefined {
  const value = schedule?.trim().toLowerCase()
  if (!value) return undefined

  const every = value.match(/^every\s+(\d+)\s*([mh])$/)
  if (every) {
    const amount = Number.parseInt(every[1], 10)
    const unit = every[2]
    if (unit === 'm') return `*/${amount} * * * *`
    if (unit === 'h') return amount === 1 ? '0 * * * *' : `0 */${amount} * * *`
  }

  if (value.trim().split(/\s+/).length === 5) return schedule?.trim()
  return schedule?.trim()
}

function deliveryToChannel(deliver: Array<string> | undefined): string {
  const channel = deliver?.find((entry) => entry !== 'local')
  return channel || 'api'
}

export function schedulerTaskToJob(task: SchedulerTaskRecord): WorkspaceJob {
  const enabled = task.enabled === true || task.enabled === 1
  const lastStatus = task.last_status ?? null
  const lastRunSuccess =
    lastStatus === null ? null : lastStatus === 'completed' || lastStatus === 'success'

  return {
    id: task.id,
    name: task.name,
    prompt: task.prompt,
    agent: task.agent ?? null,
    schedule: {
      cron: task.cron_expression ?? undefined,
      run_at: task.run_at ?? undefined,
    },
    schedule_display:
      task.schedule_human ?? task.cron_expression ?? task.run_at?.toString(),
    enabled,
    state: enabled ? 'scheduled' : 'paused',
    next_run_at: toIso(task.next_run_at),
    last_run_at: toIso(task.last_run_at),
    last_run_success: lastRunSuccess,
    deliver: task.channel && task.channel !== 'api' ? [task.channel] : ['local'],
    run_count: task.run_count ?? 0,
  }
}

export function jobInputToSchedulerTask(
  input: WorkspaceJobInput,
): Record<string, unknown> {
  return {
    name: input.name?.trim() || 'Untitled job',
    prompt: input.prompt?.trim() || '',
    cron_expression: scheduleToCron(input.schedule),
    agent: 'nyx',
    channel: deliveryToChannel(input.deliver),
    authority_profile: 'scheduled',
  }
}

export function schedulerTaskResultToJobOutput(
  result: SchedulerTaskResult,
): Array<WorkspaceJobOutput> {
  if (!result.last_result || !result.last_run_at) return []
  return [
    {
      filename: result.task_name,
      timestamp: new Date(result.last_run_at).toISOString(),
      content: result.last_result,
      size: result.last_result.length,
    },
  ]
}

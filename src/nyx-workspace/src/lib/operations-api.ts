export type OperationMission = {
  id: string
  goal: string
  mode: 'quick' | 'task' | 'build' | 'deep'
  profile: string
  autonomy: 'low' | 'medium' | 'high'
  model: string | null
  status: 'queued' | 'running' | 'completed' | 'failed' | 'paused'
  createdAt: string
  updatedAt: string
  jobId: string | null
  sessionKey: string | null
  runId: string | null
  lastError: string | null
  jobName: string | null
  lastRunAt: string | null
  lastStatus: string | null
}

export type OperationRun = {
  runId: string
  sessionKey: string
  friendlyId: string
  conversationMode?: 'quick' | 'task' | 'build' | 'deep'
  runtimePosture?: 'conversation' | 'investigation' | 'execution' | 'reflection'
  status: 'accepted' | 'active' | 'handoff' | 'stalled' | 'complete' | 'error'
  createdAt: number
  updatedAt: number
  lastEventAt: number
  assistantText: string
  thinkingText: string
  errorMessage?: string
}

export type LaunchOperationMissionInput = {
  goal: string
  mode: 'quick' | 'task' | 'build' | 'deep'
  profile: string
  autonomy: 'low' | 'medium' | 'high'
  model: string | null
}

export type TradingLaneSnapshot = {
  lane: {
    mode: string
    active_adapter: string
    last_mode_change_reason: string | null
    last_halt_reason: string | null
  }
  risk: {
    daily_pnl: number
    daily_loss_limit: number
    daily_trades: number
    max_daily_trades: number
    _open_positions: number
    max_concurrent: number
  }
  intents: Array<{ id: string; symbol: string; status: string }>
  executions: Array<{ id: string; symbol: string; status: string }>
}

function looksLikeHtml(contentType: string, text: string): boolean {
  if (contentType.includes('text/html')) return true

  const sample = text.trim().slice(0, 120).toLowerCase()
  return sample.startsWith('<!doctype html') || sample.startsWith('<html')
}

async function readJsonBody<T>(response: Response, route: string): Promise<T> {
  const text = await response.text().catch(() => '')
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? ''

  if (looksLikeHtml(contentType, text)) {
    throw new Error(
      `${route} returned HTML instead of JSON. The workspace or gateway is likely stale and needs a restart.`,
    )
  }

  if (!text.trim()) {
    return {} as T
  }

  try {
    return JSON.parse(text) as T
  } catch {
    throw new Error(`${route} returned invalid JSON.`)
  }
}

export async function fetchOperationMissions(): Promise<OperationMission[]> {
  const response = await fetch('/api/operations/missions')
  const body = await readJsonBody<{ missions?: OperationMission[]; error?: string }>(
    response,
    '/api/operations/missions',
  )
  if (!response.ok) {
    throw new Error(body.error || `Failed to fetch missions: ${response.status}`)
  }
  return body.missions ?? []
}

export async function launchOperationMissionRequest(
  input: LaunchOperationMissionInput,
): Promise<OperationMission> {
  const response = await fetch('/api/operations/launch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  const body = await readJsonBody<{ mission?: OperationMission; error?: string }>(
    response,
    '/api/operations/launch',
  )
  if (!response.ok) {
    throw new Error(body.error || `Failed to launch mission: ${response.status}`)
  }
  return body.mission as OperationMission
}

export async function fetchOperationRuns(limit = 12): Promise<OperationRun[]> {
  const response = await fetch(`/api/operations/runs?limit=${limit}`)
  const body = await readJsonBody<{ runs?: OperationRun[]; error?: string }>(
    response,
    '/api/operations/runs',
  )
  if (!response.ok) {
    throw new Error(body.error || `Failed to fetch operations runs: ${response.status}`)
  }
  return body.runs ?? []
}

export async function fetchTradingLaneSnapshot(): Promise<TradingLaneSnapshot> {
  const response = await fetch('/api/nyx-trading-lane')
  const body = await readJsonBody<TradingLaneSnapshot & { error?: string }>(
    response,
    '/api/nyx-trading-lane',
  )
  if (!response.ok) {
    throw new Error(body.error || `Trading lane request failed (${response.status})`)
  }
  return body
}

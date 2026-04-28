import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../server/auth-middleware'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import yaml from 'yaml'
import {
  BEARER_TOKEN,
  NYX_API_URL,
  ensureGatewayProbed,
  getCapabilities,
} from '../../server/gateway-capabilities'
import { createGatewayAuthHeaders } from '../../server/gateway-auth-headers'
import { getNyxWorkspaceHome } from '../../server/workspace-home'
import { listPersistedRuns, type PersistedRunState } from '../../server/run-store'
import type { SchedulerTaskRecord } from '../../server/job-scheduler-adapter'

type CrewDefinition = {
  id: string
  displayName: string
  role: string
  profilePath: string | null
}

type DbStats = {
  sessionCount: number
  messageCount: number
  toolCallCount: number
  totalTokens: number
  estimatedCostUsd: number | null
  lastSessionTitle: string | null
  lastSessionAt: number | null
}

type CrewRunSnapshot = {
  sessionKey: string
  runId: string
  status: PersistedRunState['status']
  updatedAt: number
  assistantText: string
  errorMessage: string | null
}

type CrewOpsSummary = {
  activeRunCount: number
  latestRun: CrewRunSnapshot | null
  lastFailure: CrewRunSnapshot | null
  lastHandoff: CrewRunSnapshot | null
}

function titleCase(value: string): string {
  return value
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function buildCrewDefinitions(): CrewDefinition[] {
  const base = getNyxWorkspaceHome()
  const profilesDir = join(base, 'profiles')
  const dynamicProfiles = existsSync(profilesDir)
    ? readdirSync(profilesDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
    : []

  return [
    { id: 'workspace', displayName: 'Workspace', role: 'Primary profile', profilePath: null },
    ...dynamicProfiles.map((profile) => ({
      id: profile,
      displayName: titleCase(profile),
      role: 'Profile',
      profilePath: profile,
    })),
  ]
}

function getNyxHome(profilePath: string | null): string {
  const base = getNyxWorkspaceHome()
  return profilePath ? join(base, 'profiles', profilePath) : base
}

function readGatewayState(nyxHome: string) {
  const path = join(nyxHome, 'gateway_state.json')
  if (!existsSync(path)) return { pid: null, gatewayState: 'unknown', platforms: {}, updatedAt: null }
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8'))
    return {
      pid: raw.pid ?? null,
      gatewayState: raw.gateway_state ?? 'unknown',
      platforms: raw.platforms ?? {},
      updatedAt: raw.updated_at ?? null,
    }
  } catch {
    return { pid: null, gatewayState: 'unknown', platforms: {}, updatedAt: null }
  }
}

function checkProcessAlive(pid: number | null): boolean {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function readDbStats(nyxHome: string): DbStats {
  const dbPath = join(nyxHome, 'state.db')
  if (!existsSync(dbPath)) {
    return {
      sessionCount: 0,
      messageCount: 0,
      toolCallCount: 0,
      totalTokens: 0,
      estimatedCostUsd: null,
      lastSessionTitle: null,
      lastSessionAt: null,
    }
  }

  try {
    const script = `
import json, sqlite3, sys
path = sys.argv[1]
out = {
  "sessionCount": 0,
  "messageCount": 0,
  "toolCallCount": 0,
  "totalTokens": 0,
  "estimatedCostUsd": None,
  "lastSessionTitle": None,
  "lastSessionAt": None,
}
conn = sqlite3.connect(path)
conn.row_factory = sqlite3.Row
cur = conn.cursor()
agg = cur.execute("""
SELECT
  COUNT(*) as session_count,
  COALESCE(SUM(message_count), 0) as total_messages,
  COALESCE(SUM(tool_call_count), 0) as total_tool_calls,
  COALESCE(SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)), 0) as total_tokens,
  SUM(estimated_cost_usd) as estimated_cost,
  MAX(started_at) as last_session_at
FROM sessions
""").fetchone()
if agg is not None:
  out["sessionCount"] = agg["session_count"] or 0
  out["messageCount"] = agg["total_messages"] or 0
  out["toolCallCount"] = agg["total_tool_calls"] or 0
  out["totalTokens"] = agg["total_tokens"] or 0
  out["estimatedCostUsd"] = agg["estimated_cost"]
last_row = cur.execute("SELECT title, started_at FROM sessions ORDER BY started_at DESC LIMIT 1").fetchone()
if last_row is not None:
  out["lastSessionTitle"] = last_row["title"]
  out["lastSessionAt"] = last_row["started_at"]
conn.close()
print(json.dumps(out))
`
    const raw = execFileSync('python3', ['-c', script, dbPath], {
      encoding: 'utf-8',
      timeout: 3_000,
    })
    return JSON.parse(raw) as DbStats
  } catch {
    return {
      sessionCount: 0,
      messageCount: 0,
      toolCallCount: 0,
      totalTokens: 0,
      estimatedCostUsd: null,
      lastSessionTitle: null,
      lastSessionAt: null,
    }
  }
}

function readConfig(nyxHome: string): { model: string; provider: string } {
  const configPath = join(nyxHome, 'config.yaml')
  if (!existsSync(configPath)) return { model: 'unknown', provider: 'unknown' }
  try {
    const raw = yaml.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>
    const modelVal = raw.model
    const providerVal = raw.provider

    if (typeof modelVal === 'object' && modelVal !== null) {
      const modelObj = modelVal as Record<string, unknown>
      return {
        model: String(modelObj.default ?? modelObj.name ?? 'unknown'),
        provider: String(modelObj.provider ?? providerVal ?? 'unknown'),
      }
    }

    return {
      model: String(modelVal ?? 'unknown'),
      provider: String(providerVal ?? 'unknown'),
    }
  } catch {
    return { model: 'unknown', provider: 'unknown' }
  }
}

function readCronJobCount(nyxHome: string): number {
  const cronPath = join(nyxHome, 'cron', 'jobs.json')
  if (!existsSync(cronPath)) return 0
  try {
    const jobs = JSON.parse(readFileSync(cronPath, 'utf-8'))
    return Array.isArray(jobs)
      ? jobs.length
      : typeof jobs === 'object' && jobs !== null
        ? Object.keys(jobs).length
        : 0
  } catch {
    return 0
  }
}

async function fetchAssignedTaskCounts(): Promise<Record<string, number>> {
  try {
    const res = await fetch(`${NYX_API_URL}/api/tasks?include_done=false`, {
      signal: AbortSignal.timeout(3_000),
      headers: createGatewayAuthHeaders(BEARER_TOKEN),
    })
    if (!res.ok) return {}

    const data = await res.json() as {
      tasks?: Array<{ assignee?: string | null; column?: string | null }>
    }

    const counts: Record<string, number> = {}
    for (const task of data.tasks ?? []) {
      if (!task.assignee || task.column === 'done') continue
      counts[task.assignee] = (counts[task.assignee] ?? 0) + 1
    }
    return counts
  } catch {
    return {}
  }
}

function toCrewRunSnapshot(run: PersistedRunState): CrewRunSnapshot {
  return {
    sessionKey: run.sessionKey,
    runId: run.runId,
    status: run.status,
    updatedAt: run.updatedAt,
    assistantText: run.assistantText,
    errorMessage: run.errorMessage ?? null,
  }
}

function summarizeRuns(runs: PersistedRunState[]): CrewOpsSummary {
  const sorted = [...runs].sort((a, b) => b.updatedAt - a.updatedAt)
  const lastFailure = sorted.find((run) => run.status === 'error') ?? null
  const lastHandoff = sorted.find((run) => run.status === 'handoff') ?? null

  return {
    activeRunCount: sorted.filter((run) =>
      run.status === 'accepted' || run.status === 'active' || run.status === 'handoff',
    ).length,
    latestRun: sorted[0] ? toCrewRunSnapshot(sorted[0]) : null,
    lastFailure: lastFailure ? toCrewRunSnapshot(lastFailure) : null,
    lastHandoff: lastHandoff ? toCrewRunSnapshot(lastHandoff) : null,
  }
}

async function fetchSchedulerTaskCounts(): Promise<{
  queuedByAgent: Record<string, number>
}> {
  if (!getCapabilities().jobs) {
    return { queuedByAgent: {} }
  }

  try {
    const res = await fetch(`${NYX_API_URL}/api/scheduler/tasks?all=true`, {
      signal: AbortSignal.timeout(3_000),
      headers: createGatewayAuthHeaders(BEARER_TOKEN),
    })
    if (!res.ok) return { queuedByAgent: {} }

    const data = (await res.json().catch(() => [])) as unknown
    const tasks = Array.isArray(data) ? (data as SchedulerTaskRecord[]) : []
    const queuedByAgent: Record<string, number> = {}

    for (const task of tasks) {
      const agent =
        typeof task.agent === 'string' && task.agent.trim()
          ? task.agent.trim()
          : 'workspace'
      const lastStatus = task.last_status?.toLowerCase().trim() ?? ''
      const queued =
        task.enabled === true ||
        task.enabled === 1
          ? !lastStatus ||
            lastStatus.includes('queued') ||
            lastStatus.includes('pending') ||
            lastStatus.includes('scheduled')
          : false
      if (!queued) continue
      queuedByAgent[agent] = (queuedByAgent[agent] ?? 0) + 1
    }

    return { queuedByAgent }
  } catch {
    return { queuedByAgent: {} }
  }
}

export const Route = createFileRoute('/api/crew-status')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ error: 'Unauthorized' }, { status: 401 })
        }

        await ensureGatewayProbed()
        const taskCounts = await fetchAssignedTaskCounts()
        const jobCounts = await fetchSchedulerTaskCounts()
        const crewDefinitions = buildCrewDefinitions()

        const crew = await Promise.all(crewDefinitions.map(async (member) => {
          const nyxHome = getNyxHome(member.profilePath)
          const profileFound = existsSync(nyxHome)

          if (!profileFound) {
            return {
              id: member.id,
              displayName: member.displayName,
              role: member.role,
              profileFound: false,
              gatewayState: 'unknown',
              processAlive: false,
              platforms: {},
              model: 'unknown',
              provider: 'unknown',
              lastSessionTitle: null,
              lastSessionAt: null,
              sessionCount: 0,
              messageCount: 0,
              toolCallCount: 0,
              totalTokens: 0,
              estimatedCostUsd: null,
              cronJobCount: 0,
              assignedTaskCount: taskCounts[member.id] ?? 0,
              activeRunCount: 0,
              latestRun: null,
              lastFailure: null,
              lastHandoff: null,
              queuedJobCount: jobCounts.queuedByAgent[member.id] ?? 0,
            }
          }

          const gatewayInfo = readGatewayState(nyxHome)
          const dbStats = readDbStats(nyxHome)
          const config = readConfig(nyxHome)
          const runSummary = summarizeRuns(
            await listPersistedRuns({ limit: 25, workspaceHome: nyxHome }),
          )

          return {
            id: member.id,
            displayName: member.displayName,
            role: member.role,
            profileFound: true,
            gatewayState: gatewayInfo.gatewayState,
            processAlive: checkProcessAlive(gatewayInfo.pid),
            platforms: gatewayInfo.platforms,
            model: config.model,
            provider: config.provider,
            lastSessionTitle: dbStats.lastSessionTitle,
            lastSessionAt: dbStats.lastSessionAt,
            sessionCount: dbStats.sessionCount,
            messageCount: dbStats.messageCount,
            toolCallCount: dbStats.toolCallCount,
            totalTokens: dbStats.totalTokens,
            estimatedCostUsd: dbStats.estimatedCostUsd,
            cronJobCount: readCronJobCount(nyxHome),
            assignedTaskCount: taskCounts[member.id] ?? 0,
            activeRunCount: runSummary.activeRunCount,
            latestRun: runSummary.latestRun,
            lastFailure: runSummary.lastFailure,
            lastHandoff: runSummary.lastHandoff,
            queuedJobCount: jobCounts.queuedByAgent[member.id] ?? 0,
          }
        }))

        return json({ crew, fetchedAt: Date.now() })
      },
    },
  },
})

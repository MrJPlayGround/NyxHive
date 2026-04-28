import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { getNyxWorkspaceHome } from './workspace-home'

export type PersistedRunToolCall = {
  id: string
  name: string
  phase: string
  args?: unknown
  preview?: string
  result?: string
}

export type PersistedRunLifecycleEvent = {
  text: string
  emoji: string
  timestamp: number
  isError: boolean
}

export type PersistedRunState = {
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
  toolCalls: Array<PersistedRunToolCall>
  lifecycleEvents: Array<PersistedRunLifecycleEvent>
  errorMessage?: string
}

const STALE_RUN_AFTER_MS = 10 * 60_000
const ACTIVE_RUN_STATUSES: ReadonlySet<PersistedRunState['status']> = new Set([
  'accepted',
  'active',
  'handoff',
])
const ERROR_VISIBLE_STATUSES: ReadonlySet<PersistedRunState['status']> = new Set([
  'error',
  'stalled',
])
const mutationQueues = new Map<string, Promise<unknown>>()

export function isActivePersistedRunStatus(
  status: PersistedRunState['status'],
): boolean {
  return ACTIVE_RUN_STATUSES.has(status)
}

function shouldPreserveRunError(
  status: PersistedRunState['status'],
): boolean {
  return ERROR_VISIBLE_STATUSES.has(status)
}

function clearRunErrorIfRecovered<T extends PersistedRunState>(
  run: T,
): T {
  if (!run.errorMessage || shouldPreserveRunError(run.status)) return run
  return {
    ...run,
    errorMessage: undefined,
  }
}

function encodeSessionKey(sessionKey: string): string {
  return encodeURIComponent(sessionKey || 'main')
}

function runsRoot(workspaceHome = getNyxWorkspaceHome()): string {
  return path.join(workspaceHome, 'workspace', 'runs')
}

function sessionDir(sessionKey: string, workspaceHome?: string): string {
  return path.join(runsRoot(workspaceHome), encodeSessionKey(sessionKey))
}

function runPath(sessionKey: string, runId: string, workspaceHome?: string): string {
  return path.join(sessionDir(sessionKey, workspaceHome), `${runId}.json`)
}

function runMutationKey(sessionKey: string, runId: string): string {
  return `${sessionKey}\0${runId}`
}

async function runSerialized<T>(
  sessionKey: string,
  runId: string,
  task: () => Promise<T>,
): Promise<T> {
  const key = runMutationKey(sessionKey, runId)
  const previous = mutationQueues.get(key) ?? Promise.resolve()
  const next = previous.catch(() => undefined).then(task)
  const tracked = next
    .catch(() => undefined)
    .finally(() => {
      if (mutationQueues.get(key) === tracked) mutationQueues.delete(key)
    })
  mutationQueues.set(key, tracked)
  return next
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
}

async function writeRun(
  run: PersistedRunState,
  workspaceHome?: string,
): Promise<void> {
  const dir = sessionDir(run.sessionKey, workspaceHome)
  await ensureDir(dir)
  const finalPath = runPath(run.sessionKey, run.runId, workspaceHome)
  const tempPath = path.join(
    dir,
    `.${run.runId}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
  )
  try {
    await writeFile(tempPath, `${JSON.stringify(run, null, 2)}\n`, 'utf8')
    await rename(tempPath, finalPath)
  } catch (err) {
    await rm(tempPath, { force: true }).catch(() => undefined)
    throw err
  }
}

async function quarantineCorruptRunFile(filePath: string): Promise<void> {
  const corruptPath = `${filePath}.corrupt.${Date.now()}`
  await rename(filePath, corruptPath).catch(() => undefined)
}

async function readPersistedRunFile(
  filePath: string,
): Promise<PersistedRunState | null> {
  try {
    const raw = await readFile(filePath, 'utf8')
    return JSON.parse(raw) as PersistedRunState
  } catch {
    await quarantineCorruptRunFile(filePath)
    return null
  }
}

async function normalizeRunFreshness(
  run: PersistedRunState,
  workspaceHome?: string,
): Promise<PersistedRunState> {
  const now = Date.now()
  let nextRun = run
  let changed = false

  if (
    nextRun.status !== 'complete' &&
    nextRun.status !== 'error' &&
    nextRun.status !== 'stalled' &&
    now - nextRun.lastEventAt >= STALE_RUN_AFTER_MS
  ) {
    nextRun = {
      ...nextRun,
      status: 'stalled',
      updatedAt: now,
    }
    changed = true
  }
  const healedRun = clearRunErrorIfRecovered(nextRun)
  if (healedRun !== nextRun) {
    nextRun = healedRun
    changed = true
  }
  if (changed) await writeRun(nextRun, workspaceHome)
  return nextRun
}

export async function createPersistedRun(input: {
  runId: string
  sessionKey: string
  friendlyId?: string
  conversationMode?: 'quick' | 'task' | 'build' | 'deep'
  runtimePosture?: 'conversation' | 'investigation' | 'execution' | 'reflection'
}): Promise<PersistedRunState> {
  const now = Date.now()
  const run: PersistedRunState = {
    runId: input.runId,
    sessionKey: input.sessionKey,
    friendlyId: input.friendlyId || input.sessionKey,
    conversationMode: input.conversationMode,
    runtimePosture: input.runtimePosture,
    status: 'accepted',
    createdAt: now,
    updatedAt: now,
    lastEventAt: now,
    assistantText: '',
    thinkingText: '',
    toolCalls: [],
    lifecycleEvents: [],
  }
  await runSerialized(input.sessionKey, input.runId, () => writeRun(run))
  return run
}

export async function getPersistedRun(
  sessionKey: string,
  runId: string,
): Promise<PersistedRunState | null> {
  try {
    const raw = await readFile(runPath(sessionKey, runId), 'utf8')
    return JSON.parse(raw) as PersistedRunState
  } catch {
    return null
  }
}

export async function updatePersistedRun(
  sessionKey: string,
  runId: string,
  updater: (run: PersistedRunState) => PersistedRunState,
): Promise<PersistedRunState | null> {
  return runSerialized(sessionKey, runId, async () => {
    const current = await getPersistedRun(sessionKey, runId)
    if (!current) return null
    const next = updater(current)
    next.updatedAt = Date.now()
    await writeRun(next)
    return next
  })
}

export async function appendRunText(
  sessionKey: string,
  runId: string,
  text: string,
  options?: { replace?: boolean },
): Promise<PersistedRunState | null> {
  return updatePersistedRun(sessionKey, runId, (run) =>
    clearRunErrorIfRecovered({
      ...run,
      status: 'active',
      lastEventAt: Date.now(),
      assistantText: options?.replace ? text : `${run.assistantText}${text}`,
    }),
  )
}

export async function setRunThinking(
  sessionKey: string,
  runId: string,
  thinkingText: string,
): Promise<PersistedRunState | null> {
  return updatePersistedRun(sessionKey, runId, (run) =>
    clearRunErrorIfRecovered({
      ...run,
      status: 'active',
      lastEventAt: Date.now(),
      thinkingText,
    }),
  )
}

export async function upsertRunToolCall(
  sessionKey: string,
  runId: string,
  toolCall: PersistedRunToolCall,
): Promise<PersistedRunState | null> {
  return updatePersistedRun(sessionKey, runId, (run) => {
    const nextToolCalls = [...run.toolCalls]
    const idx = nextToolCalls.findIndex((entry) => entry.id === toolCall.id)
    if (idx >= 0) nextToolCalls[idx] = { ...nextToolCalls[idx], ...toolCall }
    else nextToolCalls.push(toolCall)
    const nextStatus =
      run.status === 'accepted' || run.status === 'stalled'
        ? 'active'
        : run.status

    return clearRunErrorIfRecovered({
      ...run,
      status: nextStatus,
      lastEventAt: Date.now(),
      toolCalls: nextToolCalls,
    })
  })
}

export async function addRunLifecycleEvent(
  sessionKey: string,
  runId: string,
  event: PersistedRunLifecycleEvent,
): Promise<PersistedRunState | null> {
  return updatePersistedRun(sessionKey, runId, (run) => ({
    ...run,
    lastEventAt: Date.now(),
    lifecycleEvents: [...run.lifecycleEvents, event].slice(-40),
  }))
}

export async function markRunStatus(
  sessionKey: string,
  runId: string,
  status: PersistedRunState['status'],
  errorMessage?: string,
): Promise<PersistedRunState | null> {
  return updatePersistedRun(sessionKey, runId, (run) =>
    clearRunErrorIfRecovered({
      ...run,
      status,
      lastEventAt: Date.now(),
      ...(shouldPreserveRunError(status) && errorMessage ? { errorMessage } : {}),
    }),
  )
}

export async function getActiveRunForSession(
  sessionKey: string,
): Promise<PersistedRunState | null> {
  try {
    const dir = sessionDir(sessionKey)
    const files = (await readdir(dir)).filter((name) => name.endsWith('.json'))
    if (files.length === 0) return null
    const runs = await Promise.all(
      files.map((name) => readPersistedRunFile(path.join(dir, name))),
    )
    const normalizedRuns = await Promise.all(
      runs.map(async (run) => {
        if (!run) return null
        return normalizeRunFreshness(run)
      }),
    )
    const candidates = normalizedRuns
      .filter((run): run is PersistedRunState => Boolean(run))
      .filter((run) => isActivePersistedRunStatus(run.status))
      .sort((a, b) => b.updatedAt - a.updatedAt)
    return candidates[0] ?? null
  } catch {
    return null
  }
}

export async function listPersistedRuns(options?: {
  limit?: number
  workspaceHome?: string
}): Promise<PersistedRunState[]> {
  const limit = Math.max(1, options?.limit ?? 20)
  const workspaceHome = options?.workspaceHome

  try {
    const root = runsRoot(workspaceHome)
    const sessionNames = await readdir(root)
    const runs = await Promise.all(
      sessionNames.map(async (sessionName) => {
        const dir = path.join(root, sessionName)
        const files = await readdir(dir).catch(() => [])
        return Promise.all(
          files
            .filter((name) => name.endsWith('.json'))
            .map(async (name) => {
              const run = await readPersistedRunFile(path.join(dir, name))
              if (!run) return null
              return normalizeRunFreshness(run, workspaceHome)
            }),
        )
      }),
    )

    return runs
      .flat(2)
      .filter((run): run is PersistedRunState => Boolean(run))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit)
  } catch {
    return []
  }
}

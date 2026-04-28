import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { getNyxWorkspaceHome } from './workspace-home'

export type OperationMissionMode = 'quick' | 'task' | 'build' | 'deep'
export type OperationMissionAutonomy = 'low' | 'medium' | 'high'
export type OperationMissionStatus =
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'paused'

export type OperationMissionRecord = {
  id: string
  goal: string
  mode: OperationMissionMode
  profile: string
  autonomy: OperationMissionAutonomy
  model: string | null
  status: OperationMissionStatus
  createdAt: string
  updatedAt: string
  jobId: string | null
  sessionKey: string | null
  runId: string | null
  taskIds: string[]
  lastError: string | null
}

type MissionFile = {
  missions: OperationMissionRecord[]
}

const storeQueue = { current: Promise.resolve() as Promise<unknown> }

function operationsDir(): string {
  return path.join(getNyxWorkspaceHome(), 'workspace', 'operations')
}

function missionsPath(): string {
  return path.join(operationsDir(), 'missions.json')
}

async function ensureStore(): Promise<void> {
  const filePath = missionsPath()
  await mkdir(path.dirname(filePath), { recursive: true })
  try {
    await readFile(filePath, 'utf8')
  } catch {
    await writeFile(filePath, `${JSON.stringify({ missions: [] }, null, 2)}\n`, 'utf8')
  }
}

async function withStoreLock<T>(task: () => Promise<T>): Promise<T> {
  const previous = storeQueue.current
  const next = previous.catch(() => undefined).then(task)
  storeQueue.current = next.catch(() => undefined)
  return next
}

function normalizeMission(
  mission: Partial<OperationMissionRecord> & Pick<OperationMissionRecord, 'id' | 'goal'>,
): OperationMissionRecord {
  const now = new Date().toISOString()
  return {
    id: mission.id,
    goal: mission.goal.trim(),
    mode: mission.mode ?? 'task',
    profile: mission.profile?.trim() || 'nyx',
    autonomy: mission.autonomy ?? 'medium',
    model: mission.model?.trim() || null,
    status: mission.status ?? 'queued',
    createdAt: mission.createdAt ?? now,
    updatedAt: mission.updatedAt ?? mission.createdAt ?? now,
    jobId: mission.jobId ?? null,
    sessionKey: mission.sessionKey ?? null,
    runId: mission.runId ?? null,
    taskIds: Array.isArray(mission.taskIds) ? mission.taskIds : [],
    lastError: mission.lastError ?? null,
  }
}

async function readMissionFile(): Promise<MissionFile> {
  await ensureStore()
  try {
    const raw = (await readFile(missionsPath(), 'utf8')).trim()
    if (!raw) return { missions: [] }
    const parsed = JSON.parse(raw) as Partial<MissionFile>
    return {
      missions: Array.isArray(parsed.missions)
        ? parsed.missions.map((mission) =>
            normalizeMission(mission as Partial<OperationMissionRecord> &
              Pick<OperationMissionRecord, 'id' | 'goal'>),
          )
        : [],
    }
  } catch {
    return { missions: [] }
  }
}

async function writeMissionFile(data: MissionFile): Promise<void> {
  await ensureStore()
  await writeFile(
    missionsPath(),
    `${JSON.stringify({ missions: data.missions.map(normalizeMission) }, null, 2)}\n`,
    'utf8',
  )
}

export async function createOperationMission(input: {
  goal: string
  mode: OperationMissionMode
  profile: string
  autonomy: OperationMissionAutonomy
  model: string | null
}): Promise<OperationMissionRecord> {
  return withStoreLock(async () => {
    const file = await readMissionFile()
    const now = new Date().toISOString()
    const mission = normalizeMission({
      id: randomUUID(),
      goal: input.goal,
      mode: input.mode,
      profile: input.profile,
      autonomy: input.autonomy,
      model: input.model,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
    })
    file.missions.push(mission)
    await writeMissionFile(file)
    return mission
  })
}

export async function listOperationMissions(): Promise<OperationMissionRecord[]> {
  const file = await readMissionFile()
  return [...file.missions].sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

export async function getOperationMission(
  missionId: string,
): Promise<OperationMissionRecord | null> {
  const missions = await listOperationMissions()
  return missions.find((mission) => mission.id === missionId) ?? null
}

export async function updateOperationMission(
  missionId: string,
  updates: Partial<Omit<OperationMissionRecord, 'id' | 'createdAt'>>,
): Promise<OperationMissionRecord | null> {
  return withStoreLock(async () => {
    const file = await readMissionFile()
    const index = file.missions.findIndex((mission) => mission.id === missionId)
    if (index === -1) return null

    const current = file.missions[index]
    const next = normalizeMission({
      ...current,
      ...updates,
      id: current.id,
      goal: current.goal,
      createdAt: current.createdAt,
      updatedAt: new Date().toISOString(),
    })

    file.missions[index] = next
    await writeMissionFile(file)
    return next
  })
}

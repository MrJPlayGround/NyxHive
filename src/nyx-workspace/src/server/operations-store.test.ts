import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const previousHome = process.env.NYX_WORKSPACE_HOME
const testHome = mkdtempSync(join(tmpdir(), 'nyx-operations-store-test-'))
process.env.NYX_WORKSPACE_HOME = testHome

const {
  createOperationMission,
  getOperationMission,
  listOperationMissions,
  updateOperationMission,
} = await import('./operations-store')

afterAll(() => {
  if (previousHome === undefined) delete process.env.NYX_WORKSPACE_HOME
  else process.env.NYX_WORKSPACE_HOME = previousHome
  rmSync(testHome, { recursive: true, force: true })
})

describe('operations mission store', () => {
  test('creates, updates, and lists persisted missions newest-first', async () => {
    const first = await createOperationMission({
      goal: 'Audit the interrupt path',
      mode: 'deep',
      profile: 'nyx',
      autonomy: 'high',
      model: 'gpt-5.4',
    })

    await new Promise((resolve) => setTimeout(resolve, 5))

    const second = await createOperationMission({
      goal: 'Review the open scheduler backlog',
      mode: 'task',
      profile: 'workspace',
      autonomy: 'medium',
      model: null,
    })

    const updated = await updateOperationMission(first.id, {
      status: 'running',
      jobId: 'job-123',
      sessionKey: 'session-ops',
      runId: 'run-ops',
    })

    expect(updated).toMatchObject({
      id: first.id,
      status: 'running',
      jobId: 'job-123',
      sessionKey: 'session-ops',
      runId: 'run-ops',
    })

    expect(await getOperationMission(first.id)).toMatchObject({
      goal: 'Audit the interrupt path',
      model: 'gpt-5.4',
    })

    expect(await listOperationMissions()).toMatchObject([
      { id: second.id, goal: 'Review the open scheduler backlog' },
      { id: first.id, goal: 'Audit the interrupt path', status: 'running' },
    ])
  })
})

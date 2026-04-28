import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const previousHome = process.env.NYX_WORKSPACE_HOME
const testHome = mkdtempSync(join(tmpdir(), 'nyx-run-store-test-'))
process.env.NYX_WORKSPACE_HOME = testHome

const {
  createPersistedRun,
  addRunLifecycleEvent,
  getActiveRunForSession,
  getPersistedRun,
  listPersistedRuns,
  markRunStatus,
  upsertRunToolCall,
  updatePersistedRun,
} = await import('./run-store')

afterAll(() => {
  if (previousHome === undefined) delete process.env.NYX_WORKSPACE_HOME
  else process.env.NYX_WORKSPACE_HOME = previousHome
  rmSync(testHome, { recursive: true, force: true })
})

describe('workspace run store', () => {
  test('returns active runs and hides terminal runs', async () => {
    await createPersistedRun({
      runId: 'run-active',
      sessionKey: 'session-active',
    })

    expect(await getActiveRunForSession('session-active')).toMatchObject({
      runId: 'run-active',
      status: 'accepted',
    })

    await markRunStatus('session-active', 'run-active', 'complete')

    expect(await getActiveRunForSession('session-active')).toBeNull()
  })

  test('marks old nonterminal runs as stalled and excludes them from active lookup', async () => {
    await createPersistedRun({
      runId: 'run-stale',
      sessionKey: 'session-stale',
    })
    const staleAt = Date.now() - 601_000
    await updatePersistedRun('session-stale', 'run-stale', (run) => ({
      ...run,
      status: 'active',
      updatedAt: staleAt,
      lastEventAt: staleAt,
    }))

    expect(await getActiveRunForSession('session-stale')).toBeNull()
    expect(await getPersistedRun('session-stale', 'run-stale')).toMatchObject({
      runId: 'run-stale',
      status: 'stalled',
    })
  })

  test('serializes concurrent run updates without dropping lifecycle events', async () => {
    await createPersistedRun({
      runId: 'run-concurrent',
      sessionKey: 'session-concurrent',
    })

    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        addRunLifecycleEvent('session-concurrent', 'run-concurrent', {
          text: `event-${index}`,
          emoji: '',
          timestamp: Date.now() + index,
          isError: false,
        }),
      ),
    )

    const run = await getPersistedRun('session-concurrent', 'run-concurrent')
    expect(run?.lifecycleEvents).toHaveLength(20)
    expect(run?.lifecycleEvents.map((event) => event.text).sort()).toEqual(
      Array.from({ length: 20 }, (_, index) => `event-${index}`).sort(),
    )
  })

  test('quarantines corrupt run files during active lookup', async () => {
    const sessionKey = 'session-corrupt'
    const runId = 'run-corrupt'
    const dir = join(testHome, 'workspace', 'runs', sessionKey)
    const filePath = join(dir, `${runId}.json`)
    mkdirSync(dir, { recursive: true })
    writeFileSync(filePath, '{"runId":"run-corrupt"} trailing garbage', 'utf8')

    expect(await getActiveRunForSession(sessionKey)).toBeNull()
    expect(existsSync(filePath)).toBe(false)
    expect(readdirSync(dir).some((name) => name.includes('.corrupt.'))).toBe(
      true,
    )
  })

  test('lists recent persisted runs across sessions for the operations ledger', async () => {
    await createPersistedRun({
      runId: 'run-ledger-a',
      sessionKey: 'session-ledger-a',
      friendlyId: 'Mission A',
      conversationMode: 'deep',
      runtimePosture: 'execution',
    })
    await createPersistedRun({
      runId: 'run-ledger-b',
      sessionKey: 'session-ledger-b',
      friendlyId: 'Mission B',
      conversationMode: 'task',
      runtimePosture: 'investigation',
    })

    await updatePersistedRun('session-ledger-a', 'run-ledger-a', (run) => ({
      ...run,
      status: 'active',
      updatedAt: Date.now() - 5_000,
      lastEventAt: Date.now() - 5_000,
      assistantText: 'Investigating the interrupt path',
    }))
    await new Promise((resolve) => setTimeout(resolve, 5))
    await updatePersistedRun('session-ledger-b', 'run-ledger-b', (run) => ({
      ...run,
      status: 'error',
      errorMessage: 'Scheduler trigger failed',
      updatedAt: Date.now(),
      lastEventAt: Date.now(),
    }))

    const runs = await listPersistedRuns({ limit: 2 })

    expect(runs).toHaveLength(2)
    expect(runs[0]).toMatchObject({
      runId: 'run-ledger-b',
      sessionKey: 'session-ledger-b',
      status: 'error',
      errorMessage: 'Scheduler trigger failed',
    })
    expect(runs[1]).toMatchObject({
      runId: 'run-ledger-a',
      sessionKey: 'session-ledger-a',
      assistantText: 'Investigating the interrupt path',
      conversationMode: 'deep',
    })
  })

  test('keeps active runs active when a tool call errors', async () => {
    await createPersistedRun({
      runId: 'run-tool-error',
      sessionKey: 'session-tool-error',
    })
    await updatePersistedRun('session-tool-error', 'run-tool-error', (run) => ({
      ...run,
      status: 'active',
      assistantText: 'Still working',
    }))

    await upsertRunToolCall('session-tool-error', 'run-tool-error', {
      id: 'tool-error-1',
      name: 'exec_command',
      phase: 'error',
      result: 'lsof: duplicate TCP inclusion: LISTEN',
    })

    const run = await getPersistedRun('session-tool-error', 'run-tool-error')
    expect(run).toMatchObject({
      runId: 'run-tool-error',
      status: 'active',
      assistantText: 'Still working',
    })
    expect(run?.errorMessage).toBeUndefined()
    expect(await getActiveRunForSession('session-tool-error')).toMatchObject({
      runId: 'run-tool-error',
      status: 'active',
    })
  })

  test('heals stale error text on active runs when listing persisted runs', async () => {
    const sessionKey = 'session-heal-active'
    const runId = 'run-heal-active'
    const dir = join(testHome, 'workspace', 'runs', sessionKey)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, `${runId}.json`),
      JSON.stringify({
        runId,
        sessionKey,
        friendlyId: sessionKey,
        status: 'active',
        createdAt: Date.now() - 1_000,
        updatedAt: Date.now(),
        lastEventAt: Date.now(),
        assistantText: 'Recovered and still working',
        thinkingText: '',
        toolCalls: [],
        lifecycleEvents: [],
        errorMessage: 'old transient tool failure',
      }),
      'utf8',
    )

    const runs = await listPersistedRuns({ limit: 5 })
    const healed = runs.find((run) => run.runId === runId)

    expect(healed).toMatchObject({
      runId,
      status: 'active',
      assistantText: 'Recovered and still working',
    })
    expect(healed?.errorMessage).toBeUndefined()
    expect(await getPersistedRun(sessionKey, runId)).toMatchObject({
      runId,
      status: 'active',
    })
    expect((await getPersistedRun(sessionKey, runId))?.errorMessage).toBeUndefined()
  })
})

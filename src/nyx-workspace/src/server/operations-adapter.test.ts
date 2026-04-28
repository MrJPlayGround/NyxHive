import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const previousHome = process.env.NYX_WORKSPACE_HOME
const testHome = mkdtempSync(join(tmpdir(), 'nyx-operations-adapter-test-'))
process.env.NYX_WORKSPACE_HOME = testHome

const { launchOperationMission, listOperationMissionSnapshots } = await import(
  './operations-adapter'
)

afterAll(() => {
  if (previousHome === undefined) delete process.env.NYX_WORKSPACE_HOME
  else process.env.NYX_WORKSPACE_HOME = previousHome
  rmSync(testHome, { recursive: true, force: true })
})

describe('operations adapter', () => {
  test('launches a mission, persists the record, and links the scheduler job', async () => {
    const createdPayloads: Array<Record<string, unknown>> = []
    const triggeredJobIds: string[] = []

    const mission = await launchOperationMission(
      {
        goal: 'Map the Discord continuity regressions',
        mode: 'deep',
        profile: 'nyx',
        autonomy: 'high',
        model: 'gpt-5.4',
      },
      {
        createSchedulerTask: async (payload) => {
          createdPayloads.push(payload)
          return {
            id: 'job-launch-1',
            name: String(payload.name ?? ''),
            prompt: String(payload.prompt ?? ''),
            enabled: true,
            last_status: null,
            run_count: 0,
          }
        },
        triggerSchedulerTask: async (jobId) => {
          triggeredJobIds.push(jobId)
        },
        listSchedulerTasks: async () => [
          {
            id: 'job-launch-1',
            name: 'Mission: Map the Discord continuity regressions',
            prompt: 'irrelevant',
            enabled: true,
            last_status: 'completed',
            run_count: 1,
            last_run_at: Date.parse('2026-04-23T12:00:00.000Z'),
          },
        ],
      },
    )

    expect(createdPayloads).toHaveLength(1)
    expect(createdPayloads[0]).toMatchObject({
      agent: 'nyx',
      authority_profile: 'scheduled',
      name: 'Mission: Map the Discord continuity regressions',
    })
    expect(String(createdPayloads[0].prompt)).toContain(
      'Mission goal: Map the Discord continuity regressions',
    )
    expect(String(createdPayloads[0].prompt)).toContain('Conversation mode: deep')
    expect(String(createdPayloads[0].prompt)).toContain('Autonomy: high')
    expect(triggeredJobIds).toEqual(['job-launch-1'])
    expect(mission).toMatchObject({
      goal: 'Map the Discord continuity regressions',
      jobId: 'job-launch-1',
      status: 'queued',
    })

    const snapshots = await listOperationMissionSnapshots({
      listSchedulerTasks: async () => [
        {
          id: 'job-launch-1',
          name: 'Mission: Map the Discord continuity regressions',
          prompt: 'irrelevant',
          enabled: true,
          last_status: 'completed',
          run_count: 1,
          last_run_at: Date.parse('2026-04-23T12:00:00.000Z'),
        },
      ],
    })

    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]).toMatchObject({
      id: mission.id,
      jobId: 'job-launch-1',
      status: 'completed',
      lastRunAt: '2026-04-23T12:00:00.000Z',
    })
  })
})

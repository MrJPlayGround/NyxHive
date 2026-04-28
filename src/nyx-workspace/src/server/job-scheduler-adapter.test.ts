import { describe, expect, test } from 'bun:test'
import {
  jobInputToSchedulerTask,
  schedulerTaskToJob,
  schedulerTaskResultToJobOutput,
} from './job-scheduler-adapter'

describe('workspace jobs scheduler adapter', () => {
  test('maps scheduler tasks into workspace jobs', () => {
    const job = schedulerTaskToJob({
      id: 'task-1',
      name: 'Daily briefing',
      prompt: 'Summarize the day',
      cron_expression: '0 9 * * *',
      schedule_human: 'Daily at 9am',
      enabled: 1,
      next_run_at: 1776600000000,
      last_run_at: 1776510000000,
      last_status: 'completed',
      run_count: 3,
    })

    expect(job).toMatchObject({
      id: 'task-1',
      name: 'Daily briefing',
      prompt: 'Summarize the day',
      schedule_display: 'Daily at 9am',
      enabled: true,
      state: 'scheduled',
      next_run_at: '2026-04-19T12:00:00.000Z',
      last_run_at: '2026-04-18T11:00:00.000Z',
      last_run_success: true,
      run_count: 3,
    })
  })

  test('maps paused scheduler tasks into paused jobs', () => {
    const job = schedulerTaskToJob({
      id: 'task-2',
      name: 'Paused',
      prompt: 'Wait',
      cron_expression: '*/30 * * * *',
      enabled: 0,
      next_run_at: 1776600000000,
      last_run_at: null,
      last_status: null,
      run_count: 0,
    })

    expect(job.enabled).toBe(false)
    expect(job.state).toBe('paused')
    expect(job.last_run_success).toBeNull()
  })

  test('converts preset schedules into scheduler cron expressions', () => {
    expect(
      jobInputToSchedulerTask({
        name: 'Check in',
        schedule: 'every 30m',
        prompt: 'Ping',
      }),
    ).toMatchObject({
      name: 'Check in',
      cron_expression: '*/30 * * * *',
      prompt: 'Ping',
      agent: 'nyx',
      channel: 'api',
    })
  })

  test('passes through raw cron schedules and telegram delivery', () => {
    expect(
      jobInputToSchedulerTask({
        name: 'Weekly',
        schedule: '0 9 * * 1',
        prompt: 'Report',
        deliver: ['telegram'],
      }),
    ).toMatchObject({
      cron_expression: '0 9 * * 1',
      channel: 'telegram',
    })
  })

  test('turns scheduler task results into workspace output cards', () => {
    const outputs = schedulerTaskResultToJobOutput({
      task_name: 'Daily briefing',
      agent: 'nyx',
      last_status: 'completed',
      last_result: 'All clear.',
      last_run_at: 1776510000000,
    })

    expect(outputs).toEqual([
      {
        filename: 'Daily briefing',
        timestamp: '2026-04-18T11:00:00.000Z',
        content: 'All clear.',
        size: 10,
      },
    ])
  })
})

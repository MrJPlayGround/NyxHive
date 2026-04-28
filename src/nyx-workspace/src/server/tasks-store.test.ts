import { afterAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const previousHome = process.env.NYX_WORKSPACE_HOME
const testHome = mkdtempSync(join(tmpdir(), 'nyx-reminders-test-'))
process.env.NYX_WORKSPACE_HOME = testHome

const { completeReminder, createReminder, listReminders } = await import(
  './tasks-store'
)

afterAll(() => {
  if (previousHome === undefined) delete process.env.NYX_WORKSPACE_HOME
  else process.env.NYX_WORKSPACE_HOME = previousHome
  rmSync(testHome, { recursive: true, force: true })
})

describe('workspace reminders', () => {
  test('creates, lists, and completes timezone-aware reminders', () => {
    const reminder = createReminder({
      title: 'Water the plants',
      remindAt: '2026-04-17T09:00:00+01:00',
      timezone: 'Europe/Lisbon',
      createdBy: 'test',
    })

    expect(reminder.tags).toContain('reminder')
    expect(reminder.tags).toContain('tz:Europe/Lisbon')
    expect(reminder.due_date).toBe('2026-04-17T08:00:00.000Z')
    expect(listReminders().some((entry) => entry.id === reminder.id)).toBe(true)

    const completed = completeReminder(reminder.id)
    expect(completed?.column).toBe('done')
    expect(listReminders().some((entry) => entry.id === reminder.id)).toBe(false)
    expect(listReminders(true).some((entry) => entry.id === reminder.id)).toBe(true)
  })
})

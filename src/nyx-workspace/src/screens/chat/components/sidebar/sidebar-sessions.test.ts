import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { isRuntimeActiveSession } from './sidebar-sessions'

const root = process.cwd()

function sidebarSource(): string {
  return readFileSync(
    join(
      root,
      'src/nyx-workspace/src/screens/chat/components/sidebar/sidebar-sessions.tsx',
    ),
    'utf8',
  )
}

describe('sidebar sessions refresh chrome', () => {
  test('keeps initial loading copy but hides background refresh chatter', () => {
    const source = sidebarSource()

    expect(source).toContain('Loading sessions…')
    expect(source).not.toContain('Updating…')
  })
})

describe('sidebar runtime activity', () => {
  test('matches active runtime sessions by canonical or friendly id', () => {
    const session = {
      key: 'canonical-1',
      friendlyId: 'friendly-1',
    } as any

    expect(isRuntimeActiveSession(session, new Set(['canonical-1']))).toBe(true)
    expect(isRuntimeActiveSession(session, new Set(['friendly-1']))).toBe(true)
    expect(isRuntimeActiveSession(session, new Set(['other']))).toBe(false)
  })
})

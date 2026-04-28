import { describe, expect, test } from 'bun:test'
import { formatEngineUpdateStatus } from '../nyx/commands/updates.js'

describe('nyx updates command', () => {
  test('formats update_available compactly', () => {
    const line = formatEngineUpdateStatus({
      workspaceId: 'astra-trading',
      state: 'update_available',
      reason: 'Engine advanced from abc123 to def456',
      current: {
        source: 'local-git',
        path: '/engine',
        ref: 'master',
        commit: 'def456',
      },
      locked: {
        engine: {
          source: 'local-git',
          path: '/engine',
          ref: 'master',
          commit: 'abc123',
        },
      },
    })

    expect(line).toContain('astra-trading')
    expect(line).toContain('update_available')
    expect(line).toContain('abc123')
    expect(line).toContain('def456')
  })
})

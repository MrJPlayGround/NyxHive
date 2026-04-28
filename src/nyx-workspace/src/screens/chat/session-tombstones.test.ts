import { afterEach, describe, expect, test } from 'bun:test'
import {
  clearSessionDeletedIds,
  filterSessionsWithTombstones,
  markSessionDeletedIds,
} from './session-tombstones'

const realDateNow = Date.now

afterEach(() => {
  Date.now = realDateNow
  clearSessionDeletedIds('canonical-id', 'friendly-id', 'other-id')
})

describe('session tombstones', () => {
  test('hides sessions by either canonical key or friendly id', () => {
    const sessions = [
      { key: 'canonical-id', friendlyId: 'friendly-id', title: 'target' },
      { key: 'other-id', friendlyId: 'other-id', title: 'other' },
    ]

    markSessionDeletedIds('friendly-id')

    expect(filterSessionsWithTombstones(sessions)).toEqual([sessions[1]])
  })

  test('keeps a session hidden while any matching tombstone is still active', () => {
    const sessions = [
      { key: 'canonical-id', friendlyId: 'friendly-id', title: 'target' },
    ]

    Date.now = () => 1_000
    markSessionDeletedIds('canonical-id')
    Date.now = () => 1_001
    markSessionDeletedIds('friendly-id')
    Date.now = () => 9_000

    expect(filterSessionsWithTombstones(sessions)).toEqual([])
  })
})

test('keeps a deleted session hidden after ttl until server list confirms it is gone', () => {
  const sessions = [
    { key: 'canonical-id', friendlyId: 'friendly-id', title: 'target' },
    { key: 'other-id', friendlyId: 'other-id', title: 'other' },
  ]

  Date.now = () => 1_000
  markSessionDeletedIds('canonical-id')
  Date.now = () => 20_000

  expect(filterSessionsWithTombstones(sessions)).toEqual([sessions[1]])

  // Once a fresh server list no longer contains the deleted id, the expired
  // tombstone is pruned and a future unrelated session using a different id is
  // unaffected.
  expect(filterSessionsWithTombstones([sessions[1]])).toEqual([sessions[1]])
})

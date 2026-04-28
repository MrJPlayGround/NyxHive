import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import {
  fetchOperationMissions,
  fetchTradingLaneSnapshot,
} from './operations-api'

const originalFetch = globalThis.fetch

describe('operations api client', () => {
  beforeEach(() => {
    globalThis.fetch = mock()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test('surfaces a stale-server error when operations missions return HTML instead of JSON', async () => {
    ;(globalThis.fetch as ReturnType<typeof mock>).mockResolvedValue(
      new Response('<!DOCTYPE html><title>Nyx Workspace</title>', {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      }),
    )

    await expect(fetchOperationMissions()).rejects.toThrow(
      'The workspace or gateway is likely stale and needs a restart.',
    )
  })

  test('treats HTML payloads as stale trading-lane responses even when the server lies about content type', async () => {
    ;(globalThis.fetch as ReturnType<typeof mock>).mockResolvedValue(
      new Response('<!DOCTYPE html><title>Gateway</title>', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    await expect(fetchTradingLaneSnapshot()).rejects.toThrow(
      'The workspace or gateway is likely stale and needs a restart.',
    )
  })
})

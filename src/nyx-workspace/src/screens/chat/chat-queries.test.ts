import { describe, expect, test } from 'bun:test'
import { QueryClient } from '@tanstack/react-query'
import {
  chatQueryKeys,
  removeSessionFromCache,
} from './chat-queries'
import type { HistoryResponse, SessionMeta } from './types'

describe('chat query cache cleanup', () => {
  test('removeSessionFromCache removes session and every history query containing canonical or friendly id', () => {
    const queryClient = new QueryClient()
    const deleted: SessionMeta = {
      key: 'canonical-id',
      friendlyId: 'friendly-id',
      title: 'delete me',
    }
    const kept: SessionMeta = {
      key: 'other-id',
      friendlyId: 'other-friendly',
      title: 'keep me',
    }

    queryClient.setQueryData(chatQueryKeys.sessions, [deleted, kept])
    queryClient.setQueryData(chatQueryKeys.history('friendly-id', 'canonical-id'), {
      sessionKey: 'canonical-id',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'gone' }] }],
    } satisfies HistoryResponse)
    queryClient.setQueryData(chatQueryKeys.history('route-alias', 'canonical-id'), {
      sessionKey: 'canonical-id',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'gone alias' }] }],
    } satisfies HistoryResponse)
    queryClient.setQueryData(chatQueryKeys.history('other-friendly', 'other-id'), {
      sessionKey: 'other-id',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'keep' }] }],
    } satisfies HistoryResponse)

    removeSessionFromCache(queryClient, 'canonical-id', 'friendly-id')

    expect(queryClient.getQueryData(chatQueryKeys.sessions)).toEqual([kept])
    expect(queryClient.getQueryData(chatQueryKeys.history('friendly-id', 'canonical-id'))).toBeUndefined()
    expect(queryClient.getQueryData(chatQueryKeys.history('route-alias', 'canonical-id'))).toBeUndefined()
    expect(queryClient.getQueryData(chatQueryKeys.history('other-friendly', 'other-id'))).toBeDefined()
  })
})

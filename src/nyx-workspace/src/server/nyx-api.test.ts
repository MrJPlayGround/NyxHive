import { describe, expect, test } from 'bun:test'
import { toSessionFiles } from './attachment-payloads'
import { normalizeMessageListResponse } from './message-list-payload'
import { normalizeSessionListResponse } from './session-list-payload'

describe('nyx api attachment payload helpers', () => {
  test('converts workspace attachments into session file payloads', () => {
    expect(
      toSessionFiles([
        {
          name: 'screenshot.png',
          contentType: 'image/png',
          dataUrl: 'data:image/png;base64,aGVsbG8=',
        },
      ]),
    ).toEqual([
      {
        name: 'screenshot.png',
        type: 'image/png',
        data: 'aGVsbG8=',
      },
    ])
  })
})

describe('nyx api message payload helpers', () => {
  test('normalizes NyxHive session detail messages', () => {
    const messages = normalizeMessageListResponse(
      {
        messages: [
          {
            id: 'message-1',
            role: 'user',
            content: 'Hello Nyx',
            created_at: 1_700_000_000_000,
          },
        ],
      },
      'session-1',
    )

    expect(messages).toEqual([
      {
        id: 'message-1',
        session_id: 'session-1',
        role: 'user',
        content: 'Hello Nyx',
        timestamp: 1_700_000_000,
        tool_calls: null,
        tool_name: null,
      },
    ])
  })

  test('normalizes portable message items payloads', () => {
    expect(
      normalizeMessageListResponse(
        {
          items: [
            {
              id: 'portable-message',
              session_id: 'portable-session',
              role: 'assistant',
              content: 'Done',
              timestamp: 1,
            },
          ],
        },
        'ignored-session',
      ),
    ).toEqual([
      {
        id: 'portable-message',
        session_id: 'portable-session',
        role: 'assistant',
        content: 'Done',
        timestamp: 1,
      },
    ])
  })
})

describe('nyx api session payload helpers', () => {
  test('normalizes NyxHive session-list payloads when workspace mode env is absent', () => {
    const sessions = normalizeSessionListResponse({
      sessions: [
        {
          session_id: 'session-1',
          title: 'Live thread',
          agent: 'nyx',
          created_at: 1_700_000_000_000,
          updated_at: 1_700_000_060_000,
          message_count: 3,
        },
      ],
      total: 1,
    })

    expect(sessions).toEqual([
      {
        id: 'session-1',
        source: 'nyxhive',
        model: 'nyx',
        title: 'Live thread',
        started_at: 1_700_000_000,
        ended_at: null,
        last_active: 1_700_000_060,
        message_count: 3,
      },
    ])
  })

  test('normalizes portable items payloads', () => {
    expect(
      normalizeSessionListResponse({
        items: [{ id: 'portable-1', title: 'Portable' }],
        total: 1,
      }),
    ).toEqual([{ id: 'portable-1', title: 'Portable' }])
  })
})

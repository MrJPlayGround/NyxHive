import { describe, expect, test } from 'bun:test'
import { createSseParser } from './sse-parser'

describe('SSE parser', () => {
  test('flushes a final event even when the stream ends without a blank line', () => {
    const events: Array<{ event: string; data: string }> = []
    const parser = createSseParser((event) => events.push(event))

    parser.push('event: response\ndata: {"response":"done"}')
    parser.finish()

    expect(events).toEqual([{ event: 'response', data: '{"response":"done"}' }])
  })

  test('parses events split across chunks and preserves multi-line data', () => {
    const events: Array<{ event: string; data: string }> = []
    const parser = createSseParser((event) => events.push(event))

    parser.push('event: progress\ndata: {"a":')
    parser.push('1}\n\nevent: response\ndata: {"line":"one"}\n')
    parser.push('data: {"line":"two"}\n\n')

    expect(events).toEqual([
      { event: 'progress', data: '{"a":1}' },
      {
        event: 'response',
        data: '{"line":"one"}\n{"line":"two"}',
      },
    ])
  })
})

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()

function source(path: string): string {
  return readFileSync(join(root, path), 'utf8')
}

describe('gateway chat message layout width rules', () => {
  test('message bubbles use responsive desktop width classes', () => {
    const messageList = source('src/gateway/src/components/chat/MessageList.tsx')

    expect(messageList).toContain('GATEWAY_USER_BUBBLE_WIDTH_CLASS')
    expect(messageList).toContain('GATEWAY_ASSISTANT_BUBBLE_WIDTH_CLASS')
    expect(messageList).not.toContain('max-w-[min(82%,68ch)]')
    expect(messageList).not.toContain('max-w-[92ch]')
  })
})

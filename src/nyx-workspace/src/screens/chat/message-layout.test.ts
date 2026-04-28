import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = process.cwd()

function source(path: string): string {
  return readFileSync(join(root, path), 'utf8')
}

describe('chat message layout width rules', () => {
  test('workspace chat content and composer use the shared wide surface cap', () => {
    const container = source(
      'src/nyx-workspace/src/components/prompt-kit/chat-container.tsx',
    )
    const composer = source(
      'src/nyx-workspace/src/screens/chat/components/chat-composer.tsx',
    )

    expect(container).toContain('CHAT_SURFACE_MAX_WIDTH')
    expect(composer).toContain('CHAT_SURFACE_MAX_WIDTH')
    expect(container).not.toContain("maxWidth: 'min(768px, 100%)'")
    expect(composer).not.toContain("maxWidth: 'min(768px, 100%)'")
  })

  test('workspace message bubbles grow through desktop breakpoints', () => {
    const messageItem = source(
      'src/nyx-workspace/src/screens/chat/components/message-item.tsx',
    )

    expect(messageItem).toContain('CHAT_MESSAGE_BUBBLE_WIDTH_CLASS')
    expect(messageItem).not.toContain('max-w-[80%]')
  })

  test('user message text renders through markdown instead of a plain span', () => {
    const messageItem = source(
      'src/nyx-workspace/src/screens/chat/components/message-item.tsx',
    )

    expect(messageItem).not.toContain(
      '<span className="text-pretty">{displayText}</span>',
    )
    expect(messageItem).toContain('markdownVariant="inverse"')
  })
})

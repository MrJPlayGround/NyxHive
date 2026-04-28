import { describe, expect, test } from 'bun:test'
import {
  buildStreamingActivityTimeline,
  buildStreamingStatusDetail,
  deriveStreamingActivityState,
  formatStateAwareElapsedLabel,
  selectStreamingStatusToolSections,
  selectVisibleToolSections,
  shouldShowStreamingStatusWindow,
  type InlineToolSection,
} from './stream-activity'

function section(
  overrides: Partial<InlineToolSection> = {},
): InlineToolSection {
  return {
    key: 'tool-1',
    type: 'exec',
    input: undefined,
    preview: undefined,
    outputText: '',
    errorText: undefined,
    state: 'output-available',
    ...overrides,
  }
}

describe('stream activity UI tiers', () => {
  test('streaming lifecycle and tool telemetry uses one status window, not visible cards', () => {
    const runtimeOnlyTool = section({
      key: 'cmd-1',
      type: 'command_execution',
      input: { command: 'cat package.json' },
      state: 'input-available',
    })

    expect(selectVisibleToolSections([runtimeOnlyTool], true)).toEqual([])
    expect(
      shouldShowStreamingStatusWindow({
        isUser: false,
        isStreaming: true,
        hasRevealedText: false,
        hasStatusActivity: true,
      }),
    ).toBe(true)
  })

  test('completed no-detail commands are hidden from chat cards', () => {
    const completedNoDetailCommand = section({
      key: 'cmd-1',
      type: 'exec',
      input: { command: 'true' },
      outputText: '',
      state: 'output-available',
    })

    expect(
      selectVisibleToolSections([completedNoDetailCommand], false),
    ).toEqual([])
  })

  test('active command output stays behind debug trace, not the main status copy', () => {
    const activeCommandWithOutput = section({
      key: 'cmd-1',
      type: 'exec',
      input: { command: 'git log --oneline -1' },
      outputText: 'abc123 fix: collapse runtime telemetry',
      state: 'input-available',
    })

    const statusSections = selectStreamingStatusToolSections([
      activeCommandWithOutput,
    ])
    const detail = buildStreamingStatusDetail({
      lifecycleEvents: [],
      toolSections: statusSections,
      formatToolLabel: (toolSection) =>
        `${toolSection.type} ${(toolSection.input?.command as string) || ''}`.trim(),
    })

    expect(statusSections).toHaveLength(1)
    expect(detail).toContain('Inspect workspace files')
    expect(detail).not.toContain('git log --oneline -1')
    expect(detail).not.toContain('abc123 fix: collapse runtime telemetry')
  })

  test('repeated generic lifecycle statuses are collapsed out of the visible trace', () => {
    const detail = buildStreamingStatusDetail({
      thinking: 'Nyx is working...\nNyx is working...',
      lifecycleEvents: [
        {
          text: 'Nyx is working...',
          emoji: '',
          timestamp: 1,
          isError: false,
        },
        {
          text: 'Nyx is working...',
          emoji: '',
          timestamp: 2,
          isError: false,
        },
      ],
      toolSections: [],
    })

    expect(detail).toBe('Nyx is preparing the response.')
    expect(detail).not.toContain('Nyx is working')
  })

  test('workflow diary lifecycle text stays out of visible status detail', () => {
    const detail = buildStreamingStatusDetail({
      lifecycleEvents: [
        {
          text: 'Using superpowers:using-superpowers, test-driven-development, and verification-before-completion. I will inspect files.',
          emoji: '',
          timestamp: 1,
          isError: false,
        },
        {
          text: 'I am starting with the recent instability surface.',
          emoji: '',
          timestamp: 2,
          isError: false,
        },
      ],
      toolSections: [],
    })

    expect(detail).toBe('Nyx is preparing the response.')
    expect(detail).not.toContain('Using superpowers')
    expect(detail).not.toContain('recent instability')
  })

  test('trace detail reads as distinct timeline steps instead of status spam', () => {
    const readMemory = section({
      key: 'read-1',
      type: 'read',
      input: { path: '/home/user/dev/obsidian/ExampleVault/MEMORY.md' },
      state: 'output-available',
    })
    const duplicateReadMemory = section({
      key: 'read-2',
      type: 'read',
      input: { path: '/home/user/dev/obsidian/ExampleVault/MEMORY.md' },
      state: 'output-available',
    })
    const writeMemory = section({
      key: 'write-1',
      type: 'write',
      input: { path: '/home/user/dev/obsidian/ExampleVault/MEMORY.md' },
      state: 'input-available',
    })

    const timeline = buildStreamingActivityTimeline({
      thinking: 'Checking memory and recent context',
      lifecycleEvents: [
        {
          text: 'Run started',
          emoji: '',
          timestamp: 1,
          isError: false,
        },
        {
          text: 'Nyx is working...',
          emoji: '',
          timestamp: 2,
          isError: false,
        },
      ],
      toolSections: [readMemory, duplicateReadMemory, writeMemory],
    })

    expect(timeline.map((step) => step.label)).toEqual([
      'Checking memory and recent context',
      'Started the run',
      'Read MEMORY.md',
      'Update MEMORY.md',
    ])
  })

  test('runtime startup chatter is grouped into one human-readable step', () => {
    const timeline = buildStreamingActivityTimeline({
      thinking:
        'Starting full-capability runtime\nStarting Codex SDK runtime\nCodex SDK turn started',
      lifecycleEvents: [],
      toolSections: [
        section({
          key: 'runtime-1',
          type: 'Starting full-capability runtime',
          state: 'input-available',
        }),
        section({
          key: 'runtime-2',
          type: 'Codex SDK turn started',
          state: 'input-available',
        }),
        section({
          key: 'cmd-1',
          type: 'Running command',
          input: { command: "/bin/zsh -lc 'sleep 8 && git status --short'" },
          state: 'input-available',
        }),
      ],
    })

    expect(timeline.map((step) => step.label)).toEqual([
      'Starting workspace runtime',
      'Check git status',
    ])
  })

  test('delegation lifecycle text is translated into compact specialist status', () => {
    const timeline = buildStreamingActivityTimeline({
      thinking:
        'Delegating to @analyst\nWaiting for @analyst\nSynthesizing delegation results',
      lifecycleEvents: [],
      toolSections: [],
    })

    expect(timeline.map((step) => step.label)).toEqual([
      'Consulting Analyst',
      'Waiting on Analyst',
      'Reviewing specialist results',
    ])
  })

  test('final meaningful tool evidence still renders after completion', () => {
    const commandWithOutput = section({
      key: 'cmd-1',
      type: 'exec',
      input: { command: 'git status --short' },
      outputText:
        'M src/nyx-workspace/src/screens/chat/components/message-item.tsx',
      state: 'output-available',
    })
    const failedCommand = section({
      key: 'cmd-2',
      type: 'exec',
      errorText: 'exit 1',
      state: 'output-error',
    })

    expect(
      selectVisibleToolSections([commandWithOutput, failedCommand], false),
    ).toEqual([commandWithOutput, failedCommand])
  })

  test('normal chat warm-up without stream activity does not show lifecycle or tool UI', () => {
    expect(selectVisibleToolSections([], false)).toEqual([])
    expect(
      shouldShowStreamingStatusWindow({
        isUser: false,
        isStreaming: false,
        hasRevealedText: false,
        hasStatusActivity: false,
      }),
    ).toBe(false)
  })

  test('derived status promotes the active command over recent context', () => {
    const state = deriveStreamingActivityState({
      thinking: 'Checking context',
      lifecycleEvents: [
        {
          text: 'Run started',
          emoji: '',
          timestamp: 1,
          isError: false,
        },
      ],
      toolSections: [
        section({
          key: 'read-1',
          type: 'read',
          input: { path: '/home/user/dev/nyxhive/package.json' },
          state: 'output-available',
        }),
        section({
          key: 'cmd-1',
          type: 'exec',
          input: { command: 'bun test src/nyx-workspace/src/foo.test.ts' },
          state: 'input-available',
        }),
      ],
      elapsedSeconds: 42,
      isStreaming: true,
      hasRevealedText: false,
    })

    expect(state.header).toBe('Nyx is verifying the result...')
    expect(state.elapsedLabel).toBe('42s, verifying')
    expect(state.activeStep?.label).toBe('Verify the workspace')
    expect(state.activeStep?.state).toBe('active')
    expect(state.recentSteps.map((step) => step.label)).toEqual([
      'Checking context',
      'Started the run',
      'Read package.json',
    ])
  })

  test('derived status makes waiting explicit for queued lifecycle states', () => {
    const state = deriveStreamingActivityState({
      lifecycleEvents: [
        {
          text: 'Waiting for command output',
          emoji: '',
          timestamp: 1,
          isError: false,
        },
      ],
      toolSections: [],
      elapsedSeconds: 68,
      isStreaming: true,
      hasRevealedText: false,
    })

    expect(state.phase).toBe('waiting')
    expect(state.header).toBe('Nyx is waiting for output...')
    expect(state.elapsedLabel).toBe('1m 8s, waiting')
    expect(state.activeStep?.label).toBe('Waiting for command output')
  })

  test('state-aware elapsed labels stay compact before the work is noticeably long', () => {
    expect(formatStateAwareElapsedLabel(9, 'inspecting')).toBe('9s')
    expect(formatStateAwareElapsedLabel(31, 'running')).toBe('31s, running')
    expect(formatStateAwareElapsedLabel(72, 'synthesizing')).toBe(
      '1m 12s, synthesizing',
    )
  })
})

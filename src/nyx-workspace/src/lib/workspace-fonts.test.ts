import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  WORKSPACE_EDITOR_FONT_LIGATURES,
  WORKSPACE_FONT_FEATURE_SETTINGS,
  WORKSPACE_FONT_VARIANT_LIGATURES,
  WORKSPACE_MONO_FONT_FAMILY,
  findWorkspaceTerminalLigatureRanges,
} from './workspace-fonts'

const root = process.cwd()

function source(path: string): string {
  return readFileSync(join(root, path), 'utf8')
}

function expectTerminalJoinerRegisteredAfterOpen(path: string): void {
  const content = source(path)
  const openIndex = content.indexOf('terminal.open(container)')
  const joinerIndex = content.indexOf(
    'terminal.registerCharacterJoiner(findWorkspaceTerminalLigatureRanges)',
  )

  expect(openIndex).toBeGreaterThan(-1)
  expect(joinerIndex).toBeGreaterThan(openIndex)
}

describe('workspace fonts', () => {
  test('enables Maple Mono ligature features in global CSS', () => {
    const css = source('src/nyx-workspace/src/styles.css')

    expect(css).toContain(
      `--workspace-font-feature-settings: ${WORKSPACE_FONT_FEATURE_SETTINGS};`,
    )
    expect(css).toContain(
      `--workspace-font-variant-ligatures: ${WORKSPACE_FONT_VARIANT_LIGATURES};`,
    )
    expect(css).toContain('font-feature-settings: var(--workspace-font-feature-settings)')
    expect(css).toContain(
      'font-variant-ligatures: var(--workspace-font-variant-ligatures)',
    )
  })

  test('uses shared Maple Mono ligature settings in code surfaces', () => {
    expect(WORKSPACE_MONO_FONT_FAMILY).toContain('Maple Mono NF')
    expect(WORKSPACE_EDITOR_FONT_LIGATURES).toBe(true)

    expect(
      source('src/nyx-workspace/src/components/memory-viewer/MemoryEditor.tsx'),
    ).toContain('WORKSPACE_EDITOR_FONT_LIGATURES')
    expect(
      source('src/nyx-workspace/src/components/terminal/terminal-workspace.tsx'),
    ).toContain('findWorkspaceTerminalLigatureRanges')
    expect(
      source('src/nyx-workspace/src/components/terminal/terminal-workspace.tsx'),
    ).toContain('allowProposedApi: true')
    expect(
      source('src/nyx-workspace/src/components/terminal/terminal-panel.tsx'),
    ).toContain('findWorkspaceTerminalLigatureRanges')
    expect(
      source('src/nyx-workspace/src/components/terminal/terminal-panel.tsx'),
    ).toContain('allowProposedApi: true')
  })

  test('registers terminal ligature joiners after xterm is opened', () => {
    expectTerminalJoinerRegisteredAfterOpen(
      'src/nyx-workspace/src/components/terminal/terminal-workspace.tsx',
    )
    expectTerminalJoinerRegisteredAfterOpen(
      'src/nyx-workspace/src/components/terminal/terminal-panel.tsx',
    )
  })

  test('joins common coding operators for terminal ligature rendering', () => {
    expect(findWorkspaceTerminalLigatureRanges('a === b && c => d')).toEqual([
      [2, 5],
      [8, 10],
      [13, 15],
    ])
    expect(findWorkspaceTerminalLigatureRanges('x != y || y <= z')).toEqual([
      [2, 4],
      [7, 9],
      [12, 14],
    ])
  })
})

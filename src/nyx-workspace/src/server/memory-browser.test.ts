import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import {
  getMemoryWorkspaceRoot,
  listMemoryFiles,
  readMemoryFile,
} from './memory-browser'

const originalMemoryRoot = process.env.NYX_WORKSPACE_MEMORY_ROOT
const originalVaultRoot = process.env.NYX_WORKSPACE_VAULT_ROOT
const originalApiUrl = process.env.NYX_WORKSPACE_API_URL
const originalMemoryNamespace = process.env.NYX_WORKSPACE_MEMORY_NAMESPACE
const originalMemoryExcludePrefixes =
  process.env.NYX_WORKSPACE_MEMORY_EXCLUDE_PREFIXES
const tempDirs: Array<string> = []

afterEach(() => {
  if (originalMemoryRoot === undefined) {
    delete process.env.NYX_WORKSPACE_MEMORY_ROOT
  } else {
    process.env.NYX_WORKSPACE_MEMORY_ROOT = originalMemoryRoot
  }
  if (originalVaultRoot === undefined) {
    delete process.env.NYX_WORKSPACE_VAULT_ROOT
  } else {
    process.env.NYX_WORKSPACE_VAULT_ROOT = originalVaultRoot
  }
  if (originalApiUrl === undefined) {
    delete process.env.NYX_WORKSPACE_API_URL
  } else {
    process.env.NYX_WORKSPACE_API_URL = originalApiUrl
  }
  if (originalMemoryNamespace === undefined) {
    delete process.env.NYX_WORKSPACE_MEMORY_NAMESPACE
  } else {
    process.env.NYX_WORKSPACE_MEMORY_NAMESPACE = originalMemoryNamespace
  }
  if (originalMemoryExcludePrefixes === undefined) {
    delete process.env.NYX_WORKSPACE_MEMORY_EXCLUDE_PREFIXES
  } else {
    process.env.NYX_WORKSPACE_MEMORY_EXCLUDE_PREFIXES =
      originalMemoryExcludePrefixes
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function createWorkspaceRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'nyx-memory-browser-'))
  tempDirs.push(root)
  process.env.NYX_WORKSPACE_MEMORY_ROOT = root
  return root
}

describe('memory browser root', () => {
  test('uses the configured Nyx memory workspace root', () => {
    const root = createWorkspaceRoot()

    expect(getMemoryWorkspaceRoot()).toBe(root)
  })

  test('lists root memory and vault notes under memory/', () => {
    const root = createWorkspaceRoot()
    mkdirSync(join(root, 'memory', 'NyxAI', 'System'), { recursive: true })
    mkdirSync(join(root, 'memory', 'NyxAI', '.obsidian'), { recursive: true })
    writeFileSync(join(root, 'MEMORY.md'), '# Memory\n')
    writeFileSync(join(root, 'memory', 'NyxAI', 'System', 'Soul.md'), '# Soul\n')
    writeFileSync(
      join(root, 'memory', 'NyxAI', '.obsidian', 'Ignored.md'),
      '# Ignored\n',
    )
    writeFileSync(join(root, 'outside.md'), '# Outside\n')

    expect(listMemoryFiles().map((file) => file.path)).toEqual([
      'MEMORY.md',
      'memory/NyxAI/System/Soul.md',
    ])
  })

  test('uses explicit vault roots without mixing sibling vaults', () => {
    const parent = mkdtempSync(join(tmpdir(), 'nyx-vault-browser-'))
    tempDirs.push(parent)
    const nyxVault = join(parent, 'NyxAI')
    const labsVault = join(parent, 'NyxLabs')
    mkdirSync(join(nyxVault, 'Areas'), { recursive: true })
    mkdirSync(join(labsVault, 'Projects'), { recursive: true })
    writeFileSync(join(nyxVault, 'Areas', 'Memory System.md'), '# NyxAI\n')
    writeFileSync(join(labsVault, 'Projects', 'Trading.md'), '# NyxLabs\n')

    delete process.env.NYX_WORKSPACE_MEMORY_ROOT
    process.env.NYX_WORKSPACE_VAULT_ROOT = nyxVault

    expect(getMemoryWorkspaceRoot()).toBe(nyxVault)
    expect(listMemoryFiles().map((file) => file.path)).toEqual([
      'Areas/Memory System.md',
    ])
  })

  test('excludes configured non-owned memory prefixes from an explicit vault root', () => {
    const parent = mkdtempSync(join(tmpdir(), 'nyx-vault-exclude-browser-'))
    tempDirs.push(parent)
    const root = join(parent, 'NyxAI')
    mkdirSync(join(root, 'System'), { recursive: true })
    mkdirSync(join(root, 'Projects', 'Trading-Journal'), { recursive: true })
    writeFileSync(join(root, 'System', 'Soul.md'), '# Nyx\n')
    writeFileSync(
      join(root, 'Projects', 'Trading-Journal', 'Roadmap.md'),
      '# Labs\n',
    )

    delete process.env.NYX_WORKSPACE_MEMORY_ROOT
    process.env.NYX_WORKSPACE_VAULT_ROOT = root
    process.env.NYX_WORKSPACE_MEMORY_NAMESPACE = 'NyxAI'
    process.env.NYX_WORKSPACE_MEMORY_EXCLUDE_PREFIXES =
      'Projects/Trading-Journal/'

    expect(listMemoryFiles().map((file) => file.path)).toEqual([
      'System/Soul.md',
    ])
    expect(() =>
      readMemoryFile('Projects/Trading-Journal/Roadmap.md'),
    ).toThrow(/not allowed/i)
  })

  test('scopes explicit parent vault roots to the active namespace', () => {
    const parent = mkdtempSync(join(tmpdir(), 'nyx-vault-parent-browser-'))
    tempDirs.push(parent)
    mkdirSync(join(parent, 'NyxAI', 'System'), { recursive: true })
    mkdirSync(join(parent, 'NyxLabs', 'Projects'), { recursive: true })
    writeFileSync(join(parent, 'NyxAI', 'System', 'Soul.md'), '# Nyx\n')
    writeFileSync(join(parent, 'NyxLabs', 'Projects', 'Trading.md'), '# Labs\n')

    delete process.env.NYX_WORKSPACE_MEMORY_ROOT
    process.env.NYX_WORKSPACE_VAULT_ROOT = parent
    process.env.NYX_WORKSPACE_MEMORY_NAMESPACE = 'NyxAI'

    expect(listMemoryFiles().map((file) => file.path)).toEqual([
      'NyxAI/System/Soul.md',
    ])
    expect(readMemoryFile('NyxAI/System/Soul.md')).toBe('# Nyx\n')
    expect(() => readMemoryFile('NyxLabs/Projects/Trading.md')).toThrow(
      /not allowed/i,
    )
  })

  test('scopes shared instance memory to the active NyxAI namespace', () => {
    const root = createWorkspaceRoot()
    mkdirSync(join(root, 'memory', 'NyxAI', 'System'), { recursive: true })
    mkdirSync(join(root, 'memory', 'NyxLabs', 'Projects'), { recursive: true })
    writeFileSync(join(root, 'memory', 'NyxAI', 'System', 'Soul.md'), '# Nyx\n')
    writeFileSync(
      join(root, 'memory', 'NyxLabs', 'Projects', 'Trading.md'),
      '# Labs\n',
    )

    process.env.NYX_WORKSPACE_API_URL = 'http://127.0.0.1:3779'

    expect(listMemoryFiles().map((file) => file.path)).toEqual([
      'memory/NyxAI/System/Soul.md',
    ])
    expect(readMemoryFile('memory/NyxAI/System/Soul.md')).toBe('# Nyx\n')
    expect(() => readMemoryFile('memory/NyxLabs/Projects/Trading.md')).toThrow(
      /not allowed/i,
    )
  })
})

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { findNyxRepoRoot, resolveNyxFilesystemRoot } from './workspace-root'

const originalNyxWorkspaceDir = process.env.NYX_WORKSPACE_DIR
const originalNyxhiveWorkspaceDir = process.env.NYXHIVE_WORKSPACE_DIR
const originalHermesWorkspaceDir = process.env.HERMES_WORKSPACE_DIR
const originalNyxWorkspaceHome = process.env.NYX_WORKSPACE_HOME

afterEach(() => {
  restoreEnv('NYX_WORKSPACE_DIR', originalNyxWorkspaceDir)
  restoreEnv('NYXHIVE_WORKSPACE_DIR', originalNyxhiveWorkspaceDir)
  restoreEnv('HERMES_WORKSPACE_DIR', originalHermesWorkspaceDir)
  restoreEnv('NYX_WORKSPACE_HOME', originalNyxWorkspaceHome)
})

function restoreEnv(key: string, value: string | undefined) {
  if (value === undefined) {
    delete process.env[key]
  } else {
    process.env[key] = value
  }
}

function withTempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'nyx-workspace-root-'))
}

function createRepo(root: string) {
  mkdirSync(join(root, '.nyxhive'))
  writeFileSync(join(root, 'bun.lock'), '')
  writeFileSync(join(root, 'package.json'), '{"name":"fixture"}')
}

describe('workspace root resolution', () => {
  test('finds the Nyx repo root from a nested workspace cwd', () => {
    const root = withTempRoot()

    try {
      createRepo(root)
      const nested = join(root, 'src', 'nyx-workspace')
      mkdirSync(nested, { recursive: true })

      expect(findNyxRepoRoot(nested)).toBe(root)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('defaults filesystem browsing to the Nyx repo instead of Hermes home', () => {
    const root = withTempRoot()

    try {
      createRepo(root)
      const nested = join(root, 'src', 'nyx-workspace')
      mkdirSync(nested, { recursive: true })
      delete process.env.NYX_WORKSPACE_DIR
      delete process.env.NYXHIVE_WORKSPACE_DIR
      delete process.env.HERMES_WORKSPACE_DIR

      expect(resolveNyxFilesystemRoot(nested)).toEqual({
        path: root,
        source: 'repo',
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test('honors explicit Nyx workspace env before legacy Hermes env', () => {
    process.env.NYX_WORKSPACE_DIR = '~/nyx-workspace'
    process.env.HERMES_WORKSPACE_DIR = '~/hermes-workspace'

    const root = resolveNyxFilesystemRoot('/tmp')

    expect(root.path).toContain('/nyx-workspace')
    expect(root.source).toBe('env')
  })
})


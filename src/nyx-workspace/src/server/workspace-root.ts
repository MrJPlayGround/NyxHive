import fs from 'node:fs'
import path from 'node:path'
import { getNyxWorkspaceHome, resolveHomePath } from './workspace-home'

export type WorkspaceRootSource =
  | 'env'
  | 'legacy-env'
  | 'repo'
  | 'cwd'
  | 'nyx-home'

export type WorkspaceRoot = {
  path: string
  source: WorkspaceRootSource
}

const REPO_MARKERS = ['.nyxhive', 'bun.lock', 'package.json'] as const

function isDirectory(input: string): boolean {
  try {
    return fs.statSync(input).isDirectory()
  } catch {
    return false
  }
}

function hasRepoMarkers(dir: string): boolean {
  return REPO_MARKERS.every((marker) => fs.existsSync(path.join(dir, marker)))
}

export function findNyxRepoRoot(startDir: string): string | null {
  let current = path.resolve(startDir)

  while (true) {
    if (hasRepoMarkers(current)) return current
    const parent = path.dirname(current)
    if (parent === current) return null
    current = parent
  }
}

export function resolveNyxFilesystemRoot(cwd = process.cwd()): WorkspaceRoot {
  const explicitNyxRoot =
    process.env.NYX_WORKSPACE_DIR || process.env.NYXHIVE_WORKSPACE_DIR || ''
  if (explicitNyxRoot.trim()) {
    return { path: resolveHomePath(explicitNyxRoot), source: 'env' }
  }

  const legacyHermesRoot = process.env.HERMES_WORKSPACE_DIR || ''
  if (legacyHermesRoot.trim()) {
    return { path: resolveHomePath(legacyHermesRoot), source: 'legacy-env' }
  }

  const repoRoot = findNyxRepoRoot(cwd)
  if (repoRoot) return { path: repoRoot, source: 'repo' }

  const resolvedCwd = path.resolve(cwd)
  if (isDirectory(resolvedCwd)) return { path: resolvedCwd, source: 'cwd' }

  return { path: getNyxWorkspaceHome(), source: 'nyx-home' }
}


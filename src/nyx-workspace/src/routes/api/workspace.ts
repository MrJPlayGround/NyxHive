/**
 * Phase 2.6: Workspace detection API
 * Auto-detects workspace from Nyx config, env, or repo root
 */
import path from 'node:path'
import fs from 'node:fs/promises'
import { createFileRoute } from '@tanstack/react-router'
import { json } from '@tanstack/react-start'
import { isAuthenticated } from '../../server/auth-middleware'
import { resolveNyxFilesystemRoot } from '../../server/workspace-root'

function extractFolderName(fullPath: string): string {
  const parts = fullPath.replace(/\\/g, '/').split('/')
  return parts[parts.length - 1] || 'workspace'
}

async function isValidDirectory(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dirPath)
    return stat.isDirectory()
  } catch {
    return false
  }
}

async function detectWorkspace(savedPath?: string): Promise<{
  path: string
  folderName: string
  source: string
  isValid: boolean
}> {
  // Priority 1: Saved path from localStorage (passed via query param)
  if (savedPath) {
    const isValid = await isValidDirectory(savedPath)
    if (isValid) {
      return {
        path: savedPath,
        folderName: extractFolderName(savedPath),
        source: 'localStorage',
        isValid: true,
      }
    }
    // Saved path is stale, fall through to auto-detect
  }

  const workspaceRoot = resolveNyxFilesystemRoot()
  const isValid = await isValidDirectory(workspaceRoot.path)
  if (isValid) {
    return {
      path: workspaceRoot.path,
      folderName: extractFolderName(workspaceRoot.path),
      source: workspaceRoot.source,
      isValid: true,
    }
  }

  // Nothing found
  return {
    path: '',
    folderName: '',
    source: 'none',
    isValid: false,
  }
}

export const Route = createFileRoute('/api/workspace')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        if (!isAuthenticated(request)) {
          return json({ ok: false, error: 'Unauthorized' }, { status: 401 })
        }
        try {
          const url = new URL(request.url)
          const savedPath = url.searchParams.get('saved') || undefined

          const result = await detectWorkspace(savedPath)

          return json(result)
        } catch (err) {
          return json(
            {
              path: '',
              folderName: '',
              source: 'error',
              isValid: false,
              error: err instanceof Error ? err.message : String(err),
            },
            { status: 500 },
          )
        }
      },
    },
  },
})

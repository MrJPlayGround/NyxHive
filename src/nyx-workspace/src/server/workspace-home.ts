import os from 'node:os'
import path from 'node:path'

export function resolveHomePath(input: string): string {
  return path.resolve(input.replace(/^~\//, `${os.homedir()}/`))
}

export function getNyxWorkspaceHome(): string {
  const configured =
    process.env.NYX_WORKSPACE_HOME || process.env.NYXHIVE_HOME || ''
  if (configured.trim()) {
    return resolveHomePath(configured)
  }
  return path.join(os.homedir(), '.nyxhive')
}

export function getLegacyHermesHome(): string {
  return process.env.HERMES_HOME || path.join(os.homedir(), '.hermes')
}

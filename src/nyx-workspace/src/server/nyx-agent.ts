import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { getLegacyHermesHome, getNyxWorkspaceHome } from './workspace-home'

const NYX_AGENT_HEALTH_TIMEOUT_MS = 2_000
const NYX_AGENT_START_PORT = 8642

let startPromise: Promise<StartNyxAgentResult> | null = null

export type StartNyxAgentResult =
  | {
      ok: true
      message: string
      pid?: number
    }
  | {
      ok: false
      error: string
    }

/**
 * Read the Nyx workspace env and return key=value pairs as an object.
 * Silently returns {} if the file doesn't exist or can't be parsed.
 */
function readNyxEnv(): Record<string, string> {
  const envPath = existsSync(join(getNyxWorkspaceHome(), '.env'))
    ? join(getNyxWorkspaceHome(), '.env')
    : join(getLegacyHermesHome(), '.env')
  try {
    const raw = readFileSync(envPath, 'utf-8')
    const result: Record<string, string> = {}
    for (const line of raw.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eqIdx = trimmed.indexOf('=')
      if (eqIdx <= 0) continue
      const key = trimmed.slice(0, eqIdx).trim()
      let value = trimmed.slice(eqIdx + 1).trim()
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1)
      }
      if (key) result[key] = value
    }
    return result
  } catch {
    return {}
  }
}

/** Same directory resolution logic as vite.config.ts. */
export function resolveNyxAgentDir(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const candidates: Array<string> = []

  if (env.NYX_AGENT_PATH?.trim()) {
    candidates.push(env.NYX_AGENT_PATH.trim())
  }

  if (env.HERMES_AGENT_PATH?.trim()) {
    candidates.push(env.HERMES_AGENT_PATH.trim())
  }

  const workspaceRoot = dirname(resolve('.'))
  candidates.push(
    resolve(workspaceRoot, 'nyx-agent'),
    resolve(workspaceRoot, '..', 'nyx-agent'),
  )

  for (const candidate of candidates) {
    if (existsSync(resolve(candidate, 'webapi'))) return candidate
  }

  return null
}

export function resolveNyxPython(agentDir: string): string {
  const venvPython = resolve(agentDir, '.venv', 'bin', 'python')
  if (existsSync(venvPython)) return venvPython
  const uvVenv = resolve(agentDir, 'venv', 'bin', 'python')
  if (existsSync(uvVenv)) return uvVenv
  return 'python3'
}

export async function isNyxAgentHealthy(
  port = NYX_AGENT_START_PORT,
): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(NYX_AGENT_HEALTH_TIMEOUT_MS),
    })
    return response.ok
  } catch {
    return false
  }
}

export async function startNyxAgent(): Promise<StartNyxAgentResult> {
  if (await isNyxAgentHealthy()) {
    return { ok: true, message: 'already running' }
  }

  if (startPromise) {
    return startPromise
  }

  startPromise = (async () => {
    try {
      const agentDir = resolveNyxAgentDir()
      if (!agentDir) {
        return {
          ok: false,
          error:
            'Nyx gateway starter is not configured. Set NYX_AGENT_PATH for a local starter or run the NyxHive daemon directly.',
        }
      }

      const python = resolveNyxPython(agentDir)
      const nyxEnv = readNyxEnv()

      const child = spawn(
        python,
        [
          '-m',
          'uvicorn',
          'webapi.app:app',
          '--host',
          '0.0.0.0',
          '--port',
          String(NYX_AGENT_START_PORT),
        ],
        {
          cwd: agentDir,
          detached: true,
          stdio: 'ignore',
          env: {
            ...process.env,
            ...nyxEnv,
            PATH: `${resolve(agentDir, '.venv', 'bin')}:${resolve(agentDir, 'venv', 'bin')}:${process.env.PATH || ''}`,
          },
        },
      )

      child.unref()

      for (let attempt = 0; attempt < 10; attempt += 1) {
        await new Promise((resolveAttempt) => setTimeout(resolveAttempt, 1_000))
        if (await isNyxAgentHealthy()) {
          return {
            ok: true,
            pid: child.pid,
            message: 'started',
          }
        }
      }

      return {
        ok: true,
        pid: child.pid,
        message: 'starting',
      }
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }
    }
  })()

  try {
    return await startPromise
  } finally {
    startPromise = null
  }
}

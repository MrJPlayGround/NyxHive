import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { createGatewayAuthHeaders } from './gateway-auth-headers'

const DEFAULT_BACKEND_URL = 'http://127.0.0.1:3779'
const DEFAULT_REPO_DIR = process.env.NYXHIVE_REPO_DIR || process.cwd()
const PROBE_TIMEOUT_MS = 2_500
const START_POLL_ATTEMPTS = 30
const START_POLL_INTERVAL_MS = 1_000

type Env = Record<string, string | undefined>

type SpawnCommand = (
  command: string,
  args: Array<string>,
  options: { cwd: string; env: NodeJS.ProcessEnv },
) => Promise<{ code: number | null; output: string }>

export type StartNyxHiveResult =
  | {
      ok: true
      message: string
      backend: string
      instance: string
    }
  | {
      ok: false
      error: string
      hint?: string
      backend?: string
      instance?: string
    }

export type StartNyxHiveOptions = {
  env?: Env
  fetchImpl?: typeof fetch
  sleep?: (ms: number) => Promise<void>
  spawnCommand?: SpawnCommand
}

let startPromise: Promise<StartNyxHiveResult> | null = null

function normalizeBackendUrl(env: Env): string {
  const raw =
    env.NYX_WORKSPACE_API_URL?.trim() ||
    env.NYX_API_URL?.trim() ||
    env.HERMES_API_URL?.trim() ||
    DEFAULT_BACKEND_URL

  return raw.replace(/\/+$/, '')
}

function resolveRepoDir(env: Env): string {
  return env.NYXHIVE_REPO_DIR?.trim() || DEFAULT_REPO_DIR
}

function resolveInstance(backend: string, env: Env): string {
  const explicit =
    env.NYX_WORKSPACE_INSTANCE?.trim() || env.NYXHIVE_INSTANCE?.trim()
  if (explicit) return explicit.toLowerCase()

  try {
    const port = new URL(backend).port
    if (port === '3778') return 'nyxlabs'
  } catch {
    // Invalid URLs are handled by local backend validation.
  }

  return 'nyxai'
}

function displayInstanceName(instance: string): string {
  switch (instance) {
    case 'nyxlabs':
      return 'NyxLabs'
    case 'astra-trading':
      return 'Astra Trading'
    case 'nyxai':
      return 'NyxAI'
    default:
      return instance
  }
}

function isLocalBackend(backend: string): boolean {
  try {
    const host = new URL(backend).hostname.toLowerCase()
    return host === '127.0.0.1' || host === 'localhost' || host === '::1'
  } catch {
    return false
  }
}

async function isBackendRunning(
  backend: string,
  env: Env,
  fetchImpl: typeof fetch,
): Promise<boolean> {
  const headers = createGatewayAuthHeaders(
    env.NYX_WORKSPACE_API_KEY?.trim() ||
      env.NYX_API_TOKEN?.trim() ||
      env.NYXHIVE_API_KEY?.trim() ||
      env.HERMES_API_TOKEN?.trim() ||
      '',
  )

  for (const path of ['/api/info', '/health']) {
    try {
      const response = await fetchImpl(`${backend}${path}`, {
        headers,
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      })
      const contentType = response.headers.get('content-type')?.toLowerCase()
      if (contentType?.includes('text/html')) continue
      if (response.ok || [401, 403, 503].includes(response.status)) return true
    } catch {
      // Try the next probe path.
    }
  }

  return false
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolveSleep) => setTimeout(resolveSleep, ms))

const defaultSpawnCommand: SpawnCommand = (command, args, options) =>
  new Promise((resolveSpawn) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let output = ''
    const append = (chunk: Buffer) => {
      output += chunk.toString()
      if (output.length > 8_000) output = output.slice(-8_000)
    }

    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
    child.on('error', (error) => {
      resolveSpawn({ code: 1, output: error.message })
    })
    child.on('close', (code) => {
      resolveSpawn({ code, output })
    })
  })

export async function startNyxHive(
  options: StartNyxHiveOptions = {},
): Promise<StartNyxHiveResult> {
  if (startPromise) return startPromise

  startPromise = (async () => {
    const env = options.env ?? process.env
    const backend = normalizeBackendUrl(env)
    const instance = resolveInstance(backend, env)
    const fetchImpl = options.fetchImpl ?? fetch
    const sleep = options.sleep ?? defaultSleep
    const spawnCommand = options.spawnCommand ?? defaultSpawnCommand

    if (await isBackendRunning(backend, env, fetchImpl)) {
      return {
        ok: true,
        message: 'already running',
        backend,
        instance,
      }
    }

    if (!isLocalBackend(backend)) {
      return {
        ok: false,
        error: 'NyxHive auto-start only supports local backends.',
        hint: 'Start the remote backend directly, then reload the workspace.',
        backend,
        instance,
      }
    }

    const repoDir = resolveRepoDir(env)
    const script = resolve(repoDir, 'scripts', 'restart-instance.sh')
    if (!existsSync(script)) {
      return {
        ok: false,
        error: `NyxHive restart script not found: ${script}`,
        hint: 'Set NYXHIVE_REPO_DIR to your NyxHive checkout.',
        backend,
        instance,
      }
    }

    const started = await spawnCommand(script, [instance], {
      cwd: repoDir,
      env: {
        ...process.env,
        ...env,
        NYXHIVE_RESTART_SOURCE: env.NYXHIVE_RESTART_SOURCE ?? 'workspace-autostart',
        NYXHIVE_RESTART_REASON:
          env.NYXHIVE_RESTART_REASON ?? `backend probe failed for ${backend}`,
      },
    })

    if (started.code !== 0) {
      return {
        ok: false,
        error: `NyxHive restart failed${started.output ? `: ${started.output.trim()}` : ''}`,
        backend,
        instance,
      }
    }

    for (let attempt = 0; attempt < START_POLL_ATTEMPTS; attempt += 1) {
      if (await isBackendRunning(backend, env, fetchImpl)) {
        return {
          ok: true,
          message: `started ${displayInstanceName(instance)}`,
          backend,
          instance,
        }
      }
      await sleep(START_POLL_INTERVAL_MS)
    }

    return {
      ok: false,
      error: 'NyxHive restart command completed, but the backend did not respond.',
      hint: `Check tmux attach -t ${instance}`,
      backend,
      instance,
    }
  })()

  try {
    return await startPromise
  } finally {
    startPromise = null
  }
}

import { URL, fileURLToPath } from 'node:url'
import { execSync, spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import net from 'node:net'
import { dirname, extname, resolve, sep } from 'node:path'
import os from 'node:os'

// devtools removed
import { tanstackStart } from '@tanstack/react-start/plugin/vite'
import viteReact from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
// nitro plugin removed (tanstackStart handles server runtime)
import { defineConfig, loadEnv } from 'vite'
import viteTsConfigPaths from 'vite-tsconfig-paths'
import { createGatewayAuthHeaders } from './src/server/gateway-auth-headers'
import { isGatewayApiProbeResponse } from './src/server/gateway-probe-response'

// ---------------------------------------------------------------------------
// Nyx Agent auto-start helpers
// ---------------------------------------------------------------------------

/** Resolve the nyx-agent directory using a priority-ordered fallback chain:
 *  1. NYX_AGENT_PATH env var (explicit override)
 *  2. ../nyx-agent  — sibling clone (standard README setup)
 *  3. ../../nyx-agent — one level up (monorepo / nested workspace)
 *  Returns null if none found.
 */
function resolveNyxAgentDir(env: Record<string, string>): string | null {
  const candidates: string[] = []

  if (env.NYX_AGENT_PATH?.trim()) {
    candidates.push(env.NYX_AGENT_PATH.trim())
  }

  if (env.HERMES_AGENT_PATH?.trim()) {
    candidates.push(env.HERMES_AGENT_PATH.trim())
  }

  // Resolve relative to the workspace root.
  const workspaceRoot = dirname(resolve('.'))
  candidates.push(
    resolve(workspaceRoot, 'nyx-agent'), // sibling nyx-agent directory
    resolve(workspaceRoot, '..', 'nyx-agent'), // one level up
  )

  for (const candidate of candidates) {
    if (existsSync(resolve(candidate, 'webapi'))) return candidate
  }
  return null
}

function getContentType(filePath: string): string {
  switch (extname(filePath)) {
    case '.css':
      return 'text/css; charset=utf-8'
    case '.js':
      return 'application/javascript; charset=utf-8'
    case '.json':
      return 'application/json; charset=utf-8'
    case '.ttf':
      return 'font/ttf'
    case '.wasm':
      return 'application/wasm'
    default:
      return 'application/octet-stream'
  }
}

function createMonacoMiddleware() {
  const monacoRoot = resolve('node_modules/monaco-editor/min/vs')
  return (req: any, res: any, next: () => void) => {
    const requestPath = decodeURIComponent((req.url ?? '').split('?')[0] ?? '')
    if (!requestPath.startsWith('/monaco/vs/')) {
      next()
      return
    }

    const requestedFile = requestPath.slice('/monaco/vs/'.length)
    const filePath = resolve(monacoRoot, requestedFile)
    if (filePath !== monacoRoot && !filePath.startsWith(`${monacoRoot}${sep}`)) {
      res.statusCode = 403
      res.end('Forbidden')
      return
    }

    try {
      let body: Buffer | string = readFileSync(filePath)
      if (requestedFile === 'loader.js') {
        body = body
          .toString('utf-8')
          .replace(/\n\/\/# sourceMappingURL=.*\s*$/, '')
      }
      res.statusCode = 200
      res.setHeader('content-type', getContentType(filePath))
      res.end(body)
    } catch {
      next()
    }
  }
}

/** Resolve the Python executable to use for Nyx backend startup.
 *  Prefers .venv/bin/python inside agentDir, falls back to system python3.
 */
function resolveNyxPython(agentDir: string): string {
  const venvPython = resolve(agentDir, '.venv', 'bin', 'python')
  if (existsSync(venvPython)) return venvPython
  // uv creates 'venv' not '.venv' sometimes
  const uvVenv = resolve(agentDir, 'venv', 'bin', 'python')
  if (existsSync(uvVenv)) return uvVenv
  return 'python3'
}

/** Check if nyx-agent health endpoint is responding */
async function isNyxAgentHealthy(port = 8642): Promise<boolean> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(2000),
    })
    return r.ok
  } catch {
    return false
  }
}

const config = defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const nyxApiUrl =
    env.NYX_WORKSPACE_API_URL?.trim() ||
    env.NYX_API_URL?.trim() ||
    env.HERMES_API_URL?.trim() ||
    'http://127.0.0.1:3777'
  const workspacePort = Number(env.NYX_WORKSPACE_PORT || 3780)
  const apiToken =
    env.NYX_WORKSPACE_API_KEY?.trim() ||
    env.NYX_API_TOKEN?.trim() ||
    env.HERMES_API_TOKEN?.trim() ||
    process.env.NYX_WORKSPACE_API_KEY?.trim() ||
    process.env.NYX_API_TOKEN?.trim() ||
    process.env.HERMES_API_TOKEN?.trim() ||
    ''
  const apiHeaders = createGatewayAuthHeaders(apiToken)

  // Nyx Agent auto-start state
  let nyxAgentChild: ChildProcess | null = null
  let nyxAgentStarted = false

  const startNyxAgent = async () => {
    if (nyxAgentStarted) return
    if (env.NYX_WORKSPACE === '1') {
      console.log(`[nyx-workspace] Using NyxHive API at ${nyxApiUrl}`)
      nyxAgentStarted = true
      return
    }
    // Skip auto-start when NYX_API_URL is explicitly set to a non-local endpoint
    const explicitUrl =
      env.NYX_API_URL ||
      env.HERMES_API_URL ||
      process.env.NYX_API_URL ||
      process.env.HERMES_API_URL ||
      nyxApiUrl ||
      ''
    if (
      explicitUrl &&
      explicitUrl !== 'http://127.0.0.1:8642' &&
      explicitUrl !== 'http://localhost:8642'
    ) {
      console.log(
        `[nyx-agent] Skipping auto-start — using external API: ${explicitUrl}`,
      )
      nyxAgentStarted = true
      return
    }
    if (await isNyxAgentHealthy()) {
      console.log('[nyx-agent] Already running — reusing existing process')
      nyxAgentStarted = true
      return
    }

    const agentDir = resolveNyxAgentDir(env)
    if (!agentDir) {
      console.warn(
        '[nyx-agent] Could not find nyx-agent directory.\n' +
          '  Set NYX_AGENT_PATH in .env if you want the workspace to start a local gateway.',
      )
      return
    }

    const python = resolveNyxPython(agentDir)
    const useGatewayRun = existsSync(resolve(agentDir, 'gateway', 'run.py'))
    const commandArgs = useGatewayRun
      ? ['-m', 'gateway.run']
      : ['-m', 'uvicorn', 'webapi.app:app', '--host', '0.0.0.0', '--port', '8642']

    console.log(
      `[nyx-agent] Starting from ${agentDir} using ${python} (${useGatewayRun ? 'gateway.run' : 'uvicorn'})`,
    )

    const child = spawn(
      python,
      commandArgs,
      {
        cwd: agentDir,
        detached: false, // keep tied to vite process — stops when dev server stops
        stdio: 'pipe',
        env: {
          ...process.env,
          PATH: `${resolve(agentDir, '.venv', 'bin')}:${resolve(agentDir, 'venv', 'bin')}:${process.env.PATH || ''}`,
        },
      },
    )

    nyxAgentChild = child
    nyxAgentStarted = true

    child.stdout?.on('data', (d: Buffer) => {
      const line = d.toString().trim()
      if (line) console.log(`[nyx-agent] ${line}`)
    })
    child.stderr?.on('data', (d: Buffer) => {
      const line = d.toString().trim()
      if (line) console.log(`[nyx-agent] ${line}`)
    })

    child.on('exit', (code) => {
      nyxAgentChild = null
      nyxAgentStarted = false
      if (code !== 0 && code !== null) {
        console.warn(`[nyx-agent] Exited with code ${code}`)
      }
    })

    // Wait for healthy
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 1000))
      if (await isNyxAgentHealthy()) {
        console.log('[nyx-agent] ✓ Ready on http://127.0.0.1:8642')
        return
      }
    }
    console.warn(
      '[nyx-agent] Started but health check timed out — may still be loading',
    )
  }

  let workspaceDaemonStarted = false
  let workspaceDaemonStarting = false
  let workspaceDaemonShuttingDown = false
  let workspaceDaemonRestarting = false
  let workspaceDaemonChild: ChildProcess | null = null
  let workspaceDaemonRetryCount = 0
  const workspaceDaemonPort = '3099'
  const daemonCwd = resolve('workspace-daemon')
  const daemonSrcEntry = resolve('workspace-daemon/src/server.ts')
  const daemonDistEntry = resolve('workspace-daemon/dist/server.js')
  const workspaceDaemonDbPath = resolve(
    'workspace-daemon/.workspaces/workspace.db',
  )

  const getWorkspaceDaemonDelayMs = (attempt: number) =>
    Math.min(1000 * 2 ** Math.max(attempt - 1, 0), 30000)

  const startWorkspaceDaemon = () => {
    if (workspaceDaemonShuttingDown) return
    if (workspaceDaemonStarted || workspaceDaemonStarting) return

    const spawnCommand = existsSync(daemonSrcEntry)
      ? {
          commandName: 'npx',
          args: ['tsx', 'watch', 'src/server.ts'],
          options: {
            cwd: daemonCwd,
            env: {
              ...process.env,
              PORT: workspaceDaemonPort,
              DB_PATH: workspaceDaemonDbPath,
              ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? '',
            },
            stdio: 'inherit' as const,
          },
        }
      : existsSync(daemonDistEntry)
        ? {
            commandName: 'node',
            args: ['dist/server.js'],
            options: {
              cwd: daemonCwd,
              env: {
                ...process.env,
                PORT: workspaceDaemonPort,
                DB_PATH: workspaceDaemonDbPath,
                ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY ?? '',
              },
              stdio: 'inherit' as const,
            },
          }
        : null

    if (!spawnCommand) {
      workspaceDaemonStarting = false
      console.error('[workspace-daemon] no server entry found to spawn.')
      return
    }

    workspaceDaemonStarted = true
    workspaceDaemonStarting = false
    const child = spawn(
      spawnCommand.commandName,
      spawnCommand.args,
      spawnCommand.options,
    )
    workspaceDaemonChild = child

    child.on('exit', (code) => {
      if (workspaceDaemonChild === child) {
        workspaceDaemonChild = null
      }

      if (workspaceDaemonShuttingDown || workspaceDaemonRestarting) {
        workspaceDaemonStarted = false
        workspaceDaemonStarting = false
        return
      }

      if (code === 0) {
        workspaceDaemonStarted = false
        workspaceDaemonStarting = false
        return
      }

      if (workspaceDaemonRetryCount >= 20) {
        workspaceDaemonStarted = false
        workspaceDaemonStarting = false
        console.error(
          `[workspace-daemon] crashed with code ${code ?? 'unknown'}; max restart attempts reached.`,
        )
        return
      }

      workspaceDaemonRetryCount += 1
      const delayMs = getWorkspaceDaemonDelayMs(workspaceDaemonRetryCount)
      console.error(
        `[workspace-daemon] crashed with code ${code ?? 'unknown'}; restarting in ${Math.round(
          delayMs / 1000,
        )}s (${workspaceDaemonRetryCount}/20).`,
      )

      workspaceDaemonStarting = true
      workspaceDaemonStarted = false
      setTimeout(() => {
        startWorkspaceDaemon()
      }, delayMs)
    })

    child.on('error', (error) => {
      console.error(`[workspace-daemon] failed to spawn: ${error.message}`)
    })
  }

  const stopWorkspaceDaemon = async () => {
    const child = workspaceDaemonChild
    if (!child) {
      workspaceDaemonStarted = false
      workspaceDaemonStarting = false
      return
    }

    workspaceDaemonRestarting = true

    await new Promise<void>((resolve) => {
      const exitTimer = setTimeout(() => {
        if (!child.killed && child.pid) {
          try {
            process.kill(child.pid, 'SIGKILL')
          } catch {
            // ignore
          }
        }
      }, 5000)

      child.once('exit', () => {
        clearTimeout(exitTimer)
        resolve()
      })

      if (child.pid) {
        try {
          process.kill(child.pid, 'SIGTERM')
        } catch {
          clearTimeout(exitTimer)
          resolve()
        }
      } else {
        clearTimeout(exitTimer)
        resolve()
      }
    })

    workspaceDaemonStarted = false
    workspaceDaemonStarting = false
    workspaceDaemonRestarting = false
  }

  const restartWorkspaceDaemon = async () => {
    workspaceDaemonRetryCount = 0
    await stopWorkspaceDaemon()
    workspaceDaemonStarted = false
    workspaceDaemonStarting = false
    startWorkspaceDaemon()
  }

  const isPortInUse = (port: number) =>
    new Promise<boolean>((resolvePortCheck) => {
      const socket = net.createConnection({ port, host: '127.0.0.1' })
      socket.once('connect', () => {
        socket.destroy()
        resolvePortCheck(true)
      })
      socket.once('error', () => resolvePortCheck(false))
    })

  const hasHealthyWorkspaceDaemon = async () => {
    try {
      const response = await fetch(
        `http://127.0.0.1:${workspaceDaemonPort}/api/workspace/version`,
        {
          signal: AbortSignal.timeout(2000),
        },
      )
      return response.ok
    } catch {
      return false
    }
  }

  // Allow access from Tailscale, LAN, or custom domains via env var
  // e.g. HERMES_ALLOWED_HOSTS=my-server.tail1234.ts.net
  const _allowedHosts: string[] | true = env.HERMES_ALLOWED_HOSTS?.trim()
    ? env
        .HERMES_ALLOWED_HOSTS!.split(',')
        .map((h) => h.trim())
        .filter(Boolean)
    : ['.ts.net'] // allow all Tailscale hostnames by default
  let proxyTarget = 'http://127.0.0.1:18789'

  try {
    const parsed = new URL(nyxApiUrl)
    parsed.protocol = parsed.protocol === 'wss:' ? 'https:' : 'http:'
    parsed.pathname = ''
    proxyTarget = parsed.toString().replace(/\/$/, '')
  } catch {
    // fallback
  }

  return {
    define: {
      // Note: Do NOT set 'process.env': {} here — TanStack Start uses environment-based
      // builds where isSsrBuild is unreliable. Blanket process.env replacement breaks
      // server-side code in Docker (kills runtime env var access).
      // Client-side process.env is handled per-environment below.
    },
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./src', import.meta.url)),
        'bun:test': fileURLToPath(
          new URL('./src/test/bun-test-shim.ts', import.meta.url),
        ),
      },
    },
    ssr: {
      external: [
        'playwright',
        'playwright-core',
        'playwright-extra',
        'puppeteer-extra-plugin-stealth',
      ],
    },
    optimizeDeps: {
      exclude: [
        'playwright',
        'playwright-core',
        'playwright-extra',
        'puppeteer-extra-plugin-stealth',
      ],
    },
    build: {
      chunkSizeWarningLimit: 900,
    },
    server: {
      // Force IPv4 — 'localhost' resolves to ::1 (IPv6) on Windows, breaking connectivity
      host: '0.0.0.0',
      port: workspacePort,
      strictPort: false, // allow fallback if the workspace port is taken, but log clearly
      allowedHosts: true,
      watch: {
        // Exclude generated route tree — TanStack Router's file watcher
        // detects its own output as a change → infinite regeneration loop
        ignored: ['**/routeTree.gen.ts'],
      },
      proxy: {
        // WebSocket proxy: clients connect to /ws-nyx on the Nyx Workspace
        // server (any IP/port), which internally forwards to the local server.
        // This means phone/LAN/Docker users never need to reach port 18789 directly.
        '/ws-nyx': {
          target: proxyTarget,
          changeOrigin: false,
          ws: true,
          rewrite: (path) => path.replace(/^\/ws-nyx/, ''),
        },
// REST API proxy: API proxy for Nyx backend
        '/api/nyx-proxy': {
          target: proxyTarget,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/api\/nyx-proxy/, ''),
        },
        '/nyx-ui': {
          target: proxyTarget,
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/nyx-ui/, ''),
          ws: true,
          configure: (proxy) => {
            proxy.on('proxyRes', (_proxyRes) => {
              // Strip iframe-blocking headers so we can embed
              delete _proxyRes.headers['x-frame-options']
              delete _proxyRes.headers['content-security-policy']
            })
          },
        },
        '/workspace-api': {
          target: 'http://127.0.0.1:3099',
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/workspace-api/, ''),
        },
      },
    },
    plugins: [
      // devtools(),
      // this is the plugin that enables path aliases
      viteTsConfigPaths({
        projects: ['./tsconfig.json'],
      }),
      tailwindcss(),
      tanstackStart(),
      viteReact(),
      {
        name: 'serve-local-monaco',
        configureServer(server) {
          server.middlewares.use(createMonacoMiddleware())
        },
      },
      {
        name: 'workspace-daemon',
        buildStart() {
          if (command !== 'serve') return
        },
        configureServer(server) {
          server.middlewares.use(async (req, res, next) => {
            const requestPath = req.url?.split('?')[0]
            if (req.method === 'GET' && requestPath === '/api/healthcheck') {
              res.statusCode = 200
              res.setHeader('content-type', 'application/json')
              res.end(JSON.stringify({ ok: true }))
              return
            }

            // Portable-aware health check — returns ok if any chat backend is available
            if (
              req.method === 'GET' &&
              requestPath === '/api/connection-status'
            ) {
              try {
                // Check for enhanced Nyx gateway first (has /api/sessions)
                const [modelsRes, sessionsRes] = await Promise.all([
                  fetch(`${nyxApiUrl}/v1/models`, {
                    headers: apiHeaders,
                    signal: AbortSignal.timeout(3000),
                  }).catch(() => null),
                  fetch(`${nyxApiUrl}/api/sessions?limit=1`, {
                    headers: apiHeaders,
                    signal: AbortSignal.timeout(3000),
                  }).catch(() => null),
                ])
                const hasModels = modelsRes
                  ? isGatewayApiProbeResponse(modelsRes)
                  : false
                const hasSessions = sessionsRes
                  ? isGatewayApiProbeResponse(sessionsRes)
                  : false
                if (hasSessions) {
                  res.statusCode = 200
                  res.setHeader('content-type', 'application/json')
                  res.end(
                    JSON.stringify({
                      ok: true,
                      mode: 'enhanced',
                      backend: nyxApiUrl,
                    }),
                  )
                  return
                }
                if (hasModels) {
                  res.statusCode = 200
                  res.setHeader('content-type', 'application/json')
                  res.end(
                    JSON.stringify({
                      ok: true,
                      mode: 'portable',
                      backend: nyxApiUrl,
                    }),
                  )
                  return
                }
                // Fall back to /health for full Nyx backends
                const healthRes = await fetch(`${nyxApiUrl}/health`, {
                  headers: apiHeaders,
                  signal: AbortSignal.timeout(3000),
                })
                res.statusCode = healthRes.ok ? 200 : 502
                res.setHeader('content-type', 'application/json')
                res.end(
                  JSON.stringify({
                    ok: healthRes.ok,
                    mode: 'enhanced',
                    backend: nyxApiUrl,
                  }),
                )
              } catch {
                res.statusCode = 502
                res.setHeader('content-type', 'application/json')
                res.end(
                  JSON.stringify({
                    ok: false,
                    mode: 'disconnected',
                    backend: nyxApiUrl,
                  }),
                )
              }
              return
            }

            if (
              req.method !== 'POST' ||
              requestPath !== '/api/workspace/daemon/restart'
            ) {
              next()
              return
            }

            try {
              await restartWorkspaceDaemon()
              res.statusCode = 200
              res.setHeader('content-type', 'application/json')
              res.end(JSON.stringify({ ok: true }))
            } catch (error) {
              res.statusCode = 500
              res.setHeader('content-type', 'application/json')
              res.end(
                JSON.stringify({
                  error:
                    error instanceof Error ? error.message : 'Internal error',
                }),
              )
            }
          })

          server.httpServer?.on('close', () => {
            workspaceDaemonShuttingDown = true
            workspaceDaemonStarted = false
            workspaceDaemonStarting = false
            if (workspaceDaemonChild) {
              workspaceDaemonChild.kill()
              workspaceDaemonChild = null
            }
          })

          // Auto-start nyx-agent when dev server launches
          if (command === 'serve') {
            void startNyxAgent()
          }

          // Shutdown nyx-agent when dev server stops
          server.httpServer?.on('close', () => {
            if (nyxAgentChild) {
              console.log('[nyx-agent] Stopping...')
              nyxAgentChild.kill('SIGTERM')
              nyxAgentChild = null
              nyxAgentStarted = false
            }
          })

          if (
            env.NYX_WORKSPACE === '1' ||
            command !== 'serve' ||
            workspaceDaemonStarted ||
            workspaceDaemonStarting
          )
            return

          workspaceDaemonStarting = true
          void (async () => {
            const running = await isPortInUse(Number(workspaceDaemonPort))
            if (workspaceDaemonStarted) {
              workspaceDaemonStarting = false
              return
            }

            if (running) {
              const healthy = await hasHealthyWorkspaceDaemon()
              if (healthy) {
                workspaceDaemonStarting = false
                console.log('[workspace-daemon] Reusing existing daemon')
                return
              }

              try {
                execSync(
                  `lsof -ti:${workspaceDaemonPort} | xargs kill -9 2>/dev/null || true`,
                )
              } catch {
                // ignore stale cleanup failures and continue with a fresh spawn
              }
            }

            startWorkspaceDaemon()
          })()
        },
      },
      // Client-only: replace process.env references in client bundles
      // Server bundles must keep real process.env for Docker runtime env vars
      {
        name: 'client-process-env',
        enforce: 'pre',
        transform(code, _id) {
          const envName = this.environment?.name
          if (envName !== 'client') return null
          if (
            !code.includes('process.env') &&
            !code.includes('process.platform')
          )
            return null

          // Replace specific env vars first, then the generic fallback
          let result = code
          result = result.replace(
            /process\.env\.NYX_API_URL/g,
            JSON.stringify(nyxApiUrl),
          )
          result = result.replace(
            /process\.env\.NYX_WORKSPACE_API_URL/g,
            JSON.stringify(nyxApiUrl),
          )
          result = result.replace(
            /process\.env\.NYX_API_TOKEN/g,
            JSON.stringify(env.NYX_API_TOKEN || ''),
          )
          result = result.replace(
            /process\.env\.NYX_WORKSPACE_NAME/g,
            JSON.stringify(env.NYX_WORKSPACE_NAME || ''),
          )
          result = result.replace(
            /process\.env\.NYX_WORKSPACE_AGENT_NAME/g,
            JSON.stringify(env.NYX_WORKSPACE_AGENT_NAME || ''),
          )
          result = result.replace(
            /process\.env\.NODE_ENV/g,
            JSON.stringify(mode),
          )
          result = result.replace(/process\.env/g, '{}')
          result = result.replace(/process\.platform/g, '"browser"')
          return result
        },
      },
      // Copy pty-helper.py into the server assets directory after build
      {
        name: 'copy-pty-helper',
        closeBundle() {
          const src = resolve('src/server/pty-helper.py')
          const destDir = resolve('dist/server/assets')
          const dest = resolve(destDir, 'pty-helper.py')
          if (existsSync(src)) {
            mkdirSync(destDir, { recursive: true })
            copyFileSync(src, dest)
          }
        },
      },
    ],
  }
})

export default config

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'bun:test'
import { startNyxHive } from './nyxhive-starter'

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { 'content-type': 'application/json', ...init?.headers },
  })
}

const tempDirs: Array<string> = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('NyxHive workspace starter', () => {
  test('restarts the local NyxAI instance when the configured backend is down', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'nyxhive-starter-'))
    tempDirs.push(repoDir)
    mkdirSync(join(repoDir, 'scripts'), { recursive: true })
    writeFileSync(join(repoDir, 'scripts', 'restart-instance.sh'), '#!/bin/sh\n')

    const spawned: Array<{
      command: string
      args: Array<string>
      cwd?: string
      restartSource?: string
      restartReason?: string
    }> =
      []
    let fetchCount = 0

    const result = await startNyxHive({
      env: {
        NYX_WORKSPACE_API_URL: 'http://127.0.0.1:3779',
        NYXHIVE_REPO_DIR: repoDir,
      },
      sleep: async () => {},
      fetchImpl: async () => {
        fetchCount += 1
        if (fetchCount <= 2) {
          throw new Error('backend down')
        }
        return jsonResponse({ name: 'NyxAI', status: 'running' })
      },
      spawnCommand: async (command, args, options) => {
        spawned.push({
          command,
          args,
          cwd: options.cwd,
          restartSource: options.env.NYXHIVE_RESTART_SOURCE,
          restartReason: options.env.NYXHIVE_RESTART_REASON,
        })
        return { code: 0, output: 'nyxai is up on port 3779' }
      },
    })

    expect(result).toEqual({
      ok: true,
      message: 'started NyxAI',
      instance: 'nyxai',
      backend: 'http://127.0.0.1:3779',
    })
    expect(spawned).toEqual([
      {
        command: join(repoDir, 'scripts', 'restart-instance.sh'),
        args: ['nyxai'],
        cwd: repoDir,
        restartSource: 'workspace-autostart',
        restartReason: 'backend probe failed for http://127.0.0.1:3779',
      },
    ])
  })

  test('restarts Astra when the workspace instance is configured', async () => {
    const repoDir = mkdtempSync(join(tmpdir(), 'nyxhive-starter-'))
    tempDirs.push(repoDir)
    mkdirSync(join(repoDir, 'scripts'), { recursive: true })
    writeFileSync(join(repoDir, 'scripts', 'restart-instance.sh'), '#!/bin/sh\n')

    const spawned: Array<{ command: string; args: Array<string>; cwd?: string }> =
      []
    let fetchCount = 0

    const result = await startNyxHive({
      env: {
        NYX_WORKSPACE_API_URL: 'http://127.0.0.1:3782',
        NYX_WORKSPACE_INSTANCE: 'astra-trading',
        NYXHIVE_REPO_DIR: repoDir,
      },
      sleep: async () => {},
      fetchImpl: async () => {
        fetchCount += 1
        if (fetchCount <= 2) {
          throw new Error('backend down')
        }
        return jsonResponse({ name: 'Astra Trading', status: 'running' })
      },
      spawnCommand: async (command, args, options) => {
        spawned.push({ command, args, cwd: options.cwd })
        return { code: 0, output: 'astra-trading is up on port 3782' }
      },
    })

    expect(result).toEqual({
      ok: true,
      message: 'started Astra Trading',
      instance: 'astra-trading',
      backend: 'http://127.0.0.1:3782',
    })
    expect(spawned).toEqual([
      {
        command: join(repoDir, 'scripts', 'restart-instance.sh'),
        args: ['astra-trading'],
        cwd: repoDir,
      },
    ])
  })
})

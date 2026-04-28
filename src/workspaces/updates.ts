import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import TOML from '@iarna/toml'
import { z } from 'zod'

const engineIdentitySchema = z.object({
  source: z.literal('local-git'),
  path: z.string().min(1),
  ref: z.string().min(1),
  commit: z.string().min(1),
})

const engineLockSchema = z.object({
  engine: engineIdentitySchema,
})

export type EngineIdentity = z.infer<typeof engineIdentitySchema>
export type EngineLock = z.infer<typeof engineLockSchema>
export type EngineUpdateState = 'unknown' | 'current' | 'update_available' | 'action_required'

export interface EngineUpdateStatus {
  workspaceId?: string
  state: EngineUpdateState
  reason: string
  current: EngineIdentity
  locked?: EngineLock
}

export function engineLockPath(workspaceRoot: string): string {
  return join(workspaceRoot, '.nyxhive', 'engine.lock')
}

export function readEngineLock(workspaceRoot: string): EngineLock | undefined {
  const file = engineLockPath(workspaceRoot)
  if (!existsSync(file)) return undefined

  return engineLockSchema.parse(TOML.parse(readFileSync(file, 'utf-8')))
}

export function writeEngineLock(workspaceRoot: string, identity: EngineIdentity): void {
  const file = engineLockPath(workspaceRoot)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, TOML.stringify({ engine: identity } as TOML.JsonMap))
}

export function compareEngineLock(
  workspaceRoot: string,
  current: EngineIdentity,
  workspaceId?: string,
): EngineUpdateStatus {
  const locked = readEngineLock(workspaceRoot)
  if (!locked) {
    return {
      workspaceId,
      state: 'action_required',
      reason: 'Workspace has no .nyxhive/engine.lock',
      current,
    }
  }

  if (locked.engine.path !== current.path || locked.engine.ref !== current.ref) {
    return {
      workspaceId,
      state: 'action_required',
      reason: 'Workspace engine source changed',
      current,
      locked,
    }
  }

  if (locked.engine.commit !== current.commit) {
    return {
      workspaceId,
      state: 'update_available',
      reason: `Engine advanced from ${locked.engine.commit} to ${current.commit}`,
      current,
      locked,
    }
  }

  return {
    workspaceId,
    state: 'current',
    reason: 'Workspace engine lock matches current engine',
    current,
    locked,
  }
}

export function getCurrentEngineIdentity(engineRoot = resolve(import.meta.dir, '../..')): EngineIdentity {
  const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: engineRoot,
    encoding: 'utf-8',
  }).trim()
  const ref = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
    cwd: engineRoot,
    encoding: 'utf-8',
  }).trim()

  return {
    source: 'local-git',
    path: engineRoot,
    ref,
    commit,
  }
}

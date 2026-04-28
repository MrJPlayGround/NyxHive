import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import TOML from '@iarna/toml'
import { z } from 'zod'

const registrySchema = z.object({
  workspaces: z.array(
    z.object({
      id: z.string().min(1),
      path: z.string().min(1),
    }),
  ).default([]),
})

export type WorkspaceRegistry = z.infer<typeof registrySchema>

export function workspaceRegistryPath(): string {
  const home = process.env.HOME ?? '/home/user'
  return process.env.NYXHIVE_WORKSPACE_REGISTRY ?? join(home, '.nyxhive', 'workspaces.toml')
}

export function loadWorkspaceRegistry(path = workspaceRegistryPath()): WorkspaceRegistry {
  if (!existsSync(path)) return { workspaces: [] }

  const parsed = TOML.parse(readFileSync(path, 'utf-8'))
  return registrySchema.parse(parsed)
}

export function saveWorkspaceRegistry(path: string, registry: WorkspaceRegistry): void {
  mkdirSync(dirname(path), { recursive: true })
  const normalized = registrySchema.parse(registry)
  writeFileSync(path, TOML.stringify(normalized as TOML.JsonMap))
}

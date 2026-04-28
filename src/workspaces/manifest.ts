import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import TOML from '@iarna/toml'
import { z } from 'zod'

const engineSchema = z.object({
  source: z.enum(['local-git']),
  path: z.string().min(1),
  ref: z.string().min(1).default('master'),
  constraint: z.string().optional(),
})

const runtimeSchema = z.object({
  instance_id: z.string().optional(),
  data_namespace: z.string().optional(),
  config: z.string().default('.nyxhive/config.toml'),
  api_url: z.string().url().optional(),
  api_key_env: z.string().default('NYXHIVE_API_KEY'),
  app_port: z.number().int().positive().optional(),
  app_host: z.string().default('127.0.0.1'),
  agent_name: z.string().optional(),
  tmux_session: z.string().optional(),
  vault_root: z.string().optional(),
  memory_exclude_prefixes: z.array(z.string()).default([]),
  agents: z.array(z.string()).default([]),
})

const workspaceManifestSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['agent', 'product']),
  display_name: z.string().min(1),
  aliases: z.array(z.string()).default([]),
  engine: engineSchema,
  runtime: runtimeSchema.optional(),
})

export type WorkspaceManifest = z.infer<typeof workspaceManifestSchema>

export function workspaceManifestPath(root: string): string {
  return resolve(root, '.nyxhive', 'workspace.toml')
}

export function loadWorkspaceManifest(root: string): WorkspaceManifest {
  const manifestPath = workspaceManifestPath(root)
  if (!existsSync(manifestPath)) {
    throw new Error(`Missing workspace manifest: ${manifestPath}`)
  }

  const parsed = TOML.parse(readFileSync(manifestPath, 'utf-8'))
  const manifest = workspaceManifestSchema.parse(parsed)

  if (
    manifest.kind === 'agent' &&
    (!manifest.runtime?.instance_id || !manifest.runtime.data_namespace)
  ) {
    throw new Error(
      'Agent instances must declare runtime.instance_id and runtime.data_namespace',
    )
  }

  if (manifest.kind === 'product' && manifest.runtime?.agents.length) {
    throw new Error('Product workspaces cannot declare runtime agents')
  }

  return manifest
}

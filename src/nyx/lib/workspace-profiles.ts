import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  discoverRegisteredWorkspaceManifests,
  discoverWorkspaceManifests,
  type RegisteredWorkspaceManifest,
} from '../../workspaces/registry.js'

export interface WorkspaceProfile {
  id: string
  aliases: string[]
  displayName: string
  backendInstance: string
  agentName: string
  apiUrl: string
  apiKeyEnv: string
  appPort: number
  appHost: string
  tmuxSession: string
  envFiles: string[]
  workspaceRoot: string
  workspaceHome: string
  vaultRoot: string
  memoryNamespace: string
  memoryExcludePrefixes?: string[]
}

const home = process.env.HOME ?? '/home/user'
const repoRoot = resolve(import.meta.dir, '../../..')

export const WORKSPACE_PROFILES: WorkspaceProfile[] = [
  {
    id: 'nyxai',
    aliases: ['nyx', 'nyxai', 'core'],
    displayName: 'Nyx Workspace',
    backendInstance: 'nyxai',
    agentName: 'Nyx',
    apiUrl: 'http://127.0.0.1:3779',
    apiKeyEnv: 'NYXHIVE_API_KEY',
    appPort: 3777,
    appHost: '127.0.0.1',
    tmuxSession: 'nyx-workspace-vite',
    envFiles: [
      join(repoRoot, '.nyxhive', '.env'),
      join(repoRoot, '.nyxhive', 'env'),
    ],
    workspaceRoot: repoRoot,
    workspaceHome: join(repoRoot, '.nyxhive'),
    vaultRoot: join(home, 'dev', 'obsidian', 'NyxAI'),
    memoryNamespace: 'NyxAI',
    memoryExcludePrefixes: ['Projects/Trading-Journal/'],
  },
  {
    id: 'vortex',
    aliases: ['vortex', 'nyxlabs', 'labs'],
    displayName: 'Vortex Workspace',
    backendInstance: 'nyxlabs',
    agentName: 'Vortex',
    apiUrl: 'http://127.0.0.1:3778',
    apiKeyEnv: 'NYXLABS_REMOTE_API_KEY',
    appPort: 3781,
    appHost: '127.0.0.1',
    tmuxSession: 'vortex-workspace',
    envFiles: [
      join(home, '.nyxhive', 'instances', 'NyxLabs', '.env'),
      join(home, '.nyxhive', 'instances', 'NyxLabs', 'env'),
    ],
    workspaceRoot: join(home, 'dev', 'personal', 'nyxlabs'),
    workspaceHome: join(home, '.nyxhive', 'instances', 'NyxLabs'),
    vaultRoot: join(home, 'dev', 'obsidian', 'NyxLabs'),
    memoryNamespace: 'NyxLabs',
  },
]

export interface ListWorkspaceProfilesOptions {
  roots?: string[]
  registryPath?: string
  includeFallbacks?: boolean
}

function profileFromManifest(entry: RegisteredWorkspaceManifest): WorkspaceProfile | undefined {
  const { root, manifest } = entry
  if (manifest.kind !== 'agent' || !manifest.runtime) return undefined

  const runtime = manifest.runtime
  const agentId = runtime.agents[0] ?? manifest.id

  return {
    id: manifest.id,
    aliases: [...manifest.aliases, ...runtime.agents],
    displayName: manifest.display_name,
    backendInstance: runtime.instance_id ?? manifest.id,
    agentName: runtime.agent_name ?? agentId,
    apiUrl: runtime.api_url ?? 'http://127.0.0.1:3779',
    apiKeyEnv: runtime.api_key_env,
    appPort: runtime.app_port ?? 3777,
    appHost: runtime.app_host,
    tmuxSession: runtime.tmux_session ?? `${manifest.id}-workspace`,
    envFiles: [
      join(root, '.nyxhive', '.env'),
      join(root, '.nyxhive', 'env'),
    ],
    workspaceRoot: root,
    workspaceHome: join(root, '.nyxhive'),
    vaultRoot: runtime.vault_root ?? join(root, 'knowledge'),
    memoryNamespace: runtime.data_namespace ?? manifest.id,
    memoryExcludePrefixes: runtime.memory_exclude_prefixes,
  }
}

export function listWorkspaceProfiles(
  options: ListWorkspaceProfilesOptions = {},
): WorkspaceProfile[] {
  const includeFallbacks = options.includeFallbacks ?? true
  const manifestEntries = options.roots
    ? discoverWorkspaceManifests(options.roots)
    : discoverRegisteredWorkspaceManifests(options.registryPath)
  const manifestProfiles = manifestEntries
    .map(profileFromManifest)
    .filter((profile): profile is WorkspaceProfile => Boolean(profile))

  if (!includeFallbacks) return manifestProfiles

  const registeredIds = new Set(manifestProfiles.map((profile) => profile.id))
  return [
    ...manifestProfiles,
    ...WORKSPACE_PROFILES.filter((profile) => !registeredIds.has(profile.id)),
  ]
}

export function resolveWorkspaceProfile(
  value?: string | null,
  options: ListWorkspaceProfilesOptions = {},
): WorkspaceProfile {
  const normalized = (value || 'nyxai').trim().toLowerCase()
  const match = listWorkspaceProfiles(options).find(
    (profile) =>
      profile.id === normalized ||
      profile.aliases.some((alias) => alias.toLowerCase() === normalized),
  )
  if (!match) {
    throw new Error(`Unknown workspace profile: ${value}`)
  }
  return match
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function buildWorkspaceStartCommand(
  profile: WorkspaceProfile,
  root = repoRoot,
): string {
  const envSources = profile.envFiles
    .filter((path) => existsSync(path))
    .map((path) => `. ${shellQuote(path)}`)
    .join(' && ')
  const sourcePrefix = envSources
    ? `set -a && ${envSources} && set +a && `
    : ''

  const envAssignments = [
    'NODE_OPTIONS="--max-old-space-size=2048"',
    `NYX_WORKSPACE_INSTANCE=${shellQuote(profile.backendInstance)}`,
    `NYX_WORKSPACE_AGENT_NAME=${shellQuote(profile.agentName)}`,
    `NYX_WORKSPACE_NAME=${shellQuote(profile.displayName)}`,
    `NYX_WORKSPACE_HOST=${shellQuote(profile.appHost)}`,
    `NYX_WORKSPACE_HOME=${shellQuote(profile.workspaceHome)}`,
    `NYX_WORKSPACE_VAULT_ROOT=${shellQuote(profile.vaultRoot)}`,
    `NYX_WORKSPACE_MEMORY_NAMESPACE=${shellQuote(profile.memoryNamespace)}`,
    ...(profile.memoryExcludePrefixes?.length
      ? [
          `NYX_WORKSPACE_MEMORY_EXCLUDE_PREFIXES=${shellQuote(
            profile.memoryExcludePrefixes.join(','),
          )}`,
        ]
      : []),
    `KNOWLEDGE_DIR=${shellQuote(profile.vaultRoot)}`,
    'NYX_WORKSPACE=1',
    `NYX_WORKSPACE_API_URL=${shellQuote(profile.apiUrl)}`,
    `NYX_WORKSPACE_API_KEY="$${profile.apiKeyEnv}"`,
    `NYX_WORKSPACE_PORT=${profile.appPort}`,
  ].join(' ')

  return [
    `cd ${shellQuote(root)}`,
    sourcePrefix + `${envAssignments} bun --cwd src/nyx-workspace build`,
    `${envAssignments} PORT=${profile.appPort} HOST=${shellQuote(profile.appHost)} bun --cwd src/nyx-workspace start`,
  ].join(' && ')
}

export function profileSummary(profile: WorkspaceProfile): string {
  return `${profile.displayName} (${profile.id}) -> ${profile.apiUrl}, app :${profile.appPort}`
}

import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import path from 'node:path'
import TOML from '@iarna/toml'
import YAML from 'yaml'

export type ProfileSummary = {
  name: string
  path: string
  active: boolean
  exists: boolean
  source?: 'profile' | 'instance'
  instanceName?: string
  model?: string
  provider?: string
  agentCount?: number
  skillCount: number
  sessionCount: number
  hasEnv: boolean
  updatedAt?: string
}

export type ProfileDetail = {
  name: string
  path: string
  active: boolean
  config: Record<string, unknown>
  envPath?: string
  hasEnv: boolean
  sessionsDir?: string
  skillsDir?: string
}

type ParsedAgent = {
  key: string
  name?: string
  role?: string
  provider?: string
  model?: string
  workingDirectory?: string
}

type InstanceProfile = ProfileSummary & {
  config: Record<string, unknown>
  envPath?: string
  sessionsDir?: string
  skillsDir?: string
  port?: number
}

type InstanceCandidate = {
  name: string
  path: string
  configPath?: string
  port?: number
}

function getNyxHiveRoot(): string {
  return process.env.NYXHIVE_HOME ?? path.join(os.homedir(), '.nyxhive')
}

function getInstancesRoot(): string {
  return path.join(getNyxHiveRoot(), 'instances')
}

export function getProfilesRoot(): string {
  return path.join(getNyxHiveRoot(), 'profiles')
}

function getActiveProfilePath(): string {
  return path.join(getNyxHiveRoot(), 'active_profile')
}

function getBookmarksPath(): string {
  return path.join(process.env.HOME ?? os.homedir(), '.nyxhive', 'bookmarks.json')
}

function getWorkspaceRegistryPath(): string {
  return (
    process.env.NYXHIVE_WORKSPACE_REGISTRY ??
    path.join(process.env.HOME ?? os.homedir(), '.nyxhive', 'workspaces.toml')
  )
}

function validateProfileName(name: string): string {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('Profile name is required')
  if (trimmed === 'default')
    throw new Error('Default profile cannot be modified here')
  if (
    trimmed.includes('/') ||
    trimmed.includes('\\') ||
    trimmed.includes('..')
  ) {
    throw new Error('Invalid profile name')
  }
  return trimmed
}

function safeReadText(filePath: string): string {
  return fs.readFileSync(filePath, 'utf-8')
}

function readYamlConfig(configPath: string): Record<string, unknown> {
  if (!fs.existsSync(configPath)) return {}
  try {
    return (
      (YAML.parse(safeReadText(configPath)) as Record<string, unknown>) || {}
    )
  } catch {
    return {}
  }
}

function readTomlLikeConfig(configPath: string): {
  daemon: Record<string, unknown>
  server: Record<string, unknown>
  agents: Array<ParsedAgent>
} {
  const parsed = {
    daemon: {} as Record<string, unknown>,
    server: {} as Record<string, unknown>,
    agents: [] as Array<ParsedAgent>,
  }
  if (!fs.existsSync(configPath)) return parsed

  let section = ''
  const agents = new Map<string, ParsedAgent>()
  for (const rawLine of safeReadText(configPath).split(/\r?\n/)) {
    const sectionMatch = rawLine.match(/^\s*\[([^\]]+)\]\s*$/)
    if (sectionMatch) {
      section = sectionMatch[1] ?? ''
      continue
    }

    const valueMatch = rawLine.match(
      /^\s*([A-Za-z0-9_]+)\s*=\s*(?:"([^"]*)"|([0-9]+)|true|false)/,
    )
    if (!valueMatch) continue

    const key = valueMatch[1] ?? ''
    const value =
      valueMatch[2] !== undefined
        ? valueMatch[2]
        : valueMatch[3] !== undefined
          ? Number(valueMatch[3])
          : rawLine.includes('true')
            ? true
            : false

    if (section === 'daemon') {
      parsed.daemon[key] = value
      continue
    }
    if (section === 'server') {
      parsed.server[key] = value
      continue
    }
    if (section.startsWith('agents.')) {
      const agentKey = section.slice('agents.'.length)
      const agent = agents.get(agentKey) ?? { key: agentKey }
      if (key === 'working_directory') {
        agent.workingDirectory = String(value)
      } else {
        ;(agent as Record<string, unknown>)[key] = value
      }
      agents.set(agentKey, agent)
    }
  }

  parsed.agents = Array.from(agents.values())
  return parsed
}

function readBookmarkedInstances(): Array<InstanceCandidate> {
  const bookmarksPath = getBookmarksPath()
  if (!fs.existsSync(bookmarksPath)) return []

  try {
    const data = JSON.parse(safeReadText(bookmarksPath)) as {
      bookmarks?: Array<{
        name?: unknown
        path?: unknown
        port?: unknown
      }>
    }
    if (!Array.isArray(data.bookmarks)) return []

    return data.bookmarks
      .filter(
        (bookmark): bookmark is { name?: string; path: string; port?: number } =>
          typeof bookmark.path === 'string' &&
          bookmark.path.trim().length > 0,
      )
      .map((bookmark) => ({
        name:
          typeof bookmark.name === 'string' && bookmark.name.trim()
            ? bookmark.name
            : path.basename(bookmark.path),
        path: bookmark.path,
        port: typeof bookmark.port === 'number' ? bookmark.port : undefined,
      }))
  } catch {
    return []
  }
}

function readRegisteredWorkspaceInstances(): Array<InstanceCandidate> {
  const registryPath = getWorkspaceRegistryPath()
  if (!fs.existsSync(registryPath)) return []

  try {
    const registry = TOML.parse(safeReadText(registryPath)) as {
      workspaces?: Array<{ id?: unknown; path?: unknown }>
    }
    if (!Array.isArray(registry.workspaces)) return []

    return registry.workspaces.flatMap((workspace) => {
      if (typeof workspace.path !== 'string' || !workspace.path.trim()) {
        return []
      }

      const workspaceRoot = path.resolve(workspace.path)
      const manifestPath = path.join(workspaceRoot, '.nyxhive', 'workspace.toml')
      if (!fs.existsSync(manifestPath)) return []

      const manifest = TOML.parse(safeReadText(manifestPath)) as {
        id?: unknown
        kind?: unknown
        display_name?: unknown
        runtime?: {
          config?: unknown
          api_url?: unknown
        }
      }
      if (manifest.kind !== 'agent') return []

      const runtimeConfig =
        typeof manifest.runtime?.config === 'string'
          ? manifest.runtime.config
          : '.nyxhive/config.toml'
      const configPath = path.resolve(workspaceRoot, runtimeConfig)
      const apiUrl =
        typeof manifest.runtime?.api_url === 'string'
          ? manifest.runtime.api_url
          : undefined
      const port = apiUrl ? Number(new URL(apiUrl).port) : undefined

      return [
        {
          name:
            typeof manifest.display_name === 'string' && manifest.display_name.trim()
              ? manifest.display_name
              : typeof workspace.id === 'string' && workspace.id.trim()
                ? workspace.id
                : path.basename(workspaceRoot),
          path: path.dirname(configPath),
          configPath,
          port: Number.isFinite(port) ? port : undefined,
        },
      ]
    })
  } catch {
    return []
  }
}

function canonicalInstanceKey(instancePath: string): string {
  try {
    return fs.realpathSync(instancePath)
  } catch {
    return path.resolve(instancePath)
  }
}

function listInstanceCandidates(): Array<InstanceCandidate> {
  const candidates: Array<InstanceCandidate> = []
  const instancesRoot = getInstancesRoot()

  if (fs.existsSync(instancesRoot)) {
    let entries: Array<fs.Dirent> = []
    try {
      entries = fs.readdirSync(instancesRoot, { withFileTypes: true })
    } catch {
      entries = []
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      candidates.push({
        name: entry.name,
        path: path.join(instancesRoot, entry.name),
      })
    }
  }

  candidates.push(...readBookmarkedInstances())
  candidates.push(...readRegisteredWorkspaceInstances())

  const seen = new Set<string>()
  return candidates.filter((candidate) => {
    const key = canonicalInstanceKey(candidate.path)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function selectLeadAgent(agents: Array<ParsedAgent>): ParsedAgent | undefined {
  return (
    agents.find((agent) => agent.role === 'lead') ??
    agents.find((agent) => agent.role === 'orchestrator') ??
    agents.find((agent) => !['tester', 'sentinel'].includes(agent.key)) ??
    agents[0]
  )
}

function safeListFiles(rootPath: string): Array<string> {
  if (!fs.existsSync(rootPath)) return []
  try {
    return fs
      .readdirSync(rootPath, { withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => path.join(rootPath, entry.name))
  } catch {
    return []
  }
}

function countActiveThreads(dataDir: string, instanceName: string): number {
  const candidates = [
    path.join(dataDir, `${instanceName}-threads.db`),
    ...safeListFiles(dataDir).filter((filePath) =>
      filePath.endsWith('-threads.db'),
    ),
  ]
  const dbPath = candidates.find((candidate) => fs.existsSync(candidate))
  if (!dbPath) return 0

  // Workspace SSR goes through Node's loader in dev, so bun:sqlite cannot be
  // imported here without breaking live API routes.
  const result = spawnSync(
    'sqlite3',
    [dbPath, 'select count(*) from threads where coalesce(archived, 0) = 0;'],
    { encoding: 'utf-8', timeout: 2000 },
  )
  if (result.status !== 0 || result.error) return 0

  const count = Number.parseInt(result.stdout.trim(), 10)
  return Number.isFinite(count) ? count : 0
}

function listInstanceProfiles(): Array<InstanceProfile> {
  const profiles: Array<InstanceProfile> = []
  for (const candidate of listInstanceCandidates()) {
    const instancePath = candidate.path
    const configPath = candidate.configPath ?? path.join(instancePath, 'config.toml')
    if (!fs.existsSync(configPath)) continue

    const parsed = readTomlLikeConfig(configPath)
    const lead = selectLeadAgent(parsed.agents)
    const profileName = lead?.name || lead?.key || candidate.name
    const dataDir =
      typeof parsed.daemon.data_dir === 'string'
        ? path.resolve(instancePath, parsed.daemon.data_dir)
        : path.join(instancePath, 'data')
    const envPath = path.join(instancePath, '.env')
    const skillsDir = path.join(instancePath, 'skills')
    const instanceName =
      typeof parsed.daemon.name === 'string' ? parsed.daemon.name : candidate.name
    const config = {
      daemon: parsed.daemon,
      server: parsed.server,
      leadAgent: lead ?? null,
      instancePath,
      configPath,
    }

    profiles.push({
      name: profileName,
      path: instancePath,
      active: false,
      exists: true,
      source: 'instance',
      instanceName,
      model: lead?.model,
      provider: lead?.provider,
      agentCount: parsed.agents.length,
      skillCount: countFilesRecursive(
        skillsDir,
        (full) => path.basename(full) === 'SKILL.md',
      ),
      sessionCount: countActiveThreads(dataDir, instanceName),
      hasEnv: fs.existsSync(envPath),
      envPath: fs.existsSync(envPath) ? envPath : undefined,
      sessionsDir: fs.existsSync(dataDir) ? dataDir : undefined,
      skillsDir: fs.existsSync(skillsDir) ? skillsDir : undefined,
      config,
      port:
        typeof parsed.server.port === 'number'
          ? parsed.server.port
          : candidate.port,
      updatedAt: latestMtime([instancePath, configPath, envPath, dataDir]),
    })
  }
  return profiles
}

function findInstanceProfile(name: string): InstanceProfile | undefined {
  const lower = name.toLowerCase()
  return listInstanceProfiles().find(
    (profile) =>
      profile.name.toLowerCase() === lower ||
      profile.instanceName?.toLowerCase() === lower,
  )
}

function inferDefaultActiveProfileName(): string {
  const profiles = listInstanceProfiles()
  const apiUrl = process.env.NYX_WORKSPACE_API_URL || process.env.NYX_API_URL
  if (apiUrl) {
    try {
      const port = Number(new URL(apiUrl).port)
      const matched = profiles.find((profile) => profile.port === port)
      if (matched) return matched.name
    } catch {
      // ignore malformed dev env
    }
  }
  return (
    profiles.find((profile) => profile.name === 'Nyx')?.name ??
    profiles[0]?.name ??
    'Nyx'
  )
}

function countFilesRecursive(
  rootPath: string,
  predicate: (fullPath: string) => boolean,
): number {
  if (!fs.existsSync(rootPath)) return 0
  let count = 0
  const stack = [rootPath]
  while (stack.length > 0) {
    const current = stack.pop() as string
    let entries: Array<fs.Dirent> = []
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(fullPath)
        continue
      }
      if (predicate(fullPath)) count += 1
    }
  }
  return count
}

function latestMtime(paths: Array<string>): string | undefined {
  let latest = 0
  for (const target of paths) {
    if (!fs.existsSync(target)) continue
    try {
      const stat = fs.statSync(target)
      latest = Math.max(latest, stat.mtimeMs)
    } catch {
      // ignore
    }
  }
  return latest > 0 ? new Date(latest).toISOString() : undefined
}

export function getActiveProfileName(): string {
  const activePath = getActiveProfilePath()
  if (!fs.existsSync(activePath)) return inferDefaultActiveProfileName()
  try {
    const raw = safeReadText(activePath).trim()
    return raw || inferDefaultActiveProfileName()
  } catch {
    return inferDefaultActiveProfileName()
  }
}

export function listProfiles(): Array<ProfileSummary> {
  const profilesRoot = getProfilesRoot()
  const activeProfile = getActiveProfileName()
  const results: Array<ProfileSummary> = []

  if (fs.existsSync(profilesRoot)) {
    let entries: Array<fs.Dirent> = []
    try {
      entries = fs.readdirSync(profilesRoot, { withFileTypes: true })
    } catch {
      entries = []
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const name = entry.name
      const profilePath = path.join(profilesRoot, name)
      const configPath = path.join(profilePath, 'config.yaml')
      const envPath = path.join(profilePath, '.env')
      const skillsDir = path.join(profilePath, 'skills')
      const sessionsDir = path.join(profilePath, 'sessions')
      const config = readYamlConfig(configPath)
      const skillCount = countFilesRecursive(
        skillsDir,
        (full) => path.basename(full) === 'SKILL.md',
      )
      const sessionCount = countFilesRecursive(sessionsDir, (full) =>
        /\.(jsonl|json|sqlite|db)$/i.test(full),
      )
      results.push({
        name,
        path: profilePath,
        active: name === activeProfile,
        exists: true,
        model: typeof config.model === 'string' ? config.model : undefined,
        provider:
          typeof config.provider === 'string' ? config.provider : undefined,
        skillCount,
        sessionCount,
        hasEnv: fs.existsSync(envPath),
        updatedAt: latestMtime([
          profilePath,
          configPath,
          envPath,
          skillsDir,
          sessionsDir,
        ]),
      })
    }
  }

  const seen = new Set(results.map((profile) => profile.name.toLowerCase()))
  for (const instanceProfile of listInstanceProfiles()) {
    if (seen.has(instanceProfile.name.toLowerCase())) continue
    results.push({
      ...instanceProfile,
      active:
        instanceProfile.name === activeProfile ||
        instanceProfile.instanceName === activeProfile,
    })
  }

  results.sort((a, b) => {
    if (a.active && !b.active) return -1
    if (!a.active && b.active) return 1
    return Date.parse(b.updatedAt || '') - Date.parse(a.updatedAt || '')
  })
  return results
}

export function readProfile(name: string): ProfileDetail {
  const active = getActiveProfileName()
  const normalized = name.trim() || active
  const profilePath = path.join(
    getProfilesRoot(),
    validateProfileName(normalized),
  )
  const instanceProfile = findInstanceProfile(normalized)
  if (!fs.existsSync(profilePath) && !instanceProfile) {
    throw new Error('Profile not found')
  }
  if (instanceProfile && !fs.existsSync(profilePath)) {
    return {
      name: instanceProfile.name,
      path: instanceProfile.path,
      active:
        instanceProfile.name === active ||
        instanceProfile.instanceName === active,
      config: instanceProfile.config,
      envPath: instanceProfile.envPath,
      hasEnv: instanceProfile.hasEnv,
      sessionsDir: instanceProfile.sessionsDir,
      skillsDir: instanceProfile.skillsDir,
    }
  }
  const configPath = path.join(profilePath, 'config.yaml')
  const envPath = path.join(profilePath, '.env')
  const sessionsDir = path.join(profilePath, 'sessions')
  const skillsDir = path.join(profilePath, 'skills')
  return {
    name: normalized,
    path: profilePath,
    active: normalized === active,
    config: readYamlConfig(configPath),
    envPath: fs.existsSync(envPath) ? envPath : undefined,
    hasEnv: fs.existsSync(envPath),
    sessionsDir: fs.existsSync(sessionsDir) ? sessionsDir : undefined,
    skillsDir: fs.existsSync(skillsDir) ? skillsDir : undefined,
  }
}

export function setActiveProfile(name: string): void {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('Profile name is required')
  const normalized = validateProfileName(trimmed)
  const profilePath = path.join(getProfilesRoot(), normalized)
  if (!fs.existsSync(profilePath) && !findInstanceProfile(normalized)) {
    throw new Error('Profile not found')
  }
  fs.mkdirSync(getNyxHiveRoot(), { recursive: true })
  fs.writeFileSync(getActiveProfilePath(), `${normalized}\n`, 'utf-8')
}

export function createProfile(
  name: string,
  options?: { cloneFrom?: string; model?: string; provider?: string },
): ProfileDetail {
  const normalized = validateProfileName(name)
  const profilePath = path.join(getProfilesRoot(), normalized)
  if (fs.existsSync(profilePath)) throw new Error('Profile already exists')
  fs.mkdirSync(profilePath, { recursive: true })

  const configPath = path.join(profilePath, 'config.yaml')

  // Clone config from source profile if specified
  if (options?.cloneFrom) {
    const sourceName = options.cloneFrom.trim()
    const sourcePath = path.join(
      getProfilesRoot(),
      validateProfileName(sourceName),
      'config.yaml',
    )
    const sourceInstance = findInstanceProfile(sourceName)
    if (fs.existsSync(sourcePath)) {
      fs.copyFileSync(sourcePath, configPath)
    } else if (sourceInstance) {
      fs.writeFileSync(
        configPath,
        YAML.stringify(sourceInstance.config),
        'utf-8',
      )
    } else {
      fs.writeFileSync(
        configPath,
        YAML.stringify({ model: '', provider: '' }),
        'utf-8',
      )
    }
  } else {
    fs.writeFileSync(
      configPath,
      YAML.stringify({ model: '', provider: '' }),
      'utf-8',
    )
  }

  // Override model/provider if specified
  if (options?.model || options?.provider) {
    const config = readYamlConfig(configPath)
    if (options.model) config.model = options.model
    if (options.provider) config.provider = options.provider
    fs.writeFileSync(configPath, YAML.stringify(config), 'utf-8')
  }

  // Create subdirectories
  fs.mkdirSync(path.join(profilePath, 'skills'), { recursive: true })
  fs.mkdirSync(path.join(profilePath, 'sessions'), { recursive: true })

  return readProfile(normalized)
}

export function deleteProfile(name: string): void {
  const normalized = validateProfileName(name)
  if (findInstanceProfile(normalized)) {
    throw new Error('Instance profiles cannot be deleted here')
  }
  if (normalized === getActiveProfileName())
    throw new Error('Cannot delete the active profile')
  const profilePath = path.join(getProfilesRoot(), normalized)
  if (!fs.existsSync(profilePath)) throw new Error('Profile not found')
  const trashDir = path.join(getNyxHiveRoot(), 'trash')
  fs.mkdirSync(trashDir, { recursive: true })
  const trashName = `${normalized}-${Date.now()}`
  fs.renameSync(profilePath, path.join(trashDir, trashName))
}

export function renameProfile(oldName: string, newName: string): ProfileDetail {
  const from = validateProfileName(oldName)
  const to = validateProfileName(newName)
  if (findInstanceProfile(from)) {
    throw new Error('Instance profiles cannot be renamed here')
  }
  const fromPath = path.join(getProfilesRoot(), from)
  const toPath = path.join(getProfilesRoot(), to)
  if (!fs.existsSync(fromPath)) throw new Error('Profile not found')
  if (fs.existsSync(toPath)) throw new Error('Target profile already exists')
  fs.renameSync(fromPath, toPath)
  if (getActiveProfileName() === from) {
    fs.writeFileSync(getActiveProfilePath(), `${to}\n`, 'utf-8')
  }
  return readProfile(to)
}

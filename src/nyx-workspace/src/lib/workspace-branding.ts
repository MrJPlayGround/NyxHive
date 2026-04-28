const DEFAULT_WORKSPACE_AGENT_NAME = 'Nyx'

type WorkspaceBrandingSource = {
  agentName?: string | null
  displayName?: string | null
  apiUrl?: string | null
}

type WorkspaceBranding = {
  agentName: string
  displayName: string
  apiUrl: string
}

declare global {
  var __NYX_WORKSPACE_BRANDING__: WorkspaceBrandingSource | undefined
}

export function normalizeWorkspaceAgentName(value?: string | null): string {
  const trimmed = value?.trim()
  return trimmed || DEFAULT_WORKSPACE_AGENT_NAME
}

export function normalizeWorkspaceDisplayName(
  value?: string | null,
  agentName = DEFAULT_WORKSPACE_AGENT_NAME,
): string {
  const trimmed = value?.trim()
  return trimmed || `${normalizeWorkspaceAgentName(agentName)} Workspace`
}

function readRuntimeWorkspaceBranding(): WorkspaceBrandingSource | null {
  const runtime = globalThis.__NYX_WORKSPACE_BRANDING__
  if (!runtime || typeof runtime !== 'object') return null
  return runtime
}

export function resolveWorkspaceBranding(input?: {
  runtime?: WorkspaceBrandingSource | null
  env?: Record<string, string | undefined>
}): WorkspaceBranding {
  const runtime = input?.runtime ?? readRuntimeWorkspaceBranding()
  const env = input?.env ?? process.env
  const agentName = normalizeWorkspaceAgentName(
    runtime?.agentName ?? env.NYX_WORKSPACE_AGENT_NAME,
  )

  return {
    agentName,
    displayName: normalizeWorkspaceDisplayName(
      runtime?.displayName ?? env.NYX_WORKSPACE_NAME,
      agentName,
    ),
    apiUrl: (
      runtime?.apiUrl ??
      env.NYX_WORKSPACE_API_URL ??
      env.NYX_API_URL ??
      ''
    ).trim(),
  }
}

export function buildWorkspaceBrandingBootstrapScript(
  input?: WorkspaceBrandingSource,
): string {
  const branding = resolveWorkspaceBranding({ runtime: input })
  return `window.__NYX_WORKSPACE_BRANDING__ = ${JSON.stringify(branding)};`
}

const WORKSPACE_BRANDING = resolveWorkspaceBranding()

export const WORKSPACE_AGENT_NAME = WORKSPACE_BRANDING.agentName

export const WORKSPACE_API_URL = WORKSPACE_BRANDING.apiUrl

export const WORKSPACE_DISPLAY_NAME = WORKSPACE_BRANDING.displayName

function portFromUrl(value?: string | null): string {
  if (!value) return ''
  try {
    return new URL(value).port
  } catch {
    return ''
  }
}

export function formatWorkspaceRuntimeStatus(input?: {
  agentName?: string | null
  appPort?: string | number | null
  apiUrl?: string | null
}): string {
  const agentName = normalizeWorkspaceAgentName(
    input?.agentName ?? WORKSPACE_AGENT_NAME,
  )
  const appPort = input?.appPort ? String(input.appPort) : ''
  const backendPort = portFromUrl(input?.apiUrl ?? WORKSPACE_API_URL)
  return [
    agentName,
    appPort ? `app :${appPort}` : '',
    backendPort ? `backend :${backendPort}` : '',
  ]
    .filter(Boolean)
    .join(' · ')
}

export type WorkspaceManifest = {
  name: string
  short_name: string
  description: string
  start_url: string
  display: 'standalone'
  background_color: string
  theme_color: string
  categories: Array<string>
  icons: Array<{
    src: string
    sizes: string
    type: string
    purpose: string
  }>
}

export function buildWorkspaceManifest(input?: {
  agentName?: string | null
  displayName?: string | null
}): WorkspaceManifest {
  const agentName = normalizeWorkspaceAgentName(
    input?.agentName ?? WORKSPACE_AGENT_NAME,
  )
  const displayName = normalizeWorkspaceDisplayName(
    input?.displayName ?? WORKSPACE_DISPLAY_NAME,
    agentName,
  )

  return {
    name: displayName,
    short_name: agentName,
    description: `Native web control surface for ${agentName}, powered by NyxHive`,
    start_url: '/',
    display: 'standalone',
    background_color: '#0A0E1A',
    theme_color: '#6366F1',
    categories: ['productivity', 'utilities'],
    icons: [
      {
        src: '/api/manifest-icon/svg',
        sizes: 'any',
        type: 'image/svg+xml',
        purpose: 'any maskable',
      },
      {
        src: '/nyx-icon-192.png',
        sizes: '192x192',
        type: 'image/png',
        purpose: 'any maskable',
      },
      {
        src: '/nyx-icon-512.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'any maskable',
      },
    ],
  }
}

import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildWorkspaceBrandingBootstrapScript,
  buildWorkspaceManifest,
  formatWorkspaceRuntimeStatus,
  normalizeWorkspaceAgentName,
  normalizeWorkspaceDisplayName,
  resolveWorkspaceBranding,
} from './workspace-branding'

const root = process.cwd()

function source(path: string): string {
  return readFileSync(join(root, path), 'utf8')
}

describe('workspace branding', () => {
  test('derives workspace display names from the active agent when no explicit name is set', () => {
    expect(normalizeWorkspaceAgentName(' Vortex ')).toBe('Vortex')
    expect(normalizeWorkspaceAgentName('')).toBe('Nyx')
    expect(normalizeWorkspaceDisplayName(null, 'Vortex')).toBe(
      'Vortex Workspace',
    )
    expect(normalizeWorkspaceDisplayName('NyxLabs Workspace', 'Vortex')).toBe(
      'NyxLabs Workspace',
    )
  })

  test('builds install manifest identity from workspace branding', () => {
    const manifest = buildWorkspaceManifest({
      agentName: 'Vortex',
      displayName: 'Vortex Workspace',
    })

    expect(manifest.name).toBe('Vortex Workspace')
    expect(manifest.short_name).toBe('Vortex')
    expect(manifest.description).toContain('NyxHive')
    expect(manifest.icons[0]?.src).toBe('/api/manifest-icon/svg')
  })

  test('formats compact runtime status from agent, app, and backend ports', () => {
    expect(
      formatWorkspaceRuntimeStatus({
        agentName: 'Vortex',
        appPort: '3781',
        apiUrl: 'http://127.0.0.1:3778',
      }),
    ).toBe('Vortex · app :3781 · backend :3778')
  })

  test('prefers runtime branding over build-time env fallbacks', () => {
    expect(
      resolveWorkspaceBranding({
        runtime: {
          agentName: 'Nyx',
          displayName: 'Nyx Workspace',
          apiUrl: 'http://127.0.0.1:3779',
        },
        env: {
          NYX_WORKSPACE_AGENT_NAME: 'Vortex',
          NYX_WORKSPACE_NAME: 'Vortex Workspace',
          NYX_WORKSPACE_API_URL: 'http://127.0.0.1:3778',
        },
      }),
    ).toEqual({
      agentName: 'Nyx',
      displayName: 'Nyx Workspace',
      apiUrl: 'http://127.0.0.1:3779',
    })
  })

  test('serializes runtime branding for hydration before the client bundle boots', () => {
    const script = buildWorkspaceBrandingBootstrapScript({
      agentName: 'Nyx',
      displayName: 'Nyx Workspace',
      apiUrl: 'http://127.0.0.1:3779',
    })

    expect(script).toContain('__NYX_WORKSPACE_BRANDING__')
    expect(script).toContain('"agentName":"Nyx"')
    expect(script).toContain('"displayName":"Nyx Workspace"')
  })

  test('workspace chrome uses the shared display name', () => {
    expect(source('src/nyx-workspace/src/hooks/use-page-title.ts')).toContain(
      'WORKSPACE_DISPLAY_NAME',
    )
    expect(source('src/nyx-workspace/src/routes/__root.tsx')).toContain(
      'WORKSPACE_DISPLAY_NAME',
    )
    expect(source('src/nyx-workspace/src/routes/__root.tsx')).toContain(
      'buildWorkspaceBrandingBootstrapScript',
    )
    expect(source('src/nyx-workspace/src/routes/__root.tsx')).toContain(
      '/api/manifest',
    )
    expect(source('src/nyx-workspace/src/routes/__root.tsx')).toContain(
      '/nyx-wordmark.svg',
    )
    expect(source('src/nyx-workspace/src/routes/__root.tsx')).not.toContain(
      '/nyx-banner.png',
    )
    expect(source('src/nyx-workspace/src/components/workspace-shell.tsx')).toContain(
      'WORKSPACE_DISPLAY_NAME',
    )
    expect(
      source('src/nyx-workspace/src/screens/chat/components/chat-sidebar.tsx'),
    ).toContain('WORKSPACE_DISPLAY_NAME')
    expect(
      source('src/nyx-workspace/src/screens/chat/components/chat-sidebar.tsx'),
    ).toContain('workspace-runtime-status')
    expect(
      source('src/nyx-workspace/src/screens/chat/components/chat-sidebar.tsx'),
    ).not.toContain('data-tour="vortex-workspace-switch"')
    expect(
      source('src/nyx-workspace/src/screens/chat/components/chat-sidebar.tsx'),
    ).not.toContain('Vortex Workspace')
  })

  test('core chat status copy uses the shared agent name', () => {
    for (const path of [
      'src/nyx-workspace/src/screens/chat/components/chat-message-list.tsx',
      'src/nyx-workspace/src/screens/chat/components/stream-activity.ts',
      'src/nyx-workspace/src/screens/chat/hooks/use-chat-sessions.ts',
    ]) {
      expect(source(path)).toContain('WORKSPACE_AGENT_NAME')
    }
    expect(
      source('src/nyx-workspace/src/screens/chat/components/message-item.tsx'),
    ).toContain('deriveStreamingActivityState')
  })
})

import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import {
  buildWorkspaceStartCommand,
  listWorkspaceProfiles,
  resolveWorkspaceProfile,
} from './workspace-profiles'

const home = process.env.HOME ?? '/home/user'

describe('workspace profiles', () => {
  test('resolves NyxAI and Vortex aliases', () => {
    expect(resolveWorkspaceProfile('nyx').id).toBe('nyxai')
    expect(resolveWorkspaceProfile('nyxlabs').id).toBe('vortex')
    expect(resolveWorkspaceProfile('labs').id).toBe('vortex')
  })

  test('builds the Nyx workspace launch command on the public workspace port', () => {
    const profile = resolveWorkspaceProfile('nyx')
    const command = buildWorkspaceStartCommand(profile, '/repo')

    expect(command).toContain("NYX_WORKSPACE_AGENT_NAME='Nyx'")
    expect(command).toContain("NYX_WORKSPACE_INSTANCE='nyxai'")
    expect(command).toContain("NYX_WORKSPACE_NAME='Nyx Workspace'")
    expect(command).toContain("NYX_WORKSPACE_HOST='127.0.0.1'")
    expect(command).toContain("NYX_WORKSPACE_API_URL='http://127.0.0.1:3779'")
    expect(command).toContain("NYX_WORKSPACE_MEMORY_NAMESPACE='NyxAI'")
    expect(command).toContain(
      "NYX_WORKSPACE_MEMORY_EXCLUDE_PREFIXES='Projects/Trading-Journal/'",
    )
    expect(command).toContain('NYX_WORKSPACE_API_KEY="$NYXHIVE_API_KEY"')
    expect(command).toContain('NYX_WORKSPACE_PORT=3777')
    expect(command).toContain('bun --cwd src/nyx-workspace build')
    expect(command).toContain('PORT=3777')
    expect(command).toContain("HOST='127.0.0.1'")
    expect(command).toContain('bun --cwd src/nyx-workspace start')
    expect(command).not.toContain('bun --cwd src/nyx-workspace dev')
  })

  test('builds a Vortex workspace launch command behind Tailscale Serve', () => {
    const profile = resolveWorkspaceProfile('vortex')
    const command = buildWorkspaceStartCommand(profile, '/repo')

    expect(command).toContain("NYX_WORKSPACE_AGENT_NAME='Vortex'")
    expect(command).toContain("NYX_WORKSPACE_INSTANCE='nyxlabs'")
    expect(command).toContain("NYX_WORKSPACE_NAME='Vortex Workspace'")
    expect(command).toContain("NYX_WORKSPACE_HOST='127.0.0.1'")
    expect(command).toContain("NYX_WORKSPACE_API_URL='http://127.0.0.1:3778'")
    expect(command).toContain("NYX_WORKSPACE_MEMORY_NAMESPACE='NyxLabs'")
    expect(command).toContain(
      `NYX_WORKSPACE_HOME='${home}/.nyxhive/instances/NyxLabs'`,
    )
    expect(command).toContain(
      `NYX_WORKSPACE_VAULT_ROOT='${home}/dev/obsidian/NyxLabs'`,
    )
    expect(command).toContain(
      `KNOWLEDGE_DIR='${home}/dev/obsidian/NyxLabs'`,
    )
    expect(command).toContain('NYX_WORKSPACE_API_KEY="$NYXLABS_REMOTE_API_KEY"')
    expect(command).toContain('NYX_WORKSPACE_PORT=3781')
    expect(command).toContain('bun --cwd src/nyx-workspace build')
    expect(command).toContain('PORT=3781')
    expect(command).toContain("HOST='127.0.0.1'")
    expect(command).toContain('bun --cwd src/nyx-workspace start')
    expect(command).not.toContain('bun --cwd src/nyx-workspace dev')
  })

  test('maps registered agent manifests into workspace profiles', () => {
    const astra = mkdtempSync(join(tmpdir(), 'astra-workspace-profile-'))
    mkdirSync(join(astra, '.nyxhive'), { recursive: true })
    writeFileSync(join(astra, '.nyxhive', 'workspace.toml'), `
id = "astra-trading"
kind = "agent"
display_name = "Astra Trading"

[engine]
source = "local-git"
path = "/engine"
ref = "master"
constraint = ">=0.1 <0.2"

[runtime]
instance_id = "astra-trading"
data_namespace = "astra-trading"
config = ".nyxhive/config.toml"
api_url = "http://127.0.0.1:3782"
app_port = 3783
app_host = "127.0.0.1"
api_key_env = "ASTRA_TRADING_API_KEY"
agent_name = "Astra"
tmux_session = "astra-trading-workspace"
vault_root = "/vault/Astra"
agents = ["astra"]
`)

    const profiles = listWorkspaceProfiles({ roots: [astra], includeFallbacks: false })

    expect(profiles).toHaveLength(1)
    expect(profiles[0]).toMatchObject({
      id: 'astra-trading',
      displayName: 'Astra Trading',
      backendInstance: 'astra-trading',
      agentName: 'Astra',
      apiUrl: 'http://127.0.0.1:3782',
      appPort: 3783,
      tmuxSession: 'astra-trading-workspace',
      workspaceHome: join(astra, '.nyxhive'),
      memoryNamespace: 'astra-trading',
      vaultRoot: '/vault/Astra',
    })

    const command = buildWorkspaceStartCommand(profiles[0], '/repo')
    expect(command).toContain("NYX_WORKSPACE_INSTANCE='astra-trading'")
  })
})

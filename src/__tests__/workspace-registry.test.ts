import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { discoverWorkspaceManifests } from '../workspaces/registry.js'
import { loadWorkspaceRegistry, saveWorkspaceRegistry } from '../workspaces/registry-store.js'

function writeManifest(root: string, body: string): void {
  mkdirSync(join(root, '.nyxhive'), { recursive: true })
  writeFileSync(join(root, '.nyxhive', 'workspace.toml'), body)
}

describe('workspace registry', () => {
  test('discovers valid workspace manifests from registered roots', () => {
    const astra = mkdtempSync(join(tmpdir(), 'astra-workspace-'))
    const deft = mkdtempSync(join(tmpdir(), 'deft-workspace-'))
    const empty = mkdtempSync(join(tmpdir(), 'empty-workspace-'))

    writeManifest(astra, `
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
api_url = "http://127.0.0.1:3782"
app_port = 3783
agents = ["astra"]
`)

    writeManifest(deft, `
id = "deft-voice"
kind = "product"
display_name = "Deft Voice"

[engine]
source = "local-git"
path = "/engine"
ref = "master"
constraint = ">=0.1 <0.2"
`)

    const manifests = discoverWorkspaceManifests([astra, deft, empty])

    expect(manifests.map((entry) => entry.manifest.id)).toEqual([
      'astra-trading',
      'deft-voice',
    ])
    expect(manifests[0].root).toBe(astra)
  })

  test('loads workspace roots from a registry file', () => {
    const registryRoot = mkdtempSync(join(tmpdir(), 'nyxhive-registry-'))
    const registryFile = join(registryRoot, 'workspaces.toml')
    const astra = mkdtempSync(join(tmpdir(), 'astra-workspace-'))

    saveWorkspaceRegistry(registryFile, {
      workspaces: [{ id: 'astra-trading', path: astra }],
    })

    const registry = loadWorkspaceRegistry(registryFile)

    expect(registry.workspaces).toEqual([{ id: 'astra-trading', path: astra }])
  })
})

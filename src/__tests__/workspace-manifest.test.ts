import { mkdirSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, test } from 'bun:test'
import { loadWorkspaceManifest } from '../workspaces/manifest.js'

function tempWorkspace(): string {
  return mkdtempSync(join(tmpdir(), 'nyxhive-workspace-manifest-'))
}

describe('workspace manifest', () => {
  test('loads an isolated agent instance manifest', () => {
    const root = tempWorkspace()
    mkdirSync(join(root, '.nyxhive'), { recursive: true })
    writeFileSync(join(root, '.nyxhive', 'workspace.toml'), `
id = "astra-trading"
kind = "agent"
display_name = "Astra Trading"

[engine]
source = "local-git"
path = "/home/user/dev/nyxhive"
ref = "master"
constraint = ">=0.1 <0.2"

[runtime]
instance_id = "astra-trading"
data_namespace = "astra-trading"
config = ".nyxhive/config.toml"
api_url = "http://127.0.0.1:3782"
app_port = 3783
agents = ["astra"]
`)

    const manifest = loadWorkspaceManifest(root)

    expect(manifest.id).toBe('astra-trading')
    expect(manifest.kind).toBe('agent')
    expect(manifest.engine.source).toBe('local-git')
    expect(manifest.runtime?.instance_id).toBe('astra-trading')
    expect(manifest.runtime?.data_namespace).toBe('astra-trading')
    expect(manifest.runtime?.agents).toEqual(['astra'])
  })

  test('loads a product manifest without runtime config', () => {
    const root = tempWorkspace()
    mkdirSync(join(root, '.nyxhive'), { recursive: true })
    writeFileSync(join(root, '.nyxhive', 'workspace.toml'), `
id = "deft-voice"
kind = "product"
display_name = "Deft Voice"

[engine]
source = "local-git"
path = "/home/user/dev/nyxhive"
ref = "master"
constraint = ">=0.1 <0.2"
`)

    const manifest = loadWorkspaceManifest(root)

    expect(manifest.kind).toBe('product')
    expect(manifest.runtime).toBeUndefined()
  })

  test('rejects agent manifests without isolated instance identity', () => {
    const root = tempWorkspace()
    mkdirSync(join(root, '.nyxhive'), { recursive: true })
    writeFileSync(join(root, '.nyxhive', 'workspace.toml'), `
id = "astra-trading"
kind = "agent"
display_name = "Astra Trading"

[engine]
source = "local-git"
path = "/home/user/dev/nyxhive"
ref = "master"
constraint = ">=0.1 <0.2"

[runtime]
config = ".nyxhive/config.toml"
api_url = "http://127.0.0.1:3782"
agents = ["astra"]
`)

    expect(() => loadWorkspaceManifest(root)).toThrow(
      'Agent instances must declare runtime.instance_id and runtime.data_namespace',
    )
  })

  test('rejects product manifests that declare runtime agents', () => {
    const root = tempWorkspace()
    mkdirSync(join(root, '.nyxhive'), { recursive: true })
    writeFileSync(join(root, '.nyxhive', 'workspace.toml'), `
id = "deft-voice"
kind = "product"
display_name = "Deft Voice"

[engine]
source = "local-git"
path = "/home/user/dev/nyxhive"
ref = "master"
constraint = ">=0.1 <0.2"

[runtime]
agents = ["deft"]
`)

    expect(() => loadWorkspaceManifest(root)).toThrow(
      'Product workspaces cannot declare runtime agents',
    )
  })
})

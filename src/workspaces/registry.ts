import { existsSync } from 'node:fs'
import {
  loadWorkspaceManifest,
  workspaceManifestPath,
  type WorkspaceManifest,
} from './manifest.js'
import { loadWorkspaceRegistry } from './registry-store.js'

export interface RegisteredWorkspaceManifest {
  root: string
  manifest: WorkspaceManifest
}

export function discoverWorkspaceManifests(
  roots: string[],
): RegisteredWorkspaceManifest[] {
  const manifests: RegisteredWorkspaceManifest[] = []
  const seen = new Set<string>()

  for (const root of roots) {
    if (seen.has(root)) continue
    seen.add(root)
    if (!existsSync(workspaceManifestPath(root))) continue
    manifests.push({ root, manifest: loadWorkspaceManifest(root) })
  }

  return manifests
}

export function discoverRegisteredWorkspaceManifests(
  registryPath?: string,
): RegisteredWorkspaceManifest[] {
  return discoverWorkspaceManifests(
    loadWorkspaceRegistry(registryPath).workspaces.map((workspace) => workspace.path),
  )
}

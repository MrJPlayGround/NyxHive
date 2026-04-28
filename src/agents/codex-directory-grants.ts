import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { loadWorkspaceRegistry } from "../workspaces/registry-store.js";

export interface CodexWritableDirectoryGrantInput {
  baseDir: string;
  configuredDirectories?: string[];
  registryPath?: string;
  nyxhiveStateDir?: string;
}

function pushUnique(paths: string[], seen: Set<string>, path: string): void {
  const resolved = resolve(path);
  if (seen.has(resolved)) return;
  seen.add(resolved);
  paths.push(resolved);
}

export function resolveCodexWritableDirectoryGrants(
  input: CodexWritableDirectoryGrantInput,
): string[] {
  const seen = new Set<string>();
  const grants: string[] = [];

  for (const directory of input.configuredDirectories ?? []) {
    pushUnique(grants, seen, resolve(input.baseDir, directory));
  }

  pushUnique(grants, seen, input.nyxhiveStateDir ?? join(homedir(), ".nyxhive"));

  let registry;
  try {
    registry = loadWorkspaceRegistry(input.registryPath);
  } catch {
    registry = { workspaces: [] };
  }

  for (const workspace of registry.workspaces) {
    pushUnique(grants, seen, resolve(input.baseDir, workspace.path));
  }

  return grants;
}

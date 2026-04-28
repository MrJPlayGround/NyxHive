import { join } from "node:path";

const home = process.env.HOME ?? "/home/user";

export const OBSIDIAN_ROOT = process.env.NYXHIVE_OBSIDIAN_ROOT ?? join(home, "dev", "obsidian");

const PUBLIC_OBSIDIAN_ROOT = "/home/user/dev/obsidian";

const LEGACY_OBSIDIAN_ROOTS = [
  { root: "/Volumes/ExampleDrive/Obsidian", target: PUBLIC_OBSIDIAN_ROOT },
  { root: "/home/user/Obsidian", target: PUBLIC_OBSIDIAN_ROOT },
  { root: join(home, "Obsidian"), target: OBSIDIAN_ROOT },
];

export function normalizeObsidianPath(pathValue?: string): string | undefined {
  if (!pathValue) return pathValue;

  for (const { root, target } of LEGACY_OBSIDIAN_ROOTS) {
    if (pathValue === root) return target;
    if (pathValue.startsWith(`${root}/`)) {
      return join(target, pathValue.slice(root.length + 1));
    }
  }

  return pathValue;
}

export function normalizeObsidianPaths(pathValues?: string[]): string[] | undefined {
  return pathValues?.map((value) => normalizeObsidianPath(value) ?? value);
}

export function sanitizeVaultFolderName(instanceName: string): string {
  const normalized = instanceName
    .trim()
    .replace(/[\\/]+/g, "-")
    .replace(/\s+/g, " ");

  return normalized || "NyxHive";
}

export function defaultVaultPathForInstance(instanceName: string): string {
  return join(OBSIDIAN_ROOT, sanitizeVaultFolderName(instanceName));
}

export function resolveInstanceVaultPath(instanceName: string, configuredPath?: string): string {
  return normalizeObsidianPath(configuredPath) ?? defaultVaultPathForInstance(instanceName);
}

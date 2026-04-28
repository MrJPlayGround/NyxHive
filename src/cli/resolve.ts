import { existsSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import TOML from "@iarna/toml";
import { loadBookmarks } from "./instance-registry.js";
import { logger } from "../utils/logger.js";

const DEFAULT_INSTANCES_DIR = join(
  process.env.HOME ?? "/root",
  ".nyxhive",
  "instances",
);

export interface ResolvedInstance {
  configPath: string;
  instanceDir: string;
}

/**
 * Resolve an instance to its config path and instance directory.
 *
 * Resolution order:
 * 1. Explicit configPath (--config flag) — always wins
 * 2. nameOrPath matches a bookmark
 * 2b. Legacy: ~/.nyxhive/instances/<Name>/config.toml (backwards compat)
 * 2c. nameOrPath is a directory containing config.toml
 * 3. CWD: config.toml (new flat layout)
 * 4. CWD: config/nyxhive.toml (legacy)
 */
export function resolveInstance(
  nameOrPath?: string,
  instancesDir = DEFAULT_INSTANCES_DIR,
  configPath?: string,
): ResolvedInstance {
  // 1. Explicit --config flag
  if (configPath) {
    const abs = resolve(configPath);
    if (!existsSync(abs)) {
      throw new Error(`Config file not found: ${abs}`);
    }
    return { configPath: abs, instanceDir: dirname(abs) };
  }

  // 2. Named instance -> check bookmarks first
  if (nameOrPath) {
    const { bookmarks } = loadBookmarks();
    const bookmark = bookmarks.find(b => b.name === nameOrPath);
    if (bookmark) {
      const cfgPath = join(bookmark.path, "config.toml");
      if (existsSync(cfgPath)) {
        return { configPath: cfgPath, instanceDir: bookmark.path };
      }
    }

    // 2b. Legacy: ~/.nyxhive/instances/<Name>/config.toml (backwards compat — deprecated)
    const legacyPath = join(instancesDir, nameOrPath, "config.toml");
    if (existsSync(legacyPath)) {
      logger.warn(`[config] Instance "${nameOrPath}" resolved from legacy path ~/.nyxhive/instances/${nameOrPath}/ — migrate config to workspace .nyxhive/ directory`);
      return { configPath: legacyPath, instanceDir: join(instancesDir, nameOrPath) };
    }

    // 2c. Direct directory path
    const dirPath = resolve(nameOrPath);
    const dirConfig = join(dirPath, "config.toml");
    if (existsSync(dirConfig)) {
      return { configPath: dirConfig, instanceDir: dirPath };
    }

    throw new Error(
      `Instance "${nameOrPath}" not found. Check bookmarks or provide a valid path.`,
    );
  }

  // 3. CWD: .nyxhive/config.toml (workspace-centric layout)
  const cwdNyxhive = resolve(process.cwd(), ".nyxhive", "config.toml");
  if (existsSync(cwdNyxhive)) {
    return { configPath: cwdNyxhive, instanceDir: resolve(process.cwd(), ".nyxhive") };
  }

  // 4. CWD: config.toml (new flat layout)
  const cwdFlat = resolve(process.cwd(), "config.toml");
  if (existsSync(cwdFlat)) {
    return { configPath: cwdFlat, instanceDir: resolve(process.cwd()) };
  }

  // 5. CWD: config/nyxhive.toml (legacy layout)
  const cwdLegacy = resolve(process.cwd(), "config", "nyxhive.toml");
  if (existsSync(cwdLegacy)) {
    return { configPath: cwdLegacy, instanceDir: resolve(process.cwd()) };
  }

  throw new Error(
    "No instance specified. Usage: nyxhive <command> <InstanceName> or nyxhive <command> --config <path>",
  );
}

/**
 * Load env vars from an instance's `env` file.
 * Does NOT override already-set vars. Returns number of vars loaded.
 */
export function loadInstanceEnv(instanceDir: string): number {
  let loaded = 0;
  const paths = [join(instanceDir, ".env"), join(instanceDir, "env")].filter(existsSync);
  if (paths.length === 0) return 0;

  for (const envPath of paths) {
    const content = readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;

      const key = trimmed.slice(0, eqIdx).trim();
      let value = trimmed.slice(eqIdx + 1).trim();
      // Strip surrounding quotes (single or double)
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }

      if (!key) continue;

      // Don't override existing env vars or keys loaded from higher-precedence files.
      if (process.env[key] !== undefined && process.env[key] !== "") {
        continue;
      }

      process.env[key] = value;
      loaded++;
    }
  }

  return loaded;
}

export interface InstanceInfo {
  name: string;
  configPath: string;
  instanceDir: string;
  port: number;
  dataDir: string;
}

/**
 * List all bookmarked instances.
 */
export function listInstances(bookmarksPath?: string): InstanceInfo[] {
  const { bookmarks } = loadBookmarks(bookmarksPath);
  const instances: InstanceInfo[] = [];

  for (const bm of bookmarks) {
    const cfgPath = join(bm.path, "config.toml");
    if (!existsSync(cfgPath)) continue;
    try {
      const raw = readFileSync(cfgPath, "utf-8");
      const parsed = JSON.parse(JSON.stringify(TOML.parse(raw)));
      const configuredDataDir = parsed.daemon?.data_dir as string | undefined;
      instances.push({
        name: parsed.daemon?.name ?? bm.name,
        configPath: cfgPath,
        instanceDir: bm.path,
        port: parsed.server?.port ?? bm.port ?? 0,
        dataDir: configuredDataDir ? resolve(bm.path, configuredDataDir) : join(bm.path, "data"),
      });
    } catch { }
  }

  return instances;
}

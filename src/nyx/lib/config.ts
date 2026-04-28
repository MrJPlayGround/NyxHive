/**
 * Load NyxHive instance configs.
 *
 * Priority:
 * 1. ~/.config/nyx/config.toml  — remote mode (connecting to a headless machine)
 * 2. ~/.nyxhive/instances/      — local mode  (running on the NyxHive machine)
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { existsSync } from "node:fs";
import TOML from "@iarna/toml";
import { homedir } from "node:os";

export interface InstanceConfig {
  name: string;
  port: number;
  apiKey: string;
  /** Full base URL, e.g. "http://100.109.215.36:3777". When set, api.ts uses this directly. */
  host?: string;
  /** True when loaded from ~/.config/nyx/config.toml (remote machine). */
  isRemote?: boolean;
}

const REMOTE_CONFIG_PATH = join(homedir(), ".config", "nyx", "config.toml");
const INSTANCES_DIR = join(homedir(), ".nyxhive", "instances");
const LEGACY_CONTROL_PLANE_NAMES = new Set(["onyx", "strider", "onxy"]);

function normalizeInstanceName(value: string): string {
  return value.trim().toLowerCase();
}

export function pickDefaultInstance(
  instances: InstanceConfig[],
  gateway?: InstanceConfig | null,
): InstanceConfig | null {
  const preferred = instances.find((instance) => {
    const name = normalizeInstanceName(instance.name);
    return name === "nyxai" || name === "nyx";
  });
  if (preferred) return preferred;

  const firstDirect = instances.find((instance) => {
    const name = normalizeInstanceName(instance.name);
    return name !== "gateway" && !LEGACY_CONTROL_PLANE_NAMES.has(name);
  });
  if (firstDirect) return firstDirect;

  return gateway ?? instances[0] ?? null;
}

/** Primary direct-owner instance names shown by default in the cockpit. */
export const PRIMARY_OWNER_NAMES = ["nyxai", "nyx", "nyxlabs", "aether"];

/** Instance names hidden in the cockpit unless --all is passed. */
export const HIDDEN_OWNER_NAMES = ["gateway", "onyx", "strider"];

// ─── Remote TOML config ──────────────────────────────────────────────────────

interface RemoteToml {
  gateway?: { host: string; api_key: string };
  instances?: Record<string, { host: string; api_key: string }>;
}

function portFromHost(host: string): number {
  try {
    return parseInt(new URL(host).port, 10) || 443;
  } catch {
    return 0;
  }
}

function nameFromSection(section: string): string {
  return section.toLowerCase();
}

async function loadRemoteInstances(): Promise<InstanceConfig[]> {
  const raw = await readFile(REMOTE_CONFIG_PATH, "utf-8");
  const parsed = TOML.parse(raw) as unknown as RemoteToml;

  const instances: InstanceConfig[] = [];

  if (parsed.instances) {
    for (const [section, cfg] of Object.entries(parsed.instances)) {
      instances.push({
        name: nameFromSection(section),
        host: cfg.host,
        port: portFromHost(cfg.host),
        apiKey: cfg.api_key ?? "",
        isRemote: true,
      });
    }
  }

  // If no [instances.*] entries but we have a [gateway], expose it as a single entry
  if (instances.length === 0 && parsed.gateway) {
    instances.push({
      name: "gateway",
      host: parsed.gateway.host,
      port: portFromHost(parsed.gateway.host),
      apiKey: parsed.gateway.api_key ?? "",
      isRemote: true,
    });
  }

  return instances;
}

/** Parse the gateway block from the remote TOML, if present. */
export async function loadGatewayConfig(): Promise<InstanceConfig | null> {
  if (!existsSync(REMOTE_CONFIG_PATH)) return null;
  try {
    const raw = await readFile(REMOTE_CONFIG_PATH, "utf-8");
    const parsed = TOML.parse(raw) as unknown as RemoteToml;
    if (!parsed.gateway) return null;
    return {
      name: "gateway",
      host: parsed.gateway.host,
      port: portFromHost(parsed.gateway.host),
      apiKey: parsed.gateway.api_key ?? "",
      isRemote: true,
    };
  } catch {
    return null;
  }
}

// ─── Local discovery ──────────────────────────────────────────────────────────

async function loadLocalInstances(): Promise<InstanceConfig[]> {
  const entries = await readdir(INSTANCES_DIR, { withFileTypes: true });
  const instances: InstanceConfig[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith("_")) continue;
    const configPath = join(INSTANCES_DIR, entry.name, "config.toml");
    const instanceDir = join(INSTANCES_DIR, entry.name);
    try {
      const raw = await readFile(configPath, "utf-8");
      const parsed = TOML.parse(raw) as Record<string, any>;
      const port = parsed.server?.port;
      const apiKey = await resolveLocalServerApiKey(parsed.server, instanceDir);
      const name = parsed.daemon?.name ?? entry.name;
      if (typeof port !== "number") continue;
      instances.push({ name, port, apiKey });
    } catch {
      // Skip unreadable configs
    }
  }

  return instances.sort((a, b) => a.port - b.port);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function parseEnvLine(line: string): [string, string] | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;

  const eqIdx = trimmed.indexOf("=");
  if (eqIdx === -1) return null;

  const key = trimmed.slice(0, eqIdx).trim();
  let value = trimmed.slice(eqIdx + 1).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }

  return key ? [key, value] : null;
}

async function readInstanceEnvValue(instanceDir: string, key: string): Promise<string | undefined> {
  for (const envPath of [join(instanceDir, ".env"), join(instanceDir, "env")]) {
    if (!existsSync(envPath)) continue;
    const content = await readFile(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const parsed = parseEnvLine(line);
      if (parsed?.[0] === key && parsed[1]) return parsed[1];
    }
  }
  return undefined;
}

export async function resolveLocalServerApiKey(
  server: unknown,
  instanceDir: string,
  env: Record<string, string | undefined> = process.env,
): Promise<string> {
  const serverObj = server && typeof server === "object" && !Array.isArray(server)
    ? server as Record<string, unknown>
    : {};

  const direct = readString(serverObj.api_key)?.trim();
  if (direct) return direct;

  const envName = readString(serverObj.api_key_env)?.trim();
  if (!envName) return "";

  const processValue = env[envName]?.trim();
  if (processValue) return processValue;

  return (await readInstanceEnvValue(instanceDir, envName))?.trim() ?? "";
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function loadInstances(): Promise<InstanceConfig[]> {
  if (existsSync(REMOTE_CONFIG_PATH)) {
    try {
      return await loadRemoteInstances();
    } catch {
      // Fall through to local discovery
    }
  }
  return loadLocalInstances();
}

export async function getInstance(name: string): Promise<InstanceConfig | null> {
  const all = await loadInstances();
  return all.find((i) => i.name.toLowerCase() === name.toLowerCase()) ?? null;
}

export async function defaultInstance(): Promise<InstanceConfig | null> {
  if (existsSync(REMOTE_CONFIG_PATH)) {
    const all = await loadInstances();
    const gw = await loadGatewayConfig();
    return pickDefaultInstance(all, gw);
  }
  const all = await loadInstances();
  return pickDefaultInstance(all);
}

/** True when running against a remote machine (config from TOML). */
export function isRemoteMode(): boolean {
  return existsSync(REMOTE_CONFIG_PATH);
}

/** Path to the remote config file, for display. */
export const REMOTE_CONFIG_FILE = REMOTE_CONFIG_PATH;

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import TOML from "@iarna/toml";
import { resolveInstance } from "./resolve.js";
import { logger } from "../utils/logger.js";
import {
  getPresetCatalog,
  getPresetSoulDir,
  normalizePresetName,
} from "../presets.js";

export { getPresetCatalog } from "../presets.js";

const PRESET_STORE_DIR = "presets";
const ACTIVE_PRESET_FILE = "preset.json";
const EJECTED_PRESET_DIR = "custom";

interface PresetState {
  name: string;
  agent: string;
  applied_at: string;
  preset_dir: string;
}

function parseArgs(args: string[]): { positionals: string[]; flags: Record<string, string | true> } {
  const positionals: string[] = [];
  const flags: Record<string, string | true> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }

    const next = args[i + 1];
    if (next && !next.startsWith("--")) {
      flags[arg] = next;
      i++;
    } else {
      flags[arg] = true;
    }
  }

  return { positionals, flags };
}

function readConfigPrimaryAgent(configPath: string): { primaryAgent?: string; agentKeys: string[] } {
  const raw = readFileSync(configPath, "utf-8");
  const parsed = JSON.parse(JSON.stringify(TOML.parse(raw))) as {
    name?: string;
    port?: number;
    preset?: string;
    provider?: { name?: string };
    daemon?: { primary_agent?: string };
    agents?: Record<string, unknown>;
  };

  const agentKeys = Object.keys(parsed.agents ?? {});
  if (agentKeys.length === 0 && parsed.name && parsed.port && parsed.provider?.name) {
    return {
      primaryAgent: "assistant",
      agentKeys: ["assistant"],
    };
  }

  return {
    primaryAgent: parsed.daemon?.primary_agent,
    agentKeys,
  };
}

function resolveTargetAgent(
  configPath: string,
  explicitAgent?: string,
): string {
  const { primaryAgent, agentKeys } = readConfigPrimaryAgent(configPath);

  if (explicitAgent) {
    if (!agentKeys.includes(explicitAgent)) {
      throw new Error(`Agent "${explicitAgent}" not found in config`);
    }
    return explicitAgent;
  }

  if (primaryAgent) {
    if (!agentKeys.includes(primaryAgent)) {
      throw new Error(`daemon.primary_agent "${primaryAgent}" is not defined in agents`);
    }
    return primaryAgent;
  }

  if (agentKeys.length === 1) return agentKeys[0];
  if (agentKeys.length === 0) {
    throw new Error("No agents found in config.toml");
  }

  throw new Error("Multiple agents found. Re-run with --agent <key>.");
}

function ensureCleanDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
}

function copyPresetDirectory(sourceDir: string, targetDir: string): void {
  ensureCleanDir(targetDir);
  cpSync(sourceDir, targetDir, { recursive: true });
}

function presetStatePath(instanceDir: string): string {
  return join(instanceDir, "souls", ACTIVE_PRESET_FILE);
}

function readPresetState(instanceDir: string): PresetState | null {
  const file = presetStatePath(instanceDir);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf-8")) as PresetState;
}

function writePresetState(instanceDir: string, state: PresetState): void {
  writeFileSync(presetStatePath(instanceDir), `${JSON.stringify(state, null, 2)}\n`, "utf-8");
}

export function applyPresetToInstance(options: {
  presetName: string;
  instanceDir: string;
  agentKey: string;
}): PresetState {
  const sourceDir = getPresetSoulDir(options.presetName);
  const presetsDir = join(options.instanceDir, "souls", PRESET_STORE_DIR);
  const targetDir = join(presetsDir, options.presetName);
  mkdirSync(presetsDir, { recursive: true });
  copyPresetDirectory(sourceDir, targetDir);

  const state: PresetState = {
    name: options.presetName,
    agent: options.agentKey,
    applied_at: new Date().toISOString(),
    preset_dir: targetDir,
  };
  writePresetState(options.instanceDir, state);
  return state;
}

export function ejectPresetForInstance(options: {
  instanceDir: string;
  targetDirName?: string;
}): { sourceDir: string; targetDir: string; state: PresetState } {
  const state = readPresetState(options.instanceDir);
  if (!state) {
    throw new Error("No active preset found. Use `nyxhive preset apply <name>` first.");
  }

  const sourceDir = existsSync(state.preset_dir) ? state.preset_dir : getPresetSoulDir(state.name);
  const targetDir = join(options.instanceDir, "souls", options.targetDirName ?? EJECTED_PRESET_DIR);

  if (existsSync(targetDir) && readdirSync(targetDir).length > 0) {
    throw new Error(`Editable soul directory already exists: ${targetDir}`);
  }

  mkdirSync(targetDir, { recursive: true });
  cpSync(sourceDir, targetDir, { recursive: true });
  return { sourceDir, targetDir, state };
}

function listCmd(): void {
  const presets = getPresetCatalog();

  const nameWidth = Math.max(4, ...presets.map((preset) => preset.name.length)) + 2;
  const roleWidth = Math.max(4, ...presets.map((preset) => preset.role.length)) + 2;

  logger.info("\n  Available Soul Presets:\n");
  logger.info(`  ${"Name".padEnd(nameWidth)}${"Role".padEnd(roleWidth)}Description`);
  logger.info(`  ${"─".repeat(nameWidth + roleWidth + 48)}`);

  for (const preset of presets) {
    logger.info(`  ${preset.name.padEnd(nameWidth)}${preset.role.padEnd(roleWidth)}${preset.description}`);
  }

  logger.info("");
}

async function applyCmd(args: string[]): Promise<void> {
  const { positionals, flags } = parseArgs(args);
  const presetName = positionals[0];
  if (!presetName) {
    throw new Error("Usage: nyxhive preset apply <name> [instance] [--agent <key>] [--config <path>]");
  }

  const instanceName = positionals[1];
  const configFlag = typeof flags["--config"] === "string" ? flags["--config"] : undefined;
  const agentFlag = typeof flags["--agent"] === "string" ? flags["--agent"] : undefined;
  const resolved = resolveInstance(instanceName, undefined, configFlag);
  const agentKey = resolveTargetAgent(resolved.configPath, agentFlag);
  const state = applyPresetToInstance({
    presetName: normalizePresetName(presetName) ?? presetName,
    instanceDir: resolved.instanceDir,
    agentKey,
  });

  logger.info(`\n  Applied preset "${state.name}" for agent "${state.agent}".`);
  logger.info(`  Stored at: ${state.preset_dir}`);
  logger.info(`  State:     ${presetStatePath(resolved.instanceDir)}\n`);
}

async function ejectCmd(args: string[]): Promise<void> {
  const { positionals, flags } = parseArgs(args);
  const instanceName = positionals[0];
  const configFlag = typeof flags["--config"] === "string" ? flags["--config"] : undefined;
  const toFlag = typeof flags["--to"] === "string" ? flags["--to"] : undefined;
  const resolved = resolveInstance(instanceName, undefined, configFlag);
  const result = ejectPresetForInstance({
    instanceDir: resolved.instanceDir,
    targetDirName: toFlag,
  });

  logger.info(`\n  Ejected preset "${result.state.name}" for agent "${result.state.agent}".`);
  logger.info(`  Source: ${result.sourceDir}`);
  logger.info(`  Target: ${result.targetDir}\n`);
}

export async function handlePresets(args: string[]): Promise<void> {
  const subcommand = args[0];

  try {
    switch (subcommand) {
      case "list":
        listCmd();
        break;
      case "apply":
        await applyCmd(args.slice(1));
        break;
      case "eject":
        await ejectCmd(args.slice(1));
        break;
      default:
        logger.info(`
  Usage: nyxhive preset <command>

  Commands:
    list                                   List available soul presets
    apply <name> [instance] [--agent <k>] Apply a preset into an instance souls directory
    eject [instance] [--to <dir>]          Copy the active preset into an editable soul directory
`);
        if (subcommand) process.exit(1);
    }
  } catch (error) {
    logger.error(`  Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}

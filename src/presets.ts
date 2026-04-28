import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { compileSoulV2 } from "./soul/compiler-v2.js";
import { loadStandaloneSoulV2Directory } from "./soul/loader-v2.js";
import type { ComposedSoul } from "./soul/types.js";
import { validateComposedSoul } from "./soul/validator.js";

const BUILTIN_PRESETS_DIR = resolve(import.meta.dir, "../templates/presets");
const REQUIRED_PRESET_FILES = ["identity.md", "personality.md", "rules.md", "context.md", "tools.md"] as const;
const PRESET_REFERENCE_PREFIX = "preset:";

export const PRESET_NAMES = ["coder", "companion", "ops", "researcher", "custom"] as const;
export type SoulPresetName = (typeof PRESET_NAMES)[number];

export interface SoulPresetDefinition {
  name: SoulPresetName;
  description: string;
  role: "orchestrator" | "lead" | "worker" | "configurable";
  compatibility?: "active" | "legacy";
}

const PRESETS: SoulPresetDefinition[] = [
  {
    name: "coder",
    description: "Lead coding preset. Direct, technical, reads before writing, runs tests.",
    role: "lead",
    compatibility: "active",
  },
  {
    name: "companion",
    description: "Legacy companion preset. Kept for compatibility with older non-repo-lead setups.",
    role: "orchestrator",
    compatibility: "legacy",
  },
  {
    name: "ops",
    description: "Legacy ops preset. Kept for compatibility with older coordination-heavy setups.",
    role: "orchestrator",
    compatibility: "legacy",
  },
  {
    name: "researcher",
    description: "Research preset. Thorough, structured, and evidence-driven.",
    role: "worker",
    compatibility: "active",
  },
  {
    name: "custom",
    description: "Minimal blank slate preset. Boots cleanly and stays out of the way.",
    role: "configurable",
    compatibility: "active",
  },
];

export function getPresetCatalog(): SoulPresetDefinition[] {
  return [...PRESETS];
}

export function normalizePresetName(value?: string): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  return trimmed.startsWith(PRESET_REFERENCE_PREFIX)
    ? trimmed.slice(PRESET_REFERENCE_PREFIX.length)
    : trimmed;
}

export function isPresetReference(value?: string): boolean {
  return Boolean(normalizePresetName(value));
}

export function getPresetDefinition(nameOrRef: string): SoulPresetDefinition {
  const name = normalizePresetName(nameOrRef);
  const preset = PRESETS.find((entry) => entry.name === name);
  if (!preset) {
    throw new Error(`Unknown preset: ${nameOrRef}`);
  }
  return preset;
}

export function getPresetDir(nameOrRef: string): string {
  const preset = getPresetDefinition(nameOrRef);
  return join(BUILTIN_PRESETS_DIR, preset.name);
}

export function getPresetSoulDir(nameOrRef: string): string {
  const dir = join(getPresetDir(nameOrRef), "soul");
  for (const file of REQUIRED_PRESET_FILES) {
    if (!existsSync(join(dir, file))) {
      throw new Error(`Preset "${nameOrRef}" is missing soul/${file}`);
    }
  }
  return dir;
}

export function loadPresetSoul(nameOrRef: string): ComposedSoul {
  const presetName = normalizePresetName(nameOrRef);
  if (!presetName) {
    throw new Error(`Invalid preset reference: ${nameOrRef}`);
  }

  const soul = compileSoulV2(loadStandaloneSoulV2Directory(getPresetSoulDir(presetName)));
  const validation = validateComposedSoul(soul);
  if (!validation.valid) {
    throw new Error(`Preset "${presetName}" failed validation: ${validation.errors.join("; ")}`);
  }
  return soul;
}

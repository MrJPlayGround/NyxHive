// Soul runtime — model resolution, soul loading, and context injection
// This is the bridge between soul definitions and the agent invocation pipeline

import { readFileSync, existsSync, readdirSync, statSync } from "node:fs"
import { resolve } from "node:path"
import { parse as parseYaml } from "yaml"
import type { ComposedSoul, ModelTier, RelativeTier, RuleEntry, ScopedRule, SoulLayer } from "./types.js"
import { MODEL_TIER_ORDER, MODEL_TIER_REGISTRY } from "./types.js"
import { compileSoul, composeSystemPrompt } from "./compiler.js"
import { classifyComplexity } from "./classifier.js"
import { validateComposedSoul } from "./validator.js"
import { loadSoulV2Directory } from "./loader-v2.js"
import { compileSoulV2 } from "./compiler-v2.js"
import { logger } from "../utils/logger.js"

// Engine souls directory (relative to package root — ships with the engine, not per-instance)
const ENGINE_SOULS_DIR = resolve(import.meta.dir, "../../souls")

// Default souls directory — same as engine unless overridden by instance
const DEFAULT_SOULS_DIR = ENGINE_SOULS_DIR

interface SoulCacheEntry {
  soul: ComposedSoul;
  prompt: string;
  compactPrompt: string;
  signature: string;
}

// Cache: avoid recompiling the same soul sources on every invocation.
// Signature covers every source file that contributes to the compiled result,
// so edits to engine base, instance layer, _base, or agent extras invalidate cleanly.
const soulCache = new Map<string, SoulCacheEntry>()

// Load and parse a YAML soul file
function loadSoulFile(filePath: string): import("./types.js").SoulLayer {
  const raw = readFileSync(filePath, "utf-8")
  return parseYaml(raw) as import("./types.js").SoulLayer
}

// Resolve the souls directory path
function getSoulsDir(soulsDir?: string): string {
  return soulsDir ?? DEFAULT_SOULS_DIR
}

function buildCacheKey(agentKey: string, soulsDir?: string, instanceSoulsDir?: string): string {
  const dir = getSoulsDir(soulsDir);
  return [agentKey, dir, instanceSoulsDir ?? ""].join("::");
}

function listMarkdownFiles(dir: string): string[] {
  try {
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((name) => name.endsWith(".md"))
      .map((name) => resolve(dir, name))
      .sort();
  } catch {
    return [];
  }
}

function buildSourceSignature(paths: string[]): string {
  return paths
    .filter((path) => existsSync(path))
    .map((path) => {
      try {
        return `${path}:${statSync(path).mtimeMs}`;
      } catch {
        return `${path}:missing`;
      }
    })
    .join("|");
}

function resolveInstanceFile(soulsDir: string, instanceSoulsDir?: string): string | undefined {
  for (const candidateDir of [instanceSoulsDir, soulsDir]) {
    if (!candidateDir) continue;
    const instanceFile = resolve(candidateDir, "instance.yaml");
    if (existsSync(instanceFile)) return instanceFile;
  }
  return undefined;
}

function resolveV2SourcePaths(dir: string, agentKey: string, soulsDir?: string, instanceSoulsDir?: string): string[] {
  const instanceFile = soulsDir ? resolveInstanceFile(soulsDir, instanceSoulsDir) : undefined;
  return [
    ...(instanceFile ? [instanceFile] : []),
    ...listMarkdownFiles(resolve(dir, "_base")),
    ...listMarkdownFiles(resolve(dir, agentKey)),
  ];
}

function resolveV2SoulDir(
  soulsDir: string,
  agentKey: string,
  instanceSoulsDir?: string,
): string | undefined {
  for (const candidateDir of [instanceSoulsDir, soulsDir]) {
    if (!candidateDir) continue;
    if (isV2Soul(candidateDir, agentKey)) {
      return candidateDir;
    }
  }
  return undefined;
}

function resolveV1SourcePaths(dir: string, agentKey: string, instanceSoulsDir?: string): string[] {
  const paths: string[] = [];
  const baseFile = resolve(ENGINE_SOULS_DIR, "base.yaml");
  const agentFile = resolve(dir, `${agentKey}.yaml`);

  if (existsSync(baseFile)) paths.push(baseFile);
  for (const candidateDir of [instanceSoulsDir, dir]) {
    if (!candidateDir) continue;
    const instanceFile = resolve(candidateDir, "instance.yaml");
    if (existsSync(instanceFile)) {
      paths.push(instanceFile);
      break;
    }
  }
  if (existsSync(agentFile)) paths.push(agentFile);
  return paths;
}

// Detect v2 directory format: agent has a subdirectory in the given souls dir
function isV2Soul(soulsDir: string, agentKey: string): boolean {
  const agentDir = resolve(soulsDir, agentKey)
  try {
    return existsSync(agentDir) && statSync(agentDir).isDirectory()
  } catch {
    return false
  }
}

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values.filter((value) => value.trim().length > 0))];
}

function normalizeRuleEntry(entry: RuleEntry): ScopedRule {
  if (typeof entry === "string") return { rule: entry, scope: "global" };
  return { rule: entry.rule, scope: entry.scope ?? "global" };
}

function mergeInstanceLayerIntoV2Soul(
  soul: ComposedSoul,
  instanceLayer: SoulLayer | undefined,
  loaded: ReturnType<typeof loadSoulV2Directory>,
): ComposedSoul {
  if (!instanceLayer) return soul;

  const instanceCapabilities = instanceLayer.capabilities;
  const agentDefinesMemory = !!loaded.agent.memory;
  const mergedCapabilities = instanceCapabilities
    ? {
        ...soul.capabilities,
        tools: dedupeStrings([...soul.capabilities.tools, ...(instanceCapabilities.tools ?? [])]),
        disallowed_tools: dedupeStrings([...soul.capabilities.disallowed_tools, ...(instanceCapabilities.disallowed_tools ?? [])]),
        mcp_tools: dedupeStrings([...soul.capabilities.mcp_tools, ...(instanceCapabilities.mcp_tools ?? [])]),
        can_delegate: soul.capabilities.can_delegate && (instanceCapabilities.can_delegate ?? true),
        can_read_files: soul.capabilities.can_read_files && (instanceCapabilities.can_read_files ?? true),
        can_write_files: soul.capabilities.can_write_files && (instanceCapabilities.can_write_files ?? true),
        can_run_commands: soul.capabilities.can_run_commands && (instanceCapabilities.can_run_commands ?? true),
        allowed_directories: dedupeStrings([
          ...soul.capabilities.allowed_directories,
          ...(instanceCapabilities.allowed_directories ?? []),
        ]),
        max_tool_turns: Math.min(soul.capabilities.max_tool_turns, instanceCapabilities.max_tool_turns ?? Number.POSITIVE_INFINITY),
        context_strategy: agentDefinesMemory
          ? soul.capabilities.context_strategy
          : instanceCapabilities.context_strategy ?? soul.capabilities.context_strategy,
      }
    : soul.capabilities;

  const instanceContext = instanceLayer.context;
  const agentDefinesContext = !!loaded.agent.context;
  const mergedRelationships = [
    ...(instanceContext?.relationships ?? []),
    ...(soul.context.relationships ?? []),
  ].filter((relationship, index, all) =>
    all.findIndex((candidate) => candidate.name === relationship.name && candidate.role === relationship.role) === index,
  );
  const mergedContext = instanceContext
    ? {
        ...soul.context,
        domains: dedupeStrings([...(instanceContext.domains ?? []), ...(soul.context.domains ?? [])]),
        relationships: mergedRelationships,
        instance_notes: agentDefinesContext
          ? soul.context.instance_notes ?? instanceContext.instance_notes
          : instanceContext.instance_notes ?? soul.context.instance_notes,
      }
    : soul.context;

  const instanceRules = instanceLayer.rules;
  const mergedRules = instanceRules
    ? {
        must: [
          ...(instanceRules.must ?? []).map(normalizeRuleEntry),
          ...soul.rules.must,
        ],
        must_not: [
          ...(instanceRules.must_not ?? []).map(normalizeRuleEntry),
          ...soul.rules.must_not,
        ],
        guidelines: dedupeStrings([...(instanceRules.guidelines ?? []), ...soul.rules.guidelines]),
      }
    : soul.rules;

  return {
    ...soul,
    capabilities: mergedCapabilities,
    context: mergedContext,
    rules: mergedRules,
  };
}

// Load and compile a soul for an agent (with instance layer if present)
// Returns undefined if no soul file exists for the agent
// instanceSoulsDir: override directory for instance-local souls (agent dir + instance.yaml)
export function loadAndCompileSoul(
  agentKey: string,
  soulsDir?: string,
  instanceSoulsDir?: string,
): ComposedSoul | undefined {
  const dir = getSoulsDir(soulsDir)
  const cacheKey = buildCacheKey(agentKey, soulsDir, instanceSoulsDir)
  const v2Dir = resolveV2SoulDir(dir, agentKey, instanceSoulsDir)

  // --- v2 directory format ---
  if (v2Dir) {
    const signature = buildSourceSignature(resolveV2SourcePaths(v2Dir, agentKey, dir, instanceSoulsDir))
    try {
      const cached = soulCache.get(cacheKey)
      if (cached && cached.signature === signature) return cached.soul

      const loaded = loadSoulV2Directory(v2Dir, agentKey)
      const instanceFile = resolveInstanceFile(dir, instanceSoulsDir)
      const instanceLayer = instanceFile ? loadSoulFile(instanceFile) : undefined
      const soul = mergeInstanceLayerIntoV2Soul(compileSoulV2(loaded), instanceLayer, loaded)
      const result = validateComposedSoul(soul)

      for (const warning of result.warnings) {
        logger.warn(`[soul:${agentKey}] ${warning}`)
      }
      if (!result.valid) {
        const errorStr = result.errors.join("; ")
        logger.error(`[soul:${agentKey}] Validation failed: ${errorStr}`)
        throw new Error(`Soul validation failed for ${agentKey}: ${errorStr}`)
      }

      const prompt = composeSystemPrompt(soul)
      const compactPrompt = composeSystemPrompt(soul, "NyxAI", "compact")
      soulCache.set(cacheKey, { soul, prompt, compactPrompt, signature })
      logger.debug(`[soul:${agentKey}] Compiled v2 and cached (full: ${prompt.length}, compact: ${compactPrompt.length} chars)`)
      return soul
    } catch (err) {
      logger.error(`[soul:${agentKey}] Failed to compile v2 soul: ${err}`)
      throw err
    }
  }

  // --- v1 YAML format (fallback) ---
  const agentFile = resolve(dir, `${agentKey}.yaml`)
  if (!existsSync(agentFile)) return undefined

  try {
    const signature = buildSourceSignature(resolveV1SourcePaths(dir, agentKey, instanceSoulsDir))
    const cached = soulCache.get(cacheKey)
    if (cached && cached.signature === signature) return cached.soul

    const layers: import("./types.js").SoulLayer[] = []

    // Base layer (engine behavioral defaults — always from engine installation, not instance dir)
    const baseFile = resolve(ENGINE_SOULS_DIR, "base.yaml")
    if (existsSync(baseFile)) {
      layers.push(loadSoulFile(baseFile))
    }

    // Instance layer — check instanceSoulsDir first, fall back to engine souls dir
    const instanceDirs = [instanceSoulsDir, dir].filter(Boolean) as string[]
    for (const iDir of instanceDirs) {
      const instanceFile = resolve(iDir, "instance.yaml")
      if (existsSync(instanceFile)) {
        layers.push(loadSoulFile(instanceFile))
        break
      }
    }

    // Agent layer
    layers.push(loadSoulFile(agentFile))

    const soul = compileSoul(layers)
    const result = validateComposedSoul(soul)

    for (const warning of result.warnings) {
      logger.warn(`[soul:${agentKey}] ${warning}`)
    }
    if (!result.valid) {
      const errorStr = result.errors.join("; ")
      logger.error(`[soul:${agentKey}] Validation failed: ${errorStr}`)
      throw new Error(`Soul validation failed for ${agentKey}: ${errorStr}`)
    }

    const prompt = composeSystemPrompt(soul)
    const compactPrompt = composeSystemPrompt(soul, "NyxAI", "compact")
    soulCache.set(cacheKey, { soul, prompt, compactPrompt, signature })
    logger.debug(`[soul:${agentKey}] Compiled and cached`)
    return soul
  } catch (err) {
    logger.error(`[soul:${agentKey}] Failed to compile soul: ${err}`)
    throw err
  }
}

// Get the compiled system prompt for an agent
// tier: "full" (default, for CLI) includes extras like personality/philosophy
//       "compact" (for SDK) strips extras to save tokens
// Returns undefined if no soul file exists
export function getSoulSystemPrompt(
  agentKey: string,
  soulsDir?: string,
  tier: "full" | "compact" = "full",
  instanceSoulsDir?: string,
): string | undefined {
  const dir = getSoulsDir(soulsDir)
  const cacheKey = buildCacheKey(agentKey, soulsDir, instanceSoulsDir)
  const v2Dir = resolveV2SoulDir(dir, agentKey, instanceSoulsDir)

  const cached = soulCache.get(cacheKey)
  if (cached) {
    const signature = v2Dir
      ? buildSourceSignature(resolveV2SourcePaths(v2Dir, agentKey, dir, instanceSoulsDir))
      : buildSourceSignature(resolveV1SourcePaths(dir, agentKey, instanceSoulsDir))
    if (cached.signature === signature) {
      return tier === "compact" ? cached.compactPrompt : cached.prompt
    }
  }

  const soul = loadAndCompileSoul(agentKey, soulsDir, instanceSoulsDir)
  if (!soul) return undefined

  const prompt = composeSystemPrompt(soul)
  const compactPrompt = composeSystemPrompt(soul, "NyxAI", "compact")
  const entry = soulCache.get(cacheKey)
  if (entry) {
    entry.prompt = prompt
    entry.compactPrompt = compactPrompt
  }
  return tier === "compact" ? compactPrompt : prompt
}

export function primeSoulCache(
  agentKeys: string[],
  soulsDir?: string,
  instanceSoulsDir?: string,
): void {
  for (const agentKey of agentKeys) {
    try {
      loadAndCompileSoul(agentKey, soulsDir, instanceSoulsDir);
    } catch (err) {
      logger.warn(`[soul:${agentKey}] Cache warm failed: ${err}`);
    }
  }
}

// Resolve the final model ID from a complexity hint + soul range
// orchestratorHint: absolute tier hint from delegation tag (e.g. "| model=opus")
// classifierTier: relative tier from complexity classifier
export function resolveModel(
  soul: ComposedSoul,
  classifierTier?: RelativeTier,
  orchestratorHint?: ModelTier,
): string {
  const caps = soul.model_capabilities

  if (orchestratorHint) {
    // Orchestrator hint is absolute — bound it by soul's min/max range
    const requested = MODEL_TIER_ORDER.indexOf(orchestratorHint)
    const min = MODEL_TIER_ORDER.indexOf(caps.min_model)
    const max = MODEL_TIER_ORDER.indexOf(caps.max_model)
    const bounded = MODEL_TIER_ORDER[Math.max(min, Math.min(max, requested))]
    return MODEL_TIER_REGISTRY[bounded]
  }

  // Use relative tier from classifier, mapped through soul's range
  if (classifierTier) {
    const tier: ModelTier =
      classifierTier === "min"
        ? caps.min_model
        : classifierTier === "max"
          ? caps.max_model
          : caps.default_model
    return MODEL_TIER_REGISTRY[tier]
  }

  // No hint — use soul's default
  return MODEL_TIER_REGISTRY[caps.default_model]
}

// Resolve model from a task description using the complexity classifier
export function resolveModelForTask(
  soul: ComposedSoul,
  task: string,
  fileCount = 0,
  orchestratorHint?: ModelTier,
): { modelId: string; classifierResult: ReturnType<typeof classifyComplexity> } {
  const classifierResult = classifyComplexity(task, fileCount)
  const modelId = resolveModel(soul, classifierResult.tier, orchestratorHint)
  return { modelId, classifierResult }
}

// Inject a model hint into runtime context (not into system prompt)
// Used to pass model selection metadata alongside task delegation
export function injectModelHint(
  context: Record<string, unknown>,
  modelHint: ModelTier,
): Record<string, unknown> {
  return { ...context, _soul_model_hint: modelHint }
}

// Clear the soul cache (useful for testing or after soul file edits)
export function clearSoulCache(): void {
  soulCache.clear()
}

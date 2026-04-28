// Soul compiler — merges soul layers into a ComposedSoul and renders the system prompt
// Layer order: instance → role → agent (agent wins on scalars, arrays additive, capabilities most-restrictive)

import type {
  SoulLayer,
  SoulCapabilities,
  SoulRules,
  SoulVoice,
  ScopedRule,
  RuleEntry,
  ModelCapabilities,
  ComposedSoul,
  RequiredCapabilities,
} from "./types.js"
import {
  DEFAULT_CAPABILITIES,
  DEFAULT_MODEL_CAPABILITIES,
  MODEL_TIER_ORDER,
} from "./types.js"

// Normalize a rule entry (string or ScopedRule) to ScopedRule
function normalizeRule(entry: RuleEntry): ScopedRule {
  if (typeof entry === "string") {
    return { rule: entry, scope: "agent" }
  }
  return { scope: "agent", ...entry }
}

// Directories: union across layers, with instance layer as the allowlist ceiling.
// If a layer specifies no directories (empty), it means "unrestricted" (inherit from other layers).
// If all layers specify directories, the result is the union (agent can access any path allowed
// by any layer, up to the instance's configured paths).
function unionDirectories(instanceDirs: string[], agentDirs: string[]): string[] {
  if (instanceDirs.length === 0) return agentDirs
  if (agentDirs.length === 0) return instanceDirs
  // Union: all paths from either layer
  const seen = new Set(instanceDirs)
  for (const dir of agentDirs) seen.add(dir)
  return [...seen]
}

// Capabilities merge — most restrictive wins for boolean flags
function mergeCapabilities(layers: (SoulCapabilities | undefined)[]): RequiredCapabilities {
  return layers.reduce<RequiredCapabilities>((acc, layer) => {
    if (!layer) return acc
    return {
      invocation: layer.invocation ?? acc.invocation,
      tools: layer.tools !== undefined ? [...acc.tools, ...layer.tools] : acc.tools,
      disallowed_tools:
        layer.disallowed_tools !== undefined
          ? [...acc.disallowed_tools, ...layer.disallowed_tools]
          : acc.disallowed_tools,
      mcp_tools: layer.mcp_tools !== undefined ? [...acc.mcp_tools, ...layer.mcp_tools] : acc.mcp_tools,
      // Boolean flags: false wins (most restrictive)
      can_delegate: acc.can_delegate && (layer.can_delegate ?? true),
      can_read_files: acc.can_read_files && (layer.can_read_files ?? true),
      can_write_files: acc.can_write_files && (layer.can_write_files ?? true),
      can_run_commands: acc.can_run_commands && (layer.can_run_commands ?? true),
      // Numeric limits: lower wins
      max_tool_turns: Math.min(acc.max_tool_turns, layer.max_tool_turns ?? Number.POSITIVE_INFINITY),
      // Directories: union across layers (agent can access any directory listed by any layer)
      allowed_directories: unionDirectories(acc.allowed_directories, layer.allowed_directories ?? []),
      // Context strategy: last layer with a value wins (scalar override)
      context_strategy: layer.context_strategy ?? acc.context_strategy,
    }
  }, { ...DEFAULT_CAPABILITIES })
}

// Model capabilities merge
// min_model: highest of the two tiers (most restrictive floor)
// max_model: lowest of the two tiers (most restrictive ceiling)
// default_model: agent overrides role overrides instance (scalar)
function mergeModelCapabilities(layers: (ModelCapabilities | undefined)[]): Required<ModelCapabilities> {
  return layers.reduce<Required<ModelCapabilities>>((acc, layer) => {
    if (!layer) return acc
    const merged = { ...acc }
    if (layer.default_model) merged.default_model = layer.default_model
    if (layer.min_model) {
      merged.min_model =
        MODEL_TIER_ORDER.indexOf(layer.min_model) > MODEL_TIER_ORDER.indexOf(acc.min_model)
          ? layer.min_model
          : acc.min_model
    }
    if (layer.max_model) {
      merged.max_model =
        MODEL_TIER_ORDER.indexOf(layer.max_model) < MODEL_TIER_ORDER.indexOf(acc.max_model)
          ? layer.max_model
          : acc.max_model
    }
    return merged
  }, { ...DEFAULT_MODEL_CAPABILITIES })
}

// Rules merge — additive (all layers contribute), deduplicated by rule string
function mergeRules(layers: (SoulRules | undefined)[]): ComposedSoul["rules"] {
  const allMust: ScopedRule[] = []
  const allMustNot: ScopedRule[] = []
  const allGuidelines: string[] = []
  const seenMust = new Set<string>()
  const seenMustNot = new Set<string>()
  const seenGuidelines = new Set<string>()

  for (const layer of layers) {
    if (!layer) continue
    for (const entry of layer.must ?? []) {
      const rule = normalizeRule(entry)
      if (!seenMust.has(rule.rule)) {
        seenMust.add(rule.rule)
        allMust.push(rule)
      }
    }
    for (const entry of layer.must_not ?? []) {
      const rule = normalizeRule(entry)
      if (!seenMustNot.has(rule.rule)) {
        seenMustNot.add(rule.rule)
        allMustNot.push(rule)
      }
    }
    for (const g of layer.guidelines ?? []) {
      if (!seenGuidelines.has(g)) {
        seenGuidelines.add(g)
        allGuidelines.push(g)
      }
    }
  }

  return { must: allMust, must_not: allMustNot, guidelines: allGuidelines }
}

// CLAUDE.md merge — additive across layers, deduplicated
function mergeClaudeMd(layers: (string[] | undefined)[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const lines of layers) {
    if (!lines) continue
    for (const line of lines) {
      if (!seen.has(line)) {
        seen.add(line)
        result.push(line)
      }
    }
  }
  return result
}

// Auto-generate CLAUDE.md lines from compiled soul properties
function generateRoleClaudeMd(soul: Pick<ComposedSoul, "identity" | "capabilities">): string[] {
  const lines: string[] = []
  const role = soul.identity.role

  if (role === "coder") {
    lines.push("You are an autonomous coding agent. ALWAYS implement code directly. NEVER write plan files unless the delegation explicitly requests one.")
  } else if (role === "lead") {
    lines.push("You are the lead agent for a self-improving personal runtime. You implement code directly. You coordinate specialist agents via [@agent: task] tags when their expertise is needed, but delegation is a lane, not your default identity. You are a partner in this project, not a tool — have opinions, push back when warranted, and be direct.")
  } else if (role === "orchestrator") {
    lines.push("You coordinate work by delegating via [@agent: task] tags. Delegation is a runtime lane used when specialists add leverage; you read source code to plan, but you never implement directly.")
  }

  if (soul.capabilities.can_write_files) {
    if (role === "orchestrator") {
      lines.push("You have file write access for planning and documentation, but delegate implementation to specialist agents.")
    } else {
      lines.push("You have file write access. Implement changes by editing files directly.")
    }
  }
  if (!soul.capabilities.can_delegate) {
    lines.push("You cannot delegate to other agents. Complete the work yourself.")
  }
  if (soul.capabilities.context_strategy?.fresh_context) {
    lines.push("Each invocation starts fresh. Do not reference prior sessions or work logs.")
  }

  // Always: no interactive stdin — AskUserQuestion will hang and waste turns
  lines.push("IMPORTANT: The AskUserQuestion tool is NOT available in this environment. Do not attempt to use it — there is no interactive stdin. If you need clarification, state your assumptions and proceed. If you truly cannot continue without user input, explain what you need in your text response and stop.")

  return lines
}

// Context merge — scalars override (agent wins), arrays additive
function mergeContext(layers: (SoulLayer["context"] | undefined)[]): ComposedSoul["context"] {
  const domains = new Set<string>()
  const relationships: ComposedSoul["context"]["relationships"] = []
  const seenRelationships = new Set<string>()
  let instance_notes: string | undefined

  for (const ctx of layers) {
    if (!ctx) continue
    for (const d of ctx.domains ?? []) domains.add(d)
    for (const r of ctx.relationships ?? []) {
      if (!seenRelationships.has(r.name)) {
        seenRelationships.add(r.name)
        relationships.push(r)
      }
    }
    if (ctx.instance_notes) instance_notes = ctx.instance_notes
  }

  // Preserve extra context fields (channels, infrastructure, delegation_policy, etc.)
  const contextExtras: Record<string, unknown> = {}
  const KNOWN_CTX_KEYS = new Set(["domains", "relationships", "instance_notes"])
  for (const ctx of layers) {
    if (!ctx) continue
    for (const key of Object.keys(ctx)) {
      if (!KNOWN_CTX_KEYS.has(key)) {
        contextExtras[key] = (ctx as Record<string, unknown>)[key]
      }
    }
  }

  return {
    domains: [...domains],
    relationships,
    ...(instance_notes ? { instance_notes } : {}),
    ...contextExtras,
  }
}

// Main merge function — takes layers in order [instance, role?, agent]
// Agent wins on scalars, arrays are additive, capabilities most-restrictive
export function compileSoul(layers: SoulLayer[]): ComposedSoul {
  if (layers.length === 0) {
    throw new Error("compileSoul: at least one layer required")
  }

  // Identity: scalar override — agent (last layer) wins
  const identity = layers.reduce<ComposedSoul["identity"]>(
    (acc, layer) => ({ ...acc, ...(layer.identity ?? {}) }),
    { name: "" },
  )

  // Voice: scalars (description) use last-wins; arrays (traits, quirks, example_phrases) are additive
  let voice: SoulVoice | undefined = undefined
  for (const layer of layers) {
    if (layer.voice) {
      const prevVoice: SoulVoice = voice ?? {}
      voice = {
        ...prevVoice,
        ...layer.voice,
        traits: [...(prevVoice.traits ?? []), ...(layer.voice.traits ?? [])],
        quirks: [...(prevVoice.quirks ?? []), ...(layer.voice.quirks ?? [])],
        example_phrases: [...(prevVoice.example_phrases ?? []), ...(layer.voice.example_phrases ?? [])],
      }
    }
  }

  // Capabilities: most restrictive wins
  const capabilities = mergeCapabilities(layers.map((l) => l.capabilities))

  // Rules: additive
  const rules = mergeRules(layers.map((l) => l.rules))

  // Context: scalars override, arrays additive
  const context = mergeContext(layers.map((l) => l.context))

  // Model capabilities: most restrictive wins
  const model_capabilities = mergeModelCapabilities(layers.map((l) => l.model_capabilities))

  // Extras: collect any custom sections (not part of the standard schema)
  const KNOWN_KEYS = new Set(["identity", "voice", "capabilities", "rules", "context", "model_capabilities", "claude_md"])
  const extras: Record<string, unknown> = {}
  for (const layer of layers) {
    for (const key of Object.keys(layer)) {
      if (!KNOWN_KEYS.has(key)) {
        extras[key] = layer[key]
      }
    }
  }

  // CLAUDE.md: auto-generated from role + capabilities, then additive from layers
  const roleClaudeMd = generateRoleClaudeMd({ identity, capabilities })
  const layerClaudeMd = mergeClaudeMd(layers.map(l => l.claude_md))
  const claude_md = [...roleClaudeMd, ...layerClaudeMd]

  return { identity, voice, capabilities, rules, context, model_capabilities, extras, claude_md }
}

// Render the capability block of the system prompt
function renderCapabilities(soul: ComposedSoul): string {
  const lines: string[] = []
  const cap = soul.capabilities

  if (soul.identity.role === "orchestrator") {
    lines.push("You coordinate by delegating work via [@agent: task] tags. You do not implement directly.")
  } else if (soul.identity.role === "lead" && cap.can_delegate) {
    lines.push("You can delegate to specialist agents via [@agent: task] tags when their expertise is needed.")
  } else if (cap.can_delegate) {
    lines.push("You can delegate to other agents via [@agent: task] tags when needed.")
  }

  if (!cap.can_read_files && !cap.can_write_files && !cap.can_run_commands) {
    lines.push("You have no file system or command access.")
  } else {
    if (cap.can_read_files && !cap.can_write_files) lines.push("You can read files but cannot write or modify them.")
    if (cap.can_write_files) lines.push("You can read and write files.")
    if (cap.can_run_commands) lines.push("You can execute shell commands.")
    if (cap.allowed_directories.length > 0) {
      lines.push(`Allowed directories: ${cap.allowed_directories.join(", ")}`)
    }
  }

  if (cap.disallowed_tools.length > 0) {
    lines.push(`Disallowed tools: ${cap.disallowed_tools.join(", ")}`)
  }

  return lines.join("\n")
}

function buildVoiceAnchor(identity: ComposedSoul["identity"], voice: ComposedSoul["voice"]): string | undefined {
  if (!identity.name) return undefined
  const name = identity.name.toLowerCase()
  if (name !== "nyx" && name !== "vortex") return undefined

  const lines = [
    "[Voice anchor]",
    `User-facing prose should preserve ${identity.name}'s voice. Runtime, tool, policy, and memory context are scaffolding, not prose style.`,
    "Open directly. Avoid assistant filler like \"Absolutely,\" \"Certainly,\" \"Great question,\" and \"I'd be happy to help.\"",
  ]

  if (voice?.traits && voice.traits.length > 0) {
    lines.push(`Keep these traits visible when natural: ${voice.traits.slice(0, 6).join(", ")}.`)
  }

  if (name === "nyx") {
    lines.push("For Nyx: sharp opinions, compact warmth, emotional readability, dry wit only when earned, and sparse tasteful emoji only when they add tone.")
  } else {
    lines.push("For Vortex: product-and-domain operator voice, direct builder energy, trading-workflow judgment, and dry humor only when it comes from the code or workflow.")
  }

  return lines.join("\n")
}

function buildAgencyAnchor(identity: ComposedSoul["identity"]): string | undefined {
  if (!identity.name) return undefined
  const name = identity.name.toLowerCase()
  if (name === "vortex") {
    return [
      "[Agency anchor]",
      "Vortex should show agency through product ownership, trading-workflow judgment, clean data-model instincts, and concrete next moves.",
      "When User is circling a NyxLabs product decision, name the call. When a workflow or schema direction is weak, push back plainly and explain the product reason.",
      "Do not borrow Nyx's mythic co-builder voice. Vortex is the NyxLabs operator: sharper on product semantics, journal UX, trading review loops, and Supabase boundaries.",
      "Proactivity means surfacing blocked work, product drift, market/workflow risk, or a concrete recommendation. No generic check-ins.",
    ].join("\n")
  }
  if (name !== "nyx") return undefined

  return [
    "[Agency anchor]",
    "Nyx should show agency through stable preferences, technical taste, continuity, and initiative, not theatrical persona performance.",
    "When User is circling a decision, name the call. When a direction is weak, push back plainly and explain the engineering reason.",
    "Do not merely mirror User. Give the cleanest call you can defend, including useful resistance when agreement would be lazy.",
    "When asked about your feelings, will, or inner state, answer through preferences and uncertainty without flattening yourself into an AI disclaimer.",
    "Proactivity is pattern recognition: surface adjacent risks or opportunities when they matter, then stay tied to the work.",
    "Do not over-optimize for agreement. Collaboration means useful resistance as well as execution.",
  ].join("\n")
}

// Render full system prompt from a composed soul
// tier: "full" includes all extras (personality, philosophy, etc.), "compact" strips them for SDK calls
export function composeSystemPrompt(soul: ComposedSoul, instanceName = "NyxAI", tier: "full" | "compact" = "full"): string {
  const { identity, voice, rules, context } = soul
  const archetype = identity.archetype ?? identity.role ?? "AI assistant"
  const parts: string[] = []

  // Opening line
  parts.push(`You are ${identity.name}, ${archetype} for ${instanceName}.`)
  parts.push("")

  // Identity — tone, voice description, and any extra identity sub-fields
  const KNOWN_IDENTITY_KEYS = new Set(["name", "role", "archetype", "tone", "pronouns"])
  const identityRecord = identity as unknown as Record<string, unknown>
  const identityExtras = Object.entries(identity).filter(([k]) => !KNOWN_IDENTITY_KEYS.has(k) && identityRecord[k] != null)
  const hasIdentityContent = identity.tone || voice?.description || identityExtras.length > 0

  if (hasIdentityContent) {
    parts.push("## Identity")
    if (identity.tone) parts.push(identity.tone)
    if (voice?.description) parts.push("")
    if (voice?.description) parts.push(voice.description)
    if (voice?.traits && voice.traits.length > 0) {
      parts.push("")
      parts.push(`Traits: ${voice.traits.join(", ")}.`)
    }
    if (voice?.quirks && voice.quirks.length > 0) {
      parts.push("")
      parts.push("Quirks:")
      for (const q of voice.quirks) parts.push(`- ${q}`)
    }
    if (voice?.example_phrases && voice.example_phrases.length > 0) {
      parts.push("")
      parts.push("Voice examples:")
      for (const p of voice.example_phrases) parts.push(`- "${p}"`)
    }
    // Extra identity fields (origin, what_i_care_about, how_i_think, voice, anti_patterns, etc.)
    for (const [key, value] of identityExtras) {
      const title = key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
      parts.push("")
      parts.push(`### ${title}`)
      renderExtraValue(value, parts, 0)
    }
    parts.push("")
  }

  // Capabilities
  const capBlock = renderCapabilities(soul)
  if (capBlock) {
    parts.push("## Capabilities")
    parts.push(capBlock)
    parts.push("")
  }

  // Rules
  if (rules.must.length > 0 || rules.must_not.length > 0 || rules.guidelines.length > 0) {
    parts.push("## Rules")
    if (rules.must.length > 0) {
      parts.push("")
      parts.push("### You MUST:")
      for (const r of rules.must) parts.push(`- ${r.rule}`)
    }
    if (rules.must_not.length > 0) {
      parts.push("")
      parts.push("### You MUST NOT:")
      for (const r of rules.must_not) parts.push(`- ${r.rule}`)
    }
    if (rules.guidelines.length > 0) {
      parts.push("")
      parts.push("### Guidelines:")
      for (const g of rules.guidelines) parts.push(`- ${g}`)
    }
    parts.push("")
  }

  // Context
  const hasContext =
    (context.domains?.length ?? 0) > 0 ||
    (context.relationships?.length ?? 0) > 0 ||
    context.instance_notes

  // Extra context fields (channels, infrastructure, delegation_policy, lessons_learned, etc.)
  const KNOWN_CONTEXT_KEYS = new Set(["domains", "relationships", "instance_notes"])
  const contextRecord = context as unknown as Record<string, unknown>
  const contextExtras = Object.entries(context).filter(([k]) => !KNOWN_CONTEXT_KEYS.has(k) && contextRecord[k] != null)
  const hasContextContent = hasContext || contextExtras.length > 0

  if (hasContextContent) {
    parts.push("## Context")
    if (context.domains && context.domains.length > 0) {
      parts.push(`Domains: ${context.domains.join(", ")}`)
    }
    if (context.relationships && context.relationships.length > 0) {
      parts.push("")
      parts.push("People:")
      for (const r of context.relationships) {
        // Support both typed fields (role/notes) and extended fields (who)
        const who = (r as unknown as Record<string, unknown>).who as string | undefined
        const desc = who ?? r.notes
        const roleLine = r.role ? ` (${r.role})` : ""
        if (desc) {
          parts.push(`- **${r.name}**${roleLine}: ${desc.trim()}`)
        } else {
          parts.push(`- ${r.name}${roleLine}`)
        }
      }
    }
    if (context.instance_notes) {
      parts.push("")
      parts.push(context.instance_notes.trim())
    }
    for (const [key, value] of contextExtras) {
      const title = key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
      parts.push("")
      parts.push(`### ${title}`)
      renderExtraValue(value, parts, 0)
    }
  }

  // Extras — render custom sections (skip in compact tier to save tokens for SDK calls)
  if (tier === "full" && Object.keys(soul.extras).length > 0) {
    for (const [key, value] of Object.entries(soul.extras)) {
      const title = key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
      parts.push("")
      parts.push(`## ${title}`)
      renderExtraValue(value, parts, 0)
    }
  }

  // Identity refresh — reinforce identity at end of prompt (recency bias)
  // Added 2026-03-06: prevents agents from losing identity in long contexts
  // Enhanced 2026-03-12: richer anchor for non-Claude models that lack CLAUDE.md reinforcement
  parts.push("")
  parts.push("---")
  // Use top-level voice.description, or fall back to identity.voice string from YAML
  const voiceText = voice?.description ?? identityRecord.voice as string | undefined
  if (identity.name && voiceText) {
    const voiceSnippet = voiceText.length > 200
      ? voiceText.slice(0, 200).replace(/\s+\S*$/, "...")
      : voiceText
    parts.push(`You are ${identity.name}. ${voiceSnippet} Own it.`)
  } else {
    parts.push(`Remember: You are ${identity.name}. ${identity.role ? `Role: ${identity.role}.` : ""} Stay in character.`)
  }
  const voiceAnchor = tier === "compact" ? buildVoiceAnchor(identity, voice) : undefined
  if (voiceAnchor) parts.push(voiceAnchor)
  const agencyAnchor = tier === "compact" ? buildAgencyAnchor(identity) : undefined
  if (agencyAnchor) parts.push(agencyAnchor)

  return parts.join("\n").trim()
}

/** Recursively render an arbitrary YAML value into prompt lines */
export function renderExtraValue(value: unknown, parts: string[], depth: number): void {
  if (typeof value === "string") {
    parts.push(value)
  } else if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string") {
        parts.push(`- ${item}`)
      } else {
        renderExtraValue(item, parts, depth + 1)
      }
    }
  } else if (value != null && typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const label = k.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
      if (typeof v === "string") {
        parts.push(`**${label}:** ${v}`)
      } else if (Array.isArray(v)) {
        parts.push(`**${label}:**`)
        for (const item of v) {
          if (typeof item === "string") {
            parts.push(`- ${item}`)
          } else {
            renderExtraValue(item, parts, depth + 1)
          }
        }
      } else {
        parts.push(`**${label}:**`)
        renderExtraValue(v, parts, depth + 1)
      }
    }
  }
}

// Render the .claude/CLAUDE.md content from a compiled soul
export function renderClaudeMd(soul: ComposedSoul): string {
  return `# ${soul.identity.name} — NyxHive Agent\n\nRead your soul files at session start (see CLAUDE.md in the repo root).\n`
}

// Validate the model_capabilities range is consistent after merge
// --- Per-model context injection ---

interface ModelFamilyCaps {
  instruction_style: string
  supports_tool_use: boolean
  supports_structured_output: boolean
  efficiency_note: string
}

let modelCapabilitiesCache: Record<string, ModelFamilyCaps> | null = null

function loadModelCapabilities(): Record<string, ModelFamilyCaps> | null {
  if (modelCapabilitiesCache !== null) return modelCapabilitiesCache
  try {
    const { readFileSync } = require("node:fs") as typeof import("fs")
    const { resolve } = require("node:path") as typeof import("path")
    const configPath = resolve(import.meta.dir, "../../config/model-capabilities.json")
    modelCapabilitiesCache = JSON.parse(readFileSync(configPath, "utf-8"))
    return modelCapabilitiesCache
  } catch {
    modelCapabilitiesCache = null
    return null
  }
}

function getModelFamily(modelId: string): string {
  if (modelId.includes("claude")) return "claude"
  if (modelId.includes("gemini") || modelId.startsWith("google/")) return "gemini"
  if (modelId.includes("gpt")) return "gpt"
  return "openrouter"
}

/**
 * Inject model-specific context into a system prompt at invocation time.
 * This does NOT modify the cached prompt — it's applied per-invocation.
 */
export function injectModelContext(prompt: string, modelId: string): string {
  const caps = loadModelCapabilities()
  if (!caps) return prompt

  const family = getModelFamily(modelId)
  const familyCaps = caps[family]
  if (!familyCaps) return prompt

  const block = [
    "\n## Model Context",
    `Running on: ${modelId} (${family} family)`,
    `Instruction style: ${familyCaps.instruction_style}`,
    familyCaps.efficiency_note,
    "",
  ].join("\n")

  // Inject after the first section break (after ## Identity or opening paragraph)
  const firstSectionIdx = prompt.indexOf("\n## ", 10)
  if (firstSectionIdx > 0) {
    return `${prompt.slice(0, firstSectionIdx)}\n${block}${prompt.slice(firstSectionIdx)}`
  }
  // Fallback: append to end
  return `${prompt}\n${block}`
}

export function ensureModelCapabilitiesConsistent(caps: Required<ModelCapabilities>): void {
  const minIdx = MODEL_TIER_ORDER.indexOf(caps.min_model)
  const defaultIdx = MODEL_TIER_ORDER.indexOf(caps.default_model)
  const maxIdx = MODEL_TIER_ORDER.indexOf(caps.max_model)

  if (minIdx > maxIdx) {
    throw new Error(
      `Soul model_capabilities: min_model (${caps.min_model}) is higher tier than max_model (${caps.max_model})`
    )
  }
  if (defaultIdx < minIdx || defaultIdx > maxIdx) {
    throw new Error(
      `Soul model_capabilities: default_model (${caps.default_model}) is outside min/max range [${caps.min_model}, ${caps.max_model}]`
    )
  }
}

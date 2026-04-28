// Soul validator — schema, semantic, and cross-layer validation
// Runs at compile time before any agent boots. Errors halt compilation; warnings log only.

import type { SoulLayer, ComposedSoul } from "./types.js"
import { ensureModelCapabilitiesConsistent } from "./compiler.js"

export interface ValidationResult {
  valid: boolean
  errors: string[]
  warnings: string[]
}

// Schema validation — check required fields and types
function validateSchema(layer: SoulLayer, layerName: string): { errors: string[]; warnings: string[] } {
  const errors: string[] = []
  const warnings: string[] = []

  if (layer.identity) {
    if (typeof layer.identity.name !== "string" || layer.identity.name.trim() === "") {
      errors.push(`[${layerName}] identity.name is required and must be a non-empty string`)
    }
    if (layer.identity.role && !["orchestrator", "lead", "coder", "reviewer", "expert", "worker", "heartbeat"].includes(layer.identity.role)) {
      warnings.push(`[${layerName}] identity.role "${layer.identity.role}" is not a known role`)
    }
  }

  if (layer.capabilities) {
    const cap = layer.capabilities
    if (cap.invocation && !["sdk", "cli"].includes(cap.invocation)) {
      errors.push(`[${layerName}] capabilities.invocation must be "sdk" or "cli"`)
    }
    if (cap.max_tool_turns !== undefined && (cap.max_tool_turns < 0 || !Number.isInteger(cap.max_tool_turns))) {
      errors.push(`[${layerName}] capabilities.max_tool_turns must be a non-negative integer`)
    }
  }

  if (layer.model_capabilities) {
    const mc = layer.model_capabilities
    const validTiers = ["haiku", "sonnet", "opus"]
    if (mc.min_model && !validTiers.includes(mc.min_model)) {
      errors.push(`[${layerName}] model_capabilities.min_model must be one of: ${validTiers.join(", ")}`)
    }
    if (mc.default_model && !validTiers.includes(mc.default_model)) {
      errors.push(`[${layerName}] model_capabilities.default_model must be one of: ${validTiers.join(", ")}`)
    }
    if (mc.max_model && !validTiers.includes(mc.max_model)) {
      errors.push(`[${layerName}] model_capabilities.max_model must be one of: ${validTiers.join(", ")}`)
    }
  }

  return { errors, warnings }
}

// Semantic validation — check for logical contradictions within a composed soul
function validateSemantics(soul: ComposedSoul): { errors: string[]; warnings: string[] } {
  const errors: string[] = []
  const warnings: string[] = []

  // Same rule in must AND must_not
  const mustRules = new Set(soul.rules.must.map((r) => r.rule))
  for (const r of soul.rules.must_not) {
    if (mustRules.has(r.rule)) {
      errors.push(`Rule conflict: "${r.rule}" appears in both must and must_not`)
    }
  }

  // Capability contradiction: tools include bash-like tools but can_run_commands = false
  const bashTools = ["bash", "sh", "zsh", "fish", "cmd", "execute_command", "run_command"]
  if (!soul.capabilities.can_run_commands) {
    const conflictingTools = soul.capabilities.tools.filter((t) => bashTools.includes(t.toLowerCase()))
    if (conflictingTools.length > 0) {
      errors.push(
        `Capability conflict: can_run_commands is false but tools includes: ${conflictingTools.join(", ")}. Add them to disallowed_tools instead.`
      )
    }
  }

  // Tools present in both allowed and disallowed
  const disallowed = new Set(soul.capabilities.disallowed_tools)
  const conflictTools = soul.capabilities.tools.filter((t) => disallowed.has(t))
  if (conflictTools.length > 0) {
    errors.push(`Tool conflict: ${conflictTools.join(", ")} appear in both tools and disallowed_tools`)
  }

  // SDK with can_run_commands = true — unusual, warn
  if (soul.capabilities.invocation === "sdk" && soul.capabilities.can_run_commands) {
    warnings.push(
      `SDK agent with can_run_commands=true is unusual. SDK agents typically don't have shell access.`
    )
  }

  // max_tool_turns = 0 but tools are listed — likely unintentional
  if (soul.capabilities.max_tool_turns === 0 && soul.capabilities.tools.length > 0) {
    warnings.push(
      `max_tool_turns is 0 (no tool use allowed) but tools are listed: ${soul.capabilities.tools.join(", ")}. These tools will be ignored.`
    )
  }

  // fresh_context + include_summary is contradictory
  const strategy = soul.capabilities.context_strategy
  if (strategy?.fresh_context === true && strategy?.include_summary === true) {
    warnings.push(
      "Context strategy contradiction: fresh_context=true discards all history, but include_summary=true tries to include prior summary. " +
      "Set include_summary=false when using fresh_context."
    )
  }

  // Model capabilities range
  try {
    ensureModelCapabilitiesConsistent(soul.model_capabilities)
  } catch (err) {
    errors.push(String(err))
  }

  return { errors, warnings }
}

// Cross-layer validation — check for layer violations
// Takes the raw layers before merge to catch override attempts
export function validateLayers(
  layers: { name: string; layer: SoulLayer }[],
): ValidationResult {
  const errors: string[] = []
  const warnings: string[] = []

  // Collect global rules from earlier (higher-priority) layers
  const globalMustNot = new Set<string>()
  const globalMust = new Set<string>()

  for (let i = 0; i < layers.length; i++) {
    const { name, layer } = layers[i]

    // Schema check per layer
    const schemaResult = validateSchema(layer, name)
    errors.push(...schemaResult.errors)
    warnings.push(...schemaResult.warnings)

    // Check if this layer tries to override a global rule from a previous layer
    if (i > 0) {
      // Check must_not rules
      for (const entry of layer.rules?.must ?? []) {
        const rule = typeof entry === "string" ? entry : entry.rule
        if (globalMustNot.has(rule)) {
          errors.push(
            `[${name}] Cannot override global rule in must_not: "${rule}" — global rules cannot be relaxed`
          )
        }
      }
      // Check must rules
      for (const entry of layer.rules?.must_not ?? []) {
        const rule = typeof entry === "string" ? entry : entry.rule
        if (globalMust.has(rule)) {
          errors.push(
            `[${name}] Cannot override global rule in must: "${rule}" — global rules cannot be relaxed`
          )
        }
      }

      // Check capability expansions — agent cannot expand beyond instance's explicit restrictions
      const prevCap = layers[0].layer.capabilities
      const thisCap = layer.capabilities
      if (prevCap && thisCap) {
        if (prevCap.can_write_files === false && thisCap.can_write_files === true) {
          errors.push(`[${name}] Cannot expand can_write_files — instance layer explicitly restricts it`)
        }
        if (prevCap.can_run_commands === false && thisCap.can_run_commands === true) {
          errors.push(`[${name}] Cannot expand can_run_commands — instance layer explicitly restricts it`)
        }
      }
    }

    // Collect global rules from this layer for subsequent layer checks
    for (const entry of layer.rules?.must_not ?? []) {
      const normalized = typeof entry === "string" ? { rule: entry, scope: "agent" } : entry
      if (normalized.scope === "global") globalMustNot.add(normalized.rule)
    }
    for (const entry of layer.rules?.must ?? []) {
      const normalized = typeof entry === "string" ? { rule: entry, scope: "agent" } : entry
      if (normalized.scope === "global") globalMust.add(normalized.rule)
    }
  }

  return { valid: errors.length === 0, errors, warnings }
}

// Full validation of a composed soul
export function validateComposedSoul(soul: ComposedSoul): ValidationResult {
  const errors: string[] = []
  const warnings: string[] = []

  if (!soul.identity.name || soul.identity.name.trim() === "") {
    errors.push("Composed soul is missing identity.name")
  }

  const semantic = validateSemantics(soul)
  errors.push(...semantic.errors)
  warnings.push(...semantic.warnings)

  return { valid: errors.length === 0, errors, warnings }
}

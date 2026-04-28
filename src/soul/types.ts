// Soul system — type definitions
// Agent identity, capabilities, model routing, and instrumentation

export type ModelTier = "haiku" | "flash-lite" | "flash" | "sonnet" | "opus"
export type RelativeTier = "min" | "default" | "max"
export type InvocationMode = "sdk" | "cli"

// --- Identity ---

export interface SoulIdentity {
  name: string
  role?: string
  archetype?: string
  tone?: string
  pronouns?: string
}

// --- Voice / Personality ---

export interface SoulVoice {
  description?: string
  traits?: string[]
  quirks?: string[]
  example_phrases?: string[]
}

// --- Capabilities ---

export interface SoulContextStrategy {
  history_budget_ratio?: number
  max_messages?: number
  include_summary?: boolean
  strip_code_blocks?: boolean
  fresh_context?: boolean
  /** Max tokens of injected context from previous sessions (default: 1000) */
  context_budget?: number
  /**
   * Context loading mode:
   * - "history" (default): load token-bounded raw message history
   * - "inject": load only last N messages (inject_recency), rely on summary + graph memory in system prompt
   */
  context_mode?: "history" | "inject"
  /** Number of recent messages to include in "inject" mode (default: 3) */
  inject_recency?: number
}

export interface SoulCapabilities {
  invocation?: InvocationMode
  tools?: string[]
  disallowed_tools?: string[]
  mcp_tools?: string[]
  can_delegate?: boolean
  can_read_files?: boolean
  can_write_files?: boolean
  can_run_commands?: boolean
  allowed_directories?: string[]
  max_tool_turns?: number
  context_strategy?: SoulContextStrategy
}

// --- Rules ---

export interface ScopedRule {
  rule: string
  scope?: "global" | "agent"
}

export type RuleEntry = string | ScopedRule

export interface SoulRules {
  must?: RuleEntry[]
  must_not?: RuleEntry[]
  guidelines?: string[]
}

// --- Context ---

export interface SoulRelationship {
  name: string
  role?: string
  notes?: string
}

export interface SoulContext {
  domains?: string[]
  relationships?: SoulRelationship[]
  instance_notes?: string
}

// --- Model capabilities ---

export interface ModelCapabilities {
  min_model?: ModelTier
  default_model?: ModelTier
  max_model?: ModelTier
}

// --- Soul layer (a single inheritance layer: instance | role | agent) ---

export interface SoulLayer {
  identity?: SoulIdentity
  voice?: SoulVoice
  capabilities?: SoulCapabilities
  rules?: SoulRules
  context?: SoulContext
  model_capabilities?: ModelCapabilities
  claude_md?: string[]
  /** Custom sections (e.g. frontend_design, systematic_debugging) — rendered as-is into system prompt */
  [key: string]: unknown
}

// Required capabilities with context_strategy remaining optional
// (context_strategy is set only when a soul file defines it; undefined = use global defaults)
export type RequiredCapabilities = Omit<Required<SoulCapabilities>, "context_strategy"> & Pick<SoulCapabilities, "context_strategy">

// --- Compiled defaults (most permissive starting point) ---

export const DEFAULT_CAPABILITIES: RequiredCapabilities = {
  invocation: "sdk",
  tools: [],
  disallowed_tools: [],
  mcp_tools: [],
  can_delegate: true,
  can_read_files: true,
  can_write_files: true,
  can_run_commands: true,
  allowed_directories: [],
  max_tool_turns: 9999,
  context_strategy: undefined,
}

export const DEFAULT_MODEL_CAPABILITIES: Required<ModelCapabilities> = {
  min_model: "haiku",
  default_model: "sonnet",
  max_model: "opus",  // most permissive starting point — soul layers restrict down
}

// --- ComposedSoul (result of merging all layers) ---

export interface ComposedSoul {
  identity: SoulIdentity & { name: string }
  voice?: SoulVoice
  capabilities: RequiredCapabilities
  rules: {
    must: ScopedRule[]
    must_not: ScopedRule[]
    guidelines: string[]
  }
  context: SoulContext
  model_capabilities: Required<ModelCapabilities>
  /** Custom sections from soul YAML, keyed by section name */
  extras: Record<string, unknown>
  /** Compiled .claude/CLAUDE.md lines (auto-generated from role + capabilities, plus explicit claude_md from layers) */
  claude_md: string[]
}

// --- Model tier ordering and registry ---

export const MODEL_TIER_ORDER: ModelTier[] = ["haiku", "flash-lite", "flash", "sonnet", "opus"]

// Maps tier names to concrete model IDs — single source of truth for tier → model resolution
export const MODEL_TIER_REGISTRY: Record<ModelTier, string> = {
  haiku: "claude-haiku-4-5-20251001",
  "flash-lite": "deepseek/deepseek-v3.2",
  flash: "deepseek/deepseek-v3.2",
  sonnet: "claude-sonnet-4-6",
  opus: "claude-opus-4-6",
}

// --- Routing instrumentation ---

export interface RoutingDecision {
  task_id: string
  agent: string
  hint_model: ModelTier
  resolved_model: ModelTier
  task_type: string
  estimated_complexity: number
}

export interface TaskOutcome {
  task_id: string
  actual_tokens: number
  actual_files_touched: number
  duration_ms: number
  success: boolean
  retried: boolean
  upgrade_requested: boolean
}

// --- Mid-task model upgrade ---

export interface UpgradeRequest {
  agent: string
  task_id: string
  current_model: ModelTier
  requested_model: ModelTier
  reason: string
  context: {
    files_affected: number
    estimated_remaining_tokens: number
  }
}

export interface UpgradeResponse {
  approved: boolean
  granted_model: ModelTier
  budget_remaining: number
}

// --- Complexity classifier output ---

export interface ComplexityResult {
  tier: RelativeTier
  confidence: number
  signals: string[]
}

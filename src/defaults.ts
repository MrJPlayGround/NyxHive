import type { ProviderName, TaskType, EffortLevel } from "./providers/types.js";

export const DEFAULT_OLLAMA_URL = "http://localhost:11434";
export const DEFAULT_LOCAL_CLASSIFIER_MODEL = "llama3.2:3b";

// --- Trivial responses (no LLM needed) ---

export const DEFAULT_TRIVIAL_RESPONSES: Record<string, string> = {
  ok: "ok",
  thanks: "You're welcome!",
  "thank you": "You're welcome!",
  ty: "np!",
  thx: "np!",
  k: "ok",
  cool: "cool",
  nice: "nice",
};

// --- Few-shot classification examples ---
// Stratified selection from data/routing-dataset.jsonl (1,000 examples)
// Covers all task types, all tiers, trap cases, and context-dependent prompts

export const FEW_SHOT_EXAMPLES: Array<{ prompt: string; task_type: string; tier: number }> = [
  // TRIVIAL (T1)
  { prompt: "ok", task_type: "trivial", tier: 1 },
  { prompt: "lgtm, ship it", task_type: "trivial", tier: 1 },
  // SIMPLE_QA (T1, T2)
  { prompt: "what's the capital of Portugal?", task_type: "simple_qa", tier: 1 },
  { prompt: "what's the difference between let and const in javascript?", task_type: "simple_qa", tier: 2 },
  // CONVERSATION (T2) — including context-dependent
  { prompt: "good morning! ready to build some features today?", task_type: "conversation", tier: 2 },
  { prompt: "can you remind me what we discussed yesterday about the auth module?", task_type: "conversation", tier: 2 },
  { prompt: "why", task_type: "conversation", tier: 2 },
  { prompt: "elaborate", task_type: "conversation", tier: 2 },
  // ANALYSIS (T3) — including short-but-complex trap
  { prompt: "is this approach scalable?", task_type: "analysis", tier: 3 },
  { prompt: "compare this to how we did it before", task_type: "analysis", tier: 3 },
  // CODING — full tier range (T1-T4), traps, context-dependent
  { prompt: "fix the typo in the error message on line 42", task_type: "coding", tier: 1 },
  { prompt: "write a function that validates email addresses", task_type: "coding", tier: 2 },
  { prompt: "add a retry mechanism to the API client with exponential backoff", task_type: "coding", tier: 3 },
  { prompt: "implement the thread API with CRUD operations, SQLite storage, and per-thread SSE streaming", task_type: "coding", tier: 4 },
  // CODING traps — short/vague but actually complex
  { prompt: "clean up the codebase", task_type: "coding", tier: 3 },
  { prompt: "add tests", task_type: "coding", tier: 3 },
  { prompt: "handle edge cases", task_type: "coding", tier: 3 },
  { prompt: "write a test for it", task_type: "coding", tier: 3 },
  { prompt: "add error handling to that", task_type: "coding", tier: 2 },
  // CODE_REVIEW (T3, T4)
  { prompt: "check this PR for any obvious bugs or issues", task_type: "code_review", tier: 3 },
  // EXPERT (T3, T4) — including traps
  { prompt: "what's the best way to handle graceful shutdown when agents are mid-execution?", task_type: "expert", tier: 3 },
  { prompt: "make it production-ready", task_type: "expert", tier: 4 },
  { prompt: "make it secure", task_type: "expert", tier: 4 },
  // RESEARCH (T2, T3)
  { prompt: "search for how to implement WebSocket reconnection in TypeScript", task_type: "research", tier: 2 },
  { prompt: "investigate why our SSE connections drop after 60 seconds on Cloudflare", task_type: "research", tier: 3 },
  // SUMMARIZATION (T2, T3) — including trap
  { prompt: "turn these rough notes into a clean project brief", task_type: "summarization", tier: 3 },
  // LONG_CONTEXT (T3)
  { prompt: "Read through all 15 test files and tell me which areas have insufficient coverage", task_type: "long_context", tier: 3 },
  // WORKER_SUBTASK (T1, T2)
  { prompt: "extract the user's email from this API response and format it", task_type: "worker_subtask", tier: 1 },
  { prompt: "generate a commit message for these changes: added retry logic to API client, fixed timeout handling", task_type: "worker_subtask", tier: 2 },
  // ORCHESTRATOR (T4) — including traps
  { prompt: "[@analyst: research WebSocket reconnection strategies]", task_type: "orchestrator", tier: 4 },
  { prompt: "tell analyst to look into it", task_type: "orchestrator", tier: 4 },
];

// --- Classification patterns ---

export const DEFAULT_CLASSIFICATION = {
  trivial: String.raw`^(ok|thanks|thank you|ty|thx|k|sure|cool|nice|got it|yes|no|yep|nope)\.?$`,
  coding: String.raw`\b(codebase|code review|source code|function|implement(?:s|ed|ing)?|refactor|debug(?:ging)?|fix bug|write a script|add tests?|typescript|python|javascript|sql query|regex|api endpoint|database schema|build (?:error|fail|step)|working directory)\b`,
  research: String.raw`\b(research|investigate|look into|dig into|find out about|what do you know about|tell me about|explore the|learn about|study)\b`,
  search: String.raw`\b(search|find|look up|what is|who is|when did|latest|news|price of)\b`,
  summary: String.raw`\b(summarize|summary|tldr|tl;dr|recap|brief)\b`,
  analysis: String.raw`\b(analyze|analyse|compare|evaluate|pros and cons|trade.?offs?|deep dive|break down|assess|implications|impact of|advantages|disadvantages)\b`,
  expert: String.raw`\b(architect(ure)?|design pattern|best practice|strateg(y|ic)|how should (i|we) approach|what.?s the best way to|make it secure|make it production-ready|philosophy|theory|framework for|principles of)\b`,
  orchestrator: String.raw`\b(organize|coordinate|manage|set(?:\s+(?:it|this|that|them))?\s+up|configure|deploy|develop .+ for yourself|learn .+ systems?|build .+ (pipeline|workflow|structure)|orchestrat)\b`,
};

// --- Routing table ---

// Routing table: maps task type → optimal provider/model + fallback
// Benchmarked 2026-03-01 — MiMo v2 Flash scored 4.9/5 across heartbeat/classification/scout tasks
//
// $220/mo stack:
//   OpenRouter  ~$20/mo  → trivial, classification, conversation, simple_qa, research, summarization, long_context, worker_subtask
//   Anthropic   $200/mo  → analysis, expert, coding, code_review, orchestrator (Max sub)
// Fallbacks: Anthropic routes fall to OpenRouter; OpenRouter routes fall to alternate OR models.
export const DEFAULT_ROUTING_TABLE: Record<
  TaskType,
  { provider: ProviderName; model: string; maxTokens: number; fallback?: { provider: ProviderName; model: string } }
> = {
  trivial:        { provider: "ollama",      model: "gemma3:4b",                      maxTokens: 256,  fallback: { provider: "openrouter",  model: "deepseek/deepseek-v3.2" } },
  classification: { provider: "openrouter", model: "xiaomi/mimo-v2-flash",             maxTokens: 50,   fallback: { provider: "openrouter",  model: "deepseek/deepseek-v3.2" } },
  simple_qa:      { provider: "openrouter", model: "deepseek/deepseek-v3.2",           maxTokens: 2048, fallback: { provider: "openrouter",  model: "xiaomi/mimo-v2-flash" } },
  conversation:   { provider: "openrouter", model: "qwen/qwen3-235b-a22b-2507",       maxTokens: 4096, fallback: { provider: "anthropic",   model: "claude-haiku-4-5-20251001" } },
  analysis:       { provider: "anthropic",  model: "claude-sonnet-4-6",                maxTokens: 4096, fallback: { provider: "openrouter",  model: "deepseek/deepseek-v3.2" } },
  coding:         { provider: "anthropic",  model: "claude-sonnet-4-6",                maxTokens: 8192, fallback: { provider: "anthropic",   model: "claude-haiku-4-5-20251001" } },
  code_review:    { provider: "anthropic",  model: "claude-sonnet-4-6",                maxTokens: 4096, fallback: { provider: "anthropic",   model: "claude-haiku-4-5-20251001" } },
  expert:         { provider: "anthropic",  model: "claude-opus-4-6",                  maxTokens: 4096, fallback: { provider: "anthropic",   model: "claude-sonnet-4-6" } },
  research:       { provider: "openrouter", model: "deepseek/deepseek-v3.2",           maxTokens: 4096, fallback: { provider: "openrouter",  model: "xiaomi/mimo-v2-flash" } },
  summarization:  { provider: "openrouter", model: "deepseek/deepseek-v3.2",           maxTokens: 2048, fallback: { provider: "openrouter",  model: "xiaomi/mimo-v2-flash" } },
  long_context:   { provider: "openrouter", model: "deepseek/deepseek-v3.2",           maxTokens: 8192, fallback: { provider: "openrouter",  model: "xiaomi/mimo-v2-flash" } },
  worker_subtask: { provider: "ollama",      model: "gemma3:4b",                      maxTokens: 2048, fallback: { provider: "openrouter",  model: "xiaomi/mimo-v2-flash" } },
  orchestrator:   { provider: "anthropic",  model: "claude-opus-4-6",                  maxTokens: 16384, fallback: { provider: "anthropic",   model: "claude-sonnet-4-6" } },
};

// --- Fallback order ---

// openrouter intentionally excluded — cheap model output is worse than a blocked task
export const DEFAULT_FALLBACK_ORDER: ProviderName[] = ["anthropic", "openai"];

// --- Cost rates ($ per million tokens) ---

export const DEFAULT_COST_RATES: Record<string, { input: number; cachedInput?: number; output: number }> = {
  "claude-opus-4-6":                { input: 5, output: 25 },    // Max sub ($200/mo flat)
  "claude-sonnet-4-6":              { input: 3, output: 15 },   // Max sub ($200/mo flat)
  "claude-haiku-4-5-20251001":      { input: 0.8, output: 4 },  // Max sub ($200/mo flat)
  "google/gemini-2.5-flash":        { input: 0.30, output: 2.50 },
  "google/gemini-2.5-flash-lite":   { input: 0.10, output: 0.40 },
  "google/gemini-2.0-flash-lite-001": { input: 0.075, output: 0.30 },
  "google/gemini-2.5-pro":          { input: 1.25, output: 10 },
  "deepseek/deepseek-v3.2":         { input: 0.26, output: 0.38 },  // Routing primary for cheap tasks
  "openai/gpt-oss-120b":            { input: 0.039, output: 0.19 }, // Memory extraction (cheapest paid)
  "qwen/qwen3-235b-a22b-2507":     { input: 0.071, output: 0.10 },
  "xiaomi/mimo-v2-flash":           { input: 0.09, output: 0.29 },
  "mistralai/mistral-medium-3":     { input: 0.40, output: 2.00 },
  "meta-llama/llama-4-maverick":    { input: 0.20, output: 0.60 },
  // Local Ollama models
  [DEFAULT_LOCAL_CLASSIFIER_MODEL]: { input: 0, output: 0 },
  "gemma3:4b":                      { input: 0, output: 0 },
  // OpenAI models (current as of March 2026)
  "gpt-5.5":                        { input: 2.5, cachedInput: 0.25, output: 15 },
  "gpt-5.4":                        { input: 2.5, cachedInput: 0.25, output: 15 },
  "gpt-5.4-pro":                    { input: 30, output: 180 },
  "gpt-5-mini":                     { input: 0.125, cachedInput: 0.0125, output: 1 },
  "gpt-5-nano":                     { input: 0.025, cachedInput: 0.0025, output: 0.2 },
};

// --- Billing type resolution ---
// Claude CLI runs on Max subscription ($200/mo flat); API/SDK paths pay per-token.
export type BillingType = "subscription" | "api" | "free";

export function getBillingType(method: string, model?: string): BillingType {
  if (method === "cli") return "subscription";
  if (!model) return "api";
  const rates = DEFAULT_COST_RATES[model];
  if (rates && rates.input === 0 && rates.output === 0) return "free";
  return "api";
}

// --- Model quality tiers (higher = smarter) ---
// Used by min_model floor: if routed model tier < agent's min_model tier, upgrade

export const MODEL_TIERS: Record<string, number> = {
  // Tier 1: cheap/fast — good for trivial tasks
  "deepseek/deepseek-v3.2":          1,
  "google/gemini-2.0-flash-lite-001": 1,
  "google/gemini-2.5-flash-lite":     1,
  // Tier 2: mid — decent reasoning, structured output
  // MiMo v2 Flash: benchmarked 4.9/5 across heartbeat/classification/scout (2026-03-01)
  "xiaomi/mimo-v2-flash":             2,
  "google/gemini-2.5-flash":          2,
  "qwen/qwen3-235b-a22b-2507":       2,
  "claude-haiku-4-5-20251001":        2,
  "meta-llama/llama-4-maverick":      2,
  [DEFAULT_LOCAL_CLASSIFIER_MODEL]:   1,
  "gemma3:4b":                        1,
  // Tier 3: strong — reliable reasoning and instruction following
  "claude-sonnet-4-6":                3,
  "google/gemini-2.5-pro":            3,
  "mistralai/mistral-medium-3":       3,
  // Tier 4: top — best available
  "claude-opus-4-6":                  4,
  // OpenAI models (current as of March 2026)
  "gpt-5-nano":                       1,
  "gpt-5-mini":                       2,
  "gpt-5.5":                          4,
  "gpt-5.4":                          4,
  "gpt-5.4-pro":                      4,
};

export function getModelTier(model: string): number {
  return MODEL_TIERS[model] ?? 2; // unknown models default to tier 2
}

// --- Orchestrator model hints ---
// Hints used in delegation tags: [@agent(hint): task]
// "light" and "heavy" are abstract tiers; named aliases resolve to specific models.
const MODEL_HINT_MAP: Record<string, { model: string; provider: ProviderName }> = {
  light:  { model: "claude-haiku-4-5-20251001", provider: "anthropic" },
  heavy:  { model: "claude-opus-4-6",           provider: "anthropic" },
  haiku:  { model: "claude-haiku-4-5-20251001", provider: "anthropic" },
  sonnet: { model: "claude-sonnet-4-6",         provider: "anthropic" },
  opus:   { model: "claude-opus-4-6",           provider: "anthropic" },
  flash:  { model: "deepseek/deepseek-v3.2",    provider: "openrouter" },
  gpt5:   { model: "gpt-5.5",                   provider: "openai" },
};

/**
 * Resolve an orchestrator model hint to a concrete model + provider.
 * Returns undefined for unknown hints (agent's default model will be used).
 */
export function resolveModelHint(hint: string): { model: string; provider: ProviderName } | undefined {
  return MODEL_HINT_MAP[hint.toLowerCase()];
}

/**
 * Convert a hint string to a ModelTier for use with resolveModel's clamping.
 * Returns undefined for hints that don't map cleanly to a tier.
 */
export function hintToModelTier(hint: string): import("./soul/types.js").ModelTier | undefined {
  const HINT_TIER_MAP: Record<string, import("./soul/types.js").ModelTier> = {
    light: "haiku",
    heavy: "opus",
    haiku: "haiku",
    sonnet: "sonnet",
    opus: "opus",
    flash: "flash",
  };
  return HINT_TIER_MAP[hint.toLowerCase()];
}

// --- Default effort levels by agent role ---
// Orchestrators need high quality for planning/routing decisions.
// Workers save tokens with low effort — simple subtasks don't need deep reasoning.
export const DEFAULT_EFFORT_BY_ROLE: Record<string, EffortLevel> = {
  orchestrator: "high",
  lead: "high",
  coder: "medium",
  reviewer: "medium",
  expert: "high",
  worker: "low",
  heartbeat: "low",
};

/**
 * Resolve effort level: explicit agent config > role-based default > undefined (omit).
 * Returns undefined for non-Claude models (effort is only sent to supported models).
 */
export function getEffortForAgent(
  agentEffort: EffortLevel | undefined,
  role: string | undefined,
): EffortLevel | undefined {
  return agentEffort ?? (role ? DEFAULT_EFFORT_BY_ROLE[role] : undefined);
}

// --- CLI escalation defaults ---

// Only tasks that need tool use (file editing, code execution) go to CLI.
// analysis/expert need a smarter model, not tools — they go through Client SDK.
export const DEFAULT_CLI_ESCALATION_TASKS: TaskType[] = [
  "coding", "code_review",
];

// --- Actor model limits ---

export const ACTOR_MAX_DEPTH = 5;
export const ACTOR_MAX_MESSAGES = 15;
export const AGENT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes per agent invocation (CLI agents need this; SDK agents finish in seconds)
export const ORCHESTRATOR_MAX_TURNS = 3; // max re-entry turns for sequential delegation

// --- Ralph loop ---
export const RALPH_MAX_ROUNDS = 10;       // max autonomous iterations before forced stop
export const RALPH_MAX_SAME_ERRORS = 3;   // stop if same error recurs this many times

// --- Delegation depth ---
export const MAX_DELEGATION_DEPTH = 1;    // depth 0 = top-level lead dispatch, depth >= 1 = reject re-delegation

// --- Category-based model routing ---
import type { ModelCategory } from "./types.js";

export const CATEGORY_MODEL_MAP: Record<ModelCategory, { provider: ProviderName; model: string }> = {
  frontier: { provider: "anthropic",  model: "claude-opus-4-6" },
  deep:     { provider: "anthropic",  model: "claude-sonnet-4-6" },
  quick:    { provider: "openrouter", model: "deepseek/deepseek-v3.2" },
  visual:   { provider: "anthropic",  model: "claude-sonnet-4-6" },
};

// --- Budget defaults ---

export const BUDGET_MONTHLY = 240;
export const BUDGET_MONTHLY_WARN = BUDGET_MONTHLY * 0.8; // $192
export const BUDGET_DAILY_WARN = (BUDGET_MONTHLY / 30) * 0.8; // ~$6.40
export const BUDGET_CHECK_INTERVAL_MS = 5 * 60 * 1000; // check every 5 minutes

// --- Configurable budget helpers ---

export interface BudgetConfig {
  monthly_limit?: number;
  warning_threshold?: number;
  daily_limit?: number;
  per_conversation_warn?: number;
}

export function getBudgetConfig(config?: BudgetConfig) {
  const monthly = config?.monthly_limit ?? 0;
  const warnThreshold = config?.warning_threshold ?? 0.8;
  const dailyLimit = config?.daily_limit ?? (monthly > 0 ? monthly / 30 : 0);
  return {
    monthly,
    dailyLimit,
    monthlyWarn: monthly > 0 ? monthly * warnThreshold : Number.POSITIVE_INFINITY,
    dailyWarn: dailyLimit > 0 ? dailyLimit * warnThreshold : Number.POSITIVE_INFINITY,
    perConversationWarn: config?.per_conversation_warn ?? 1.00,
  };
}

export interface MemoryConfig {
  extraction_interval?: number;
  graph_briefing_max_nodes?: number;
  graph_decay_interval_ms?: number;
  graph_prune_min_importance?: number;
}

export function getMemoryConfig(config?: MemoryConfig) {
  return {
    extractionInterval: config?.extraction_interval ?? 5,
    graphBriefingMaxNodes: config?.graph_briefing_max_nodes ?? 20,
    graphDecayIntervalMs: config?.graph_decay_interval_ms ?? 21600000,
    graphPruneMinImportance: config?.graph_prune_min_importance ?? 0.05,
  };
}

// --- Graph memory defaults ---

export const EXTRACTION_INTERVAL = 5; // Extract memories every N messages
export const GRAPH_BRIEFING_MAX_NODES = 20; // Max nodes in briefing
export const GRAPH_DECAY_INTERVAL_MS = 6 * 60 * 60 * 1000; // Decay importance every 6 hours
export const GRAPH_PRUNE_MIN_IMPORTANCE = 0.05; // Prune nodes below this score

// --- Model context windows (tokens) ---

export const MODEL_CONTEXT_WINDOWS: Record<string, number> = {
  "claude-opus-4-6":                  200_000,
  "claude-sonnet-4-6":                200_000,
  "claude-haiku-4-5-20251001":        200_000,
  "google/gemini-2.5-flash":        1_000_000,
  "google/gemini-2.5-flash-lite":   1_000_000,
  "google/gemini-2.5-pro":          1_000_000,
  "google/gemini-2.0-flash-lite-001": 1_000_000,
  "deepseek/deepseek-v3.2":            163_000,
  "qwen/qwen3-235b-a22b-2507":        130_000,
  "xiaomi/mimo-v2-flash":             128_000,
  "mistralai/mistral-medium-3":       131_000,
  "meta-llama/llama-4-maverick":    1_000_000,
  // OpenAI models (current as of March 2026)
  "gpt-5.5":                        1_050_000,
  "gpt-5.4":                        1_050_000,
  "gpt-5.4-pro":                    1_050_000,
  "gpt-5-mini":                       200_000,
  "gpt-5-nano":                       200_000,
};

export function getContextWindow(model: string): number {
  return MODEL_CONTEXT_WINDOWS[model] ?? 200_000;
}

// --- Queue defaults ---

export const MAX_RETRIES = 3;
export const CLAIM_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
export const POLL_INTERVAL_MS = 2000;

// --- Agent chain & context constants ---

/** Characters to show when truncating a response excerpt for display */
export const RESPONSE_EXCERPT_CHARS = 500;

/** Max characters for a work log task entry */
export const WORK_LOG_TASK_MAX_CHARS = 500;

/** Max characters for a work log result entry */
export const WORK_LOG_RESULT_MAX_CHARS = 4000;

/** Delegation task preview length in SSE events */
export const DELEGATION_TASK_PREVIEW_CHARS = 200;

/** Warn when a delegation task string exceeds this length (likely inline content) */
export const DELEGATION_CONTENT_WARN_CHARS = 1000;

/** Delegation response format: max chars for subtask header */
export const SUBTASK_RESPONSE_EXCERPT_CHARS = 500;

// --- SSE & heartbeat intervals ---

/** SSE heartbeat interval to keep connections alive (used in SSE stream + CLI heartbeat) */
export const SSE_HEARTBEAT_INTERVAL_MS = 30_000;

// --- Dedup windows ---

/** Cross-channel message dedup window */
export const CROSS_CHANNEL_DEDUP_WINDOW_MS = 60_000;

/** MCP send_message cross-channel dedup window */
export const MCP_DEDUP_WINDOW_MS = 60_000;

/** Learning error dedup window (24 hours) */
export const LEARNING_DEDUP_WINDOW_MS = 24 * 3600 * 1000;

// --- Request timeouts ---

/** iOS channel sync request timeout (5 minutes — delegation needs more time) */
export const IOS_REQUEST_TIMEOUT_MS = 300_000;

/** Default sync request timeout (5 minutes) */
export const DEFAULT_REQUEST_TIMEOUT_MS = 300_000;

/** Relay channel sync request timeout (115s — gives server time to respond before MCP client's 130s abort) */
export const RELAY_SYNC_TIMEOUT_MS = 115_000;

// --- Subagent monitoring ---

/** Warn when a subagent (Agent tool call) runs longer than this */
export const SUBAGENT_WARN_THRESHOLD_MS = 120_000;

// --- Idle discovery ---

/** How long the queue must be idle before triggering a scout task */
export const IDLE_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

/** Minimum cooldown between idle discovery triggers */
export const IDLE_COOLDOWN_MS = 2 * 60 * 60 * 1000; // 2 hours

/** Max fraction of daily budget that can be spent on autonomous/idle work */
export const AUTONOMOUS_BUDGET_CEILING = 0.8;

// --- Circuit breaker ---

/** Circuit breaker failure tracking window */
export const CIRCUIT_BREAKER_WINDOW_MS = 60_000;

/** Circuit breaker cooldown before recovery probe */
export const CIRCUIT_BREAKER_COOLDOWN_MS = 60_000;

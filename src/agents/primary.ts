import type { AgentConfig, NyxHiveConfig } from "../types.js";
import type { TaskType } from "../providers/types.js";

type AgentLike = Pick<AgentConfig, "provider" | "model" | "role" | "cli_fallback" | "always_cli" | "effort">;

export type MainBrain = "anthropic";

/** Per-task-type brain specification. */
export interface BrainSpec {
  provider: string;
  model: string;
  cli_fallback: string;
}

/** Dual-brain config — routes coding tasks to one brain, conversational to another. */
export interface DualBrainConfig {
  primary: MainBrain;
  coding: BrainSpec;
  conversation: BrainSpec;
}

type MainBrainEnv = Record<string, string | undefined>;

/** Task types that route to the coding brain. */
const CODING_TASK_TYPES: Set<TaskType> = new Set(["coding", "code_review"]);

/**
 * Task types that route to the conversation brain.
 * - conversation, analysis, expert, orchestrator: reasoning-heavy, Opus excels here
 * - research, summarization, long_context: these are reasoning/comprehension tasks, not coding
 * Everything else (trivial, simple_qa, classification, worker_subtask) uses the primary brain.
 */
const CONVERSATION_TASK_TYPES: Set<TaskType> = new Set([
  "conversation", "analysis", "expert", "orchestrator",
  "research", "summarization", "long_context",
]);

const OPUS_BRAIN: BrainSpec = { provider: "anthropic", model: "claude-opus-4-6", cli_fallback: "claude" };
const SONNET_BRAIN: BrainSpec = { provider: "anthropic", model: "claude-sonnet-4-6", cli_fallback: "claude" };

/**
 * Build a dual-brain config from a resolved MainBrain.
 * Returns undefined if no main brain is set (no --brain flag).
 */
export function buildDualBrainConfig(mainBrain?: MainBrain): DualBrainConfig | undefined {
  if (!mainBrain) return undefined;
  return {
    primary: mainBrain,
    coding: SONNET_BRAIN,
    conversation: OPUS_BRAIN,
  };
}

/**
 * Given a task type and dual-brain config, return the brain spec to use.
 * Falls back to the primary brain's spec for unmatched task types.
 *
 * When classifiedTier is provided, conversation-brain tasks below T4 use Sonnet
 * instead of Opus for cost savings. T4 (expert, complex orchestration) stays Opus.
 */
export function resolveBrainForTask(taskType: TaskType, config: DualBrainConfig, classifiedTier?: number): BrainSpec {
  if (CODING_TASK_TYPES.has(taskType)) return config.coding;
  if (CONVERSATION_TASK_TYPES.has(taskType)) {
    // Tier-aware: only use Opus for T4 tasks. T1-T3 get Sonnet.
    if (classifiedTier !== undefined && classifiedTier < 4) return SONNET_BRAIN;
    return config.conversation;
  }
  // Lightweight tasks (trivial, simple_qa, etc.) — Sonnet is sufficient
  if (classifiedTier !== undefined && classifiedTier < 4) return SONNET_BRAIN;
  return config.conversation;
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, "");
}

function selectLeadCandidate<T extends AgentLike>(entries: Array<[string, T]>): string | undefined {
  const lead = entries.find(([, agent]) => agent.role === "lead" || agent.role === "orchestrator");
  return lead?.[0] ?? entries[0]?.[0];
}

function isAnthropicFamily(agent: AgentLike): boolean {
  return agent.provider === "anthropic"
    || agent.cli_fallback === "claude"
    || agent.model.startsWith("claude-");
}

function applyBrain(agent: AgentConfig, _mainBrain: MainBrain): AgentConfig {
  const next: AgentConfig = { ...agent };
  next.provider = "anthropic";
  next.model = "claude-sonnet-4-6";
  next.cli_fallback = "claude";
  next.always_cli = true;
  next.effort = agent.effort ?? "high";
  return next;
}

export function resolvePrimaryAgentKey<T extends AgentLike>(
  agents: Record<string, T>,
  config?: Pick<NyxHiveConfig["daemon"], "primary_agent">,
): string | undefined {
  const entries = Object.entries(agents);
  if (entries.length === 0) return undefined;

  const explicit = process.env.NYXHIVE_PRIMARY_AGENT?.trim() || config?.primary_agent?.trim();
  if (explicit && agents[explicit]) {
    return explicit;
  }

  return selectLeadCandidate(entries);
}

export function resolveMainBrain(value?: string | null): MainBrain | undefined {
  const normalized = normalize(value ?? "");
  if (!normalized) return undefined;
  // Strip -only suffix for resolution (it only affects dual vs single mode)
  const base = normalized.replace(/-?only$/, "");
  if (["anthropic", "claude", "opus"].includes(base)) return "anthropic";
  return undefined;
}

/** Returns true if the brain value uses the `-only` suffix (single-brain mode). */
export function isSingleBrainMode(value?: string | null): boolean {
  const normalized = normalize(value ?? "");
  return normalized.endsWith("-only");
}

export function applyMainBrainOverride(
  agents: Record<string, AgentConfig>,
  config?: Pick<NyxHiveConfig["daemon"], "primary_agent">,
  explicitBrain?: string,
  env: MainBrainEnv = process.env,
): {
  agents: Record<string, AgentConfig>;
  primaryAgent?: string;
  mainBrain?: MainBrain;
  affectedAgents?: string[];
  dualBrain?: DualBrainConfig;
} {
  const primaryAgent = resolvePrimaryAgentKey(agents, config);
  const effectiveBrain = explicitBrain ?? env.NYXHIVE_MAIN_BRAIN;
  const mainBrain = resolveMainBrain(effectiveBrain);
  const singleBrain = isSingleBrainMode(effectiveBrain);

  if (!primaryAgent || !mainBrain || !agents[primaryAgent]) {
    return { agents, primaryAgent, mainBrain };
  }

  const nextAgents: Record<string, AgentConfig> = { ...agents };
  const affectedAgents = new Set<string>([primaryAgent]);

  nextAgents[primaryAgent] = applyBrain(agents[primaryAgent], mainBrain);

  // Build dual-brain config unless -only mode
  const dualBrain = singleBrain ? undefined : buildDualBrainConfig(mainBrain);

  return {
    primaryAgent,
    mainBrain,
    affectedAgents: [...affectedAgents],
    agents: nextAgents,
    dualBrain,
  };
}

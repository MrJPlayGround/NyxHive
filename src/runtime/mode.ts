import type { TaskType } from "../providers/types.js";

export type RuntimeMode = "conversation" | "agentic" | "hybrid";
export type PromptProfile = "conversation_light" | "agentic_standard" | "agentic_heavy";
export type ProductRuntimeMode = "conversation" | "execution" | "investigation" | "handoff_report" | "reflection" | "federation";

export interface RuntimeModeContract {
  mode: ProductRuntimeMode;
  responseShape: string;
  evidenceExpectation: string;
  verbosityDefault: "short" | "medium" | "detailed";
  memoryBehavior: string;
  waitingStateBehavior: string;
  toolDetailVisibility: "hidden" | "summarized" | "operator_visible";
}

export const RUNTIME_MODE_CONTRACTS: Record<ProductRuntimeMode, RuntimeModeContract> = {
  conversation: {
    mode: "conversation",
    responseShape: "Direct human reply; no workflow preamble or completion evidence scaffold.",
    evidenceExpectation: "Only cite evidence when it materially changes the answer.",
    verbosityDefault: "short",
    memoryBehavior: "Use current durable preferences selectively; do not present procedural memory as personal recall.",
    waitingStateBehavior: "Usually none.",
    toolDetailVisibility: "hidden",
  },
  execution: {
    mode: "execution",
    responseShape: "Outcome first, then compact completion evidence, blockers, and worktree state.",
    evidenceExpectation: "Fresh verification output before success claims.",
    verbosityDefault: "medium",
    memoryBehavior: "Use workflow/procedural memory as constraints, but prefer live repo evidence.",
    waitingStateBehavior: "Show concise progress for long-running work.",
    toolDetailVisibility: "summarized",
  },
  investigation: {
    mode: "investigation",
    responseShape: "Root cause and evidence before proposed fixes.",
    evidenceExpectation: "Separate observed facts from inference.",
    verbosityDefault: "medium",
    memoryBehavior: "Treat prior beliefs as hypotheses until verified.",
    waitingStateBehavior: "Expose what is being inspected when latency is visible.",
    toolDetailVisibility: "operator_visible",
  },
  handoff_report: {
    mode: "handoff_report",
    responseShape: "Structured state transfer: context, decisions, files, verification, next actions.",
    evidenceExpectation: "Include enough exact state for the next agent to resume safely.",
    verbosityDefault: "detailed",
    memoryBehavior: "Include relevant durable decisions and unresolved uncertainty.",
    waitingStateBehavior: "Not applicable.",
    toolDetailVisibility: "operator_visible",
  },
  reflection: {
    mode: "reflection",
    responseShape: "Opinionated analysis with judgment; no execution posture unless explicitly requested.",
    evidenceExpectation: "Use examples sparingly to support the take.",
    verbosityDefault: "medium",
    memoryBehavior: "Use memory for continuity, with uncertainty when inferred.",
    waitingStateBehavior: "None.",
    toolDetailVisibility: "hidden",
  },
  federation: {
    mode: "federation",
    responseShape: "Clear ownership, target, contract, success criteria, and merge-back summary.",
    evidenceExpectation: "Delegation rationale and result integration must be inspectable.",
    verbosityDefault: "medium",
    memoryBehavior: "Keep identity and responsibility boundaries explicit.",
    waitingStateBehavior: "Expose high-level handoff/progress without raw relay noise.",
    toolDetailVisibility: "operator_visible",
  },
};

const CONVERSATION_TASK_TYPES = new Set<string>([
  "trivial",
  "simple_qa",
  "conversation",
  "summarization",
]);

const AGENTIC_TASK_TYPES = new Set<string>([
  "coding",
  "code_review",
  "research",
  "long_context",
  "worker_subtask",
  "orchestrator",
]);

const HEAVY_AGENTIC_TASK_TYPES = new Set<string>([
  "coding",
  "code_review",
  "long_context",
  "orchestrator",
]);

const EXPLICIT_ACTION_PATTERN = /\b(implement|fix|debug|refactor|edit|write|create|add|remove|delete|update|change|patch|run|test|typecheck|build|commit|push|deploy|configure|set(?:\s+(?:it|this|that|them))?\s+up|setup|ensure|make\s+sure|harden|secure|wire|connect|enable|search|browse|look up|research|investigate|review|audit|open|read|inspect|clean|analyze this file|analyse this file)\b/i;
const FILE_REFERENCE_PATTERN = /(?:^|\s)(?:[./~]?[\w.-]+\/[\w./-]+|[\w.-]+\.(?:ts|tsx|js|jsx|json|md|toml|yaml|yml|sql|rs|swift|py|go|css|html|sh|lock)|`[^`]*\.[^`]+`)/i;
const SOCIAL_PATTERN = /^(hi|hello|hey|yo|gm|good morning|good afternoon|good evening|you alive\??|are you there\??|huh|interesting|that'?s annoying|ugh|lol|haha|nice|cool|thanks|thank you|ok|okay|yeah|yep|nope|what do you think\??)$/i;
const AMBIGUOUS_ACTION_FOLLOWUP_PATTERN = /^(do it|same\b.*|go ahead|ship it|run with it|that one|this one)$/i;
const REFLECTIVE_PATTERN = /\b(think|feel|why|should|approach|worth|brittle|architecture|voice|idea|noisy|seems?|looks?|feels?|heart of the thing|too much|cleaner)\b/i;
const LIVE_FACT_QUESTION_PATTERN = /\b(who|what|when|where|which|how much|how many)\b[\s\S]*\b(current|latest|today|tonight|tomorrow|yesterday|right now|now|news|price|weather|schedule|version|ceo|president)\b/i;
const HANDOFF_ARTIFACT_PATTERN = /\b(handoff|handover|brief for the next agent|next agent|handoff report)\b/i;

export interface RuntimeModeInput {
  message?: string;
  taskType?: TaskType | string;
  filePaths?: string[];
  hasFiles?: boolean;
  lastRuntimeMode?: RuntimeMode;
  explicitAction?: boolean;
}

export function hasExplicitActionIntent(message: string | undefined): boolean {
  if (!message) return false;
  return EXPLICIT_ACTION_PATTERN.test(message);
}

export function hasFileReferenceIntent(message: string | undefined, filePaths?: string[]): boolean {
  if (filePaths && filePaths.length > 0) return true;
  if (!message) return false;
  return FILE_REFERENCE_PATTERN.test(message);
}

export function isSocialConversationalTurn(message: string | undefined): boolean {
  const trimmed = message?.trim();
  if (!trimmed) return false;
  if (SOCIAL_PATTERN.test(trimmed)) return true;
  return trimmed.length < 80 && !hasExplicitActionIntent(trimmed) && !hasFileReferenceIntent(trimmed);
}

function hasAmbiguousActionFollowup(message: string | undefined): boolean {
  const trimmed = message?.trim();
  return !!trimmed && AMBIGUOUS_ACTION_FOLLOWUP_PATTERN.test(trimmed);
}

function isReflectiveDiscussionTurn(message: string | undefined): boolean {
  const trimmed = message?.trim();
  return !!trimmed && REFLECTIVE_PATTERN.test(trimmed);
}

function needsFreshExternalEvidence(message: string | undefined): boolean {
  const trimmed = message?.trim();
  return !!trimmed && LIVE_FACT_QUESTION_PATTERN.test(trimmed);
}

function asksForHandoffArtifact(message: string | undefined): boolean {
  const trimmed = message?.trim();
  return !!trimmed && HANDOFF_ARTIFACT_PATTERN.test(trimmed);
}

export function resolveRuntimeMode(input: RuntimeModeInput): RuntimeMode {
  const taskType = input.taskType;
  const explicitAction = input.explicitAction ?? hasExplicitActionIntent(input.message);
  const hasFileRef = hasFileReferenceIntent(input.message, input.filePaths);

  if (hasAmbiguousActionFollowup(input.message)) {
    return input.lastRuntimeMode === "agentic" ? "agentic" : "conversation";
  }

  if (explicitAction || input.hasFiles) return "agentic";
  if (needsFreshExternalEvidence(input.message) || asksForHandoffArtifact(input.message)) return "agentic";
  if (hasFileRef) {
    return isReflectiveDiscussionTurn(input.message) || taskType === "conversation" ? "hybrid" : "agentic";
  }
  if (taskType && AGENTIC_TASK_TYPES.has(taskType)) return "agentic";

  if (taskType === "analysis" || taskType === "expert") {
    return "hybrid";
  }

  if (taskType && CONVERSATION_TASK_TYPES.has(taskType)) {
    if (input.lastRuntimeMode === "agentic" && isSocialConversationalTurn(input.message)) {
      return "conversation";
    }
    return "conversation";
  }

  if (isSocialConversationalTurn(input.message)) return "conversation";
  if (input.message) return "conversation";
  return input.lastRuntimeMode ?? "agentic";
}

export function resolvePromptProfile(runtimeMode: RuntimeMode, taskType?: TaskType | string): PromptProfile {
  if (runtimeMode === "conversation") return "conversation_light";
  if (taskType && HEAVY_AGENTIC_TASK_TYPES.has(taskType)) return "agentic_heavy";
  return "agentic_standard";
}

export function resolveProductRuntimeMode(input: RuntimeModeInput & { hasDelegation?: boolean }): ProductRuntimeMode {
  if (input.hasDelegation || input.taskType === "worker_subtask" || input.taskType === "orchestrator") return "federation";
  if (input.taskType === "code_review" || input.taskType === "research") return "investigation";
  if (/\b(handoff|report|memo|summarize for the next agent)\b/i.test(input.message ?? "")) return "handoff_report";
  const runtimeMode = resolveRuntimeMode(input);
  if (runtimeMode === "conversation") return "conversation";
  if (runtimeMode === "hybrid") return "reflection";
  return "execution";
}

export type ConversationMode = "quick" | "task" | "build" | "deep";
export type ConversationModePreference = "auto" | ConversationMode;
export type AutoConversationModeConfidence = "high" | "medium" | "low";
export type AutoConversationModeReasoning = "low" | "medium" | "high";

export type AutoConversationModeInput = {
  message: string;
  attachmentCount?: number;
};

export type AutoConversationModeResolution = {
  mode: ConversationMode;
  reasoning: AutoConversationModeReasoning;
  confidence: AutoConversationModeConfidence;
  reason: string;
};

export type ConversationModePosture = {
  mode: ConversationMode
  runtimePosture: 'conversation' | 'investigation' | 'execution' | 'reflection'
  detail: string
}

export type IngressConversationModeInput = AutoConversationModeInput & {
  channel: string;
  senderRole?: string;
};

const INTERNAL_AUTO_MODE_CHANNELS = new Set(["system", "mcp", "scheduler", "background"]);

function normalizeMessage(message: string): string {
  return message
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function matchesAny(value: string, patterns: Array<RegExp>): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

function countWords(text: string): number {
  if (!text) return 0;
  return text.split(/\s+/).filter(Boolean).length;
}

const QUICK_INTENT_PATTERNS = [
  /\bquick (answer|reply|take|version)\b/,
  /\bquick mode\b/,
  /\bno tools?\b/,
  /\bdon't use tools?\b/,
  /\bwithout tools?\b/,
];

const BUILD_INTENT_PATTERNS = [
  /\b(use|switch to|go|run in)\s+build mode\b/,
  /\bbuild mode\b/,
];

const DEEP_INTENT_PATTERNS = [
  /\b(use|switch to|go|run in)\s+deep mode\b/,
  /\bthink deeply\b/,
  /\bdeep mode\b/,
];

const TASK_INTENT_PATTERNS = [
  /\b(use|switch to|go|run in)\s+task mode\b/,
  /\btask mode\b/,
];

const BUILD_PATTERNS = [
  /\b(fix|implement|ship|commit|typecheck|test|debug|refactor|deploy)\b/,
  /\b(bug|repo|repository|branch|worktree|pull request|pr|ci)\b/,
  /\b(src\/|\.ts\b|\.tsx\b|\.js\b|\.json\b|package\.json)\b/,
];

const DEEP_PATTERNS = [
  /\b(architecture|strategy|roadmap|tradeoffs?|system design)\b/,
  /\bpressure[- ]test\b/,
  /\bhard (call|problem|debugging|tradeoff)\b/,
  /\bplan (the|this|out|a|an).*\b(router|rollout|architecture|strategy|system|design|implementation)\b/,
  /\b(let'?s )?plan (this|it|out)\b/,
  /\bhow would we do (it|this)\b/,
  /\b(across|between)\s+(all\s+)?(instances|repos|projects|systems|services)\b/,
  /\b(fleet|cross[- ]instance|cross[- ]repo|deep dive|comprehensive|thorough)\b/,
];

const TASK_LOW_PATTERNS = [
  /\b(check|read|scan|look up|lookup|search|google|find|web ?search)\b.*\b(emails?|calendar|weather|price|news|schedule|web|site|page)\b/,
  /\b(emails?|calendar|weather|news|price|schedule)\b/,
  /\b(today|latest|current|right now)\b/,
  /\brun\b/,
];

const TASK_MEDIUM_PATTERNS = [
  /\b(summarize|inspect|review|analyze|compare|extract)\b.*\b(file|page|site|doc|document|pdf|email|thread|decisions?|brief)\b/,
  /\brun (a )?(command|script)\b/,
  /\bsmall edit\b/,
];

const LIGHTWEIGHT_PATTERNS = [
  /^(thanks|thank you|nice|amazing|cool|ok|okay|yeah|yep|lol|haha)\b/,
  /\bbdo\b/,
];

const REFLECTIVE_PATTERNS = [
  /\bwhat do you think\b/,
];

const CONVERSATION_MODE_POSTURES: Record<ConversationMode, ConversationModePosture> = {
  quick: {
    mode: 'quick',
    runtimePosture: 'conversation',
    detail: 'Direct conversation with low overhead.',
  },
  task: {
    mode: 'task',
    runtimePosture: 'investigation',
    detail: 'Bounded task posture with focused tools when needed.',
  },
  build: {
    mode: 'build',
    runtimePosture: 'execution',
    detail: 'Execution posture with verification expectations.',
  },
  deep: {
    mode: 'deep',
    runtimePosture: 'reflection',
    detail: 'Reflective or investigative depth without automatic build-mode ceremony.',
  },
}

export function getConversationModePosture(
  mode: ConversationMode,
): ConversationModePosture {
  return CONVERSATION_MODE_POSTURES[mode]
}

export function resolveAutoConversationMode(
  input: AutoConversationModeInput,
): AutoConversationModeResolution {
  const message = normalizeMessage(input.message);
  const attachmentCount = input.attachmentCount ?? 0;
  const original = input.message.trim();
  const words = countWords(original);
  const lines = original.length > 0 ? original.split(/\n/).length : 0;

  if (matchesAny(message, QUICK_INTENT_PATTERNS)) {
    return {
      mode: "quick",
      reasoning: "low",
      confidence: "high",
      reason: "explicit quick intent",
    };
  }

  if (matchesAny(message, BUILD_INTENT_PATTERNS)) {
    return {
      mode: "build",
      reasoning: "medium",
      confidence: "high",
      reason: "explicit build intent",
    };
  }

  if (matchesAny(message, DEEP_INTENT_PATTERNS)) {
    return {
      mode: "deep",
      reasoning: "high",
      confidence: "high",
      reason: "explicit deep intent",
    };
  }

  if (matchesAny(message, TASK_INTENT_PATTERNS)) {
    return {
      mode: "task",
      reasoning: "medium",
      confidence: "high",
      reason: "explicit task intent",
    };
  }

  if (original.length >= 500 || words >= 80 || lines >= 8) {
    return {
      mode: "deep",
      reasoning: "high",
      confidence: "high",
      reason: "large or multi-step request",
    };
  }

  if (matchesAny(message, DEEP_PATTERNS)) {
    return {
      mode: "deep",
      reasoning: "high",
      confidence: "high",
      reason: "planning or architecture",
    };
  }

  if (matchesAny(message, REFLECTIVE_PATTERNS)) {
    return {
      mode: "quick",
      reasoning: "low",
      confidence: "high",
      reason: "reflective conversational turn",
    };
  }

  if (matchesAny(message, BUILD_PATTERNS)) {
    return {
      mode: "build",
      reasoning: "medium",
      confidence: "high",
      reason: "implementation or repo work",
    };
  }

  if (matchesAny(message, TASK_MEDIUM_PATTERNS) || attachmentCount > 0) {
    return {
      mode: "task",
      reasoning: "medium",
      confidence: attachmentCount > 0 ? "medium" : "high",
      reason: attachmentCount > 0 ? "attached context" : "bounded analysis task",
    };
  }

  if (matchesAny(message, TASK_LOW_PATTERNS)) {
    return {
      mode: "task",
      reasoning: "low",
      confidence: "high",
      reason: "bounded lookup task",
    };
  }

  if (matchesAny(message, LIGHTWEIGHT_PATTERNS)) {
    return {
      mode: "quick",
      reasoning: "low",
      confidence: "high",
      reason: "lightweight conversational turn",
    };
  }

  return {
    mode: "quick",
    reasoning: "low",
    confidence: "low",
    reason: "default quick fallback",
  };
}

export function resolveIngressConversationMode(
  input: IngressConversationModeInput,
): AutoConversationModeResolution | null {
  const channel = input.channel.trim().toLowerCase();
  if (INTERNAL_AUTO_MODE_CHANNELS.has(channel)) return null;

  if (channel === "discord" && input.senderRole === "viewer") {
    return {
      mode: "quick",
      reasoning: "low",
      confidence: "high",
      reason: "public Discord viewer",
    };
  }

  return resolveAutoConversationMode(input);
}

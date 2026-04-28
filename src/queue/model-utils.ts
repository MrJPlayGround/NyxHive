import { MODEL_TIER_REGISTRY } from "../soul/types.js";

// Model alias resolution — Claude tier aliases from defaults.ts (single source of truth) + provider shortcuts
const MODEL_ALIASES: Record<string, string> = {
  ...MODEL_TIER_REGISTRY,
  claude: "claude-sonnet-4-6",
  anthropic: "claude-sonnet-4-6",
  flash: "deepseek/deepseek-v3.2",
  "flash-lite": "deepseek/deepseek-v3.2",
  pro: "deepseek/deepseek-v3.2",
  // OpenAI model aliases — various natural spellings
  openai: "gpt-5.5",
  codex: "gpt-5.5",
  "gpt": "gpt-5.5",
  "gpt5": "gpt-5.5",
  "gpt 5": "gpt-5.5",
  "gpt-5": "gpt-5.5",
  "gpt 5.5": "gpt-5.5",
  "gpt5.5": "gpt-5.5",
  "gpt-5.5": "gpt-5.5",
  "gpt 5.4": "gpt-5.4",
  "gpt5.4": "gpt-5.4",
  "gpt-5.4": "gpt-5.4",
  "gpt 5.4 pro": "gpt-5.4-pro",
  "gpt5.4pro": "gpt-5.4-pro",
  "gpt-5.4-pro": "gpt-5.4-pro",
  "gpt 5.4pro": "gpt-5.4-pro",
  "gpt 5.3 codex": "gpt-5.3-codex",
  "gpt5.3codex": "gpt-5.3-codex",
  "gpt-5.3-codex": "gpt-5.3-codex",
  "gpt 5 mini": "gpt-5-mini",
  "gpt5mini": "gpt-5-mini",
  "gpt-5-mini": "gpt-5-mini",
  "gpt 5 nano": "gpt-5-nano",
  "gpt5nano": "gpt-5-nano",
  "gpt-5-nano": "gpt-5-nano",
};

export function resolveModelAlias(input: string): string {
  const normalized = input.toLowerCase().trim();
  return MODEL_ALIASES[normalized] ?? input;
}

const APPROVE_REGEX = /^approve\s+([a-f0-9]{8})\s*$/i;
const REJECT_REGEX = /^reject\s+([a-f0-9]{8})\s+(.+)$/i;

export function parseProposalCommand(message: string):
  | { action: "approve"; id: string }
  | { action: "reject"; id: string; reason: string }
  | null {
  const trimmed = message.trim();
  const approveMatch = trimmed.match(APPROVE_REGEX);
  if (approveMatch) return { action: "approve", id: approveMatch[1].toLowerCase() };
  const rejectMatch = trimmed.match(REJECT_REGEX);
  if (rejectMatch) return { action: "reject", id: rejectMatch[1].toLowerCase(), reason: rejectMatch[2].trim() };
  return null;
}

export function formatRelativeTime(timestampMs: number): string {
  const diffMs = Date.now() - timestampMs;
  const mins = Math.floor(diffMs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}min ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

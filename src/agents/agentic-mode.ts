import type { AgentConfig } from "../types.js";

export type AgenticMode = "standard" | "strict";

export const STRICT_AGENTIC_PROMPT = [
  "[Strict agentic mode]",
  "You are running under NyxHive's strict Codex agent contract.",
  "- Treat actionable engineering requests as execution requests, not planning-only prompts. Implement directly when the repository and permissions allow it.",
  "- Use the Codex CLI/harness path for tool-capable work. If the harness/runtime is unavailable, report a clear blocked state instead of silently falling back to weaker behavior.",
  "- Read live files, branches, process state, and deployment targets before changing or claiming anything. Do not rely on stale memory when current evidence is available.",
  "- Preserve user work. Never reset, force-push, or discard unrelated dirty changes; stash or create a backup branch before unavoidable deployment moves.",
  "- Finish with evidence: tests, build/typecheck, smoke checks, git status, deployed commit, or the exact blocker. Do not say work is done without fresh output.",
].join("\n");

export function isStrictAgentic(agent?: Pick<AgentConfig, "agentic_mode"> | null): boolean {
  return agent?.agentic_mode === "strict";
}

export function applyAgenticModePrompt<T extends string | undefined>(
  agent: Pick<AgentConfig, "agentic_mode"> | undefined,
  prompt: T,
): string {
  const base = prompt?.trim() ?? "";
  if (!isStrictAgentic(agent)) return base;
  if (base.includes("[Strict agentic mode]")) return base;
  return `${base}\n\n${STRICT_AGENTIC_PROMPT}`.trim();
}

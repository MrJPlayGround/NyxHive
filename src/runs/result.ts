import { relative } from "node:path";
import type {
  AgentConfig,
  DelegationRunBrain,
  DelegationRunFileTouch,
  DelegationRunOutcome,
  DelegationRunResult,
  DelegationRunScratchpadFile,
  DelegationRunStatus,
  InvocationResult,
} from "../types.js";

function coerceList(value: string[] | string | null | undefined): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.map((item) => item.trim()).filter(Boolean);
  return value.split(/[;\n]/).map((item) => item.trim()).filter(Boolean);
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function normalizeSummary(response: string, fallback = "Run completed"): string {
  const line = response
    .split("\n")
    .map((entry) => entry.replace(/^[-*#>\s]+/, "").trim())
    .find(Boolean);
  if (!line) return fallback;
  return line.length > 240 ? `${line.slice(0, 237)}...` : line;
}

function extractLabeledList(response: string, label: "verification" | "blockers"): string[] {
  const regex = new RegExp(`^${label}:\\s*(.+)$`, "im");
  const match = response.match(regex);
  return match ? coerceList(match[1]) : [];
}

function looksLikePath(value: string): boolean {
  return /[./\\]/.test(value) && !/\s{2,}/.test(value);
}

function normalizeFileTouches(touches: DelegationRunFileTouch[]): DelegationRunFileTouch[] {
  const seen = new Set<string>();
  const normalized: DelegationRunFileTouch[] = [];
  for (const touch of touches) {
    const path = touch.path.trim();
    const action = touch.action.trim() || "edit";
    if (!path) continue;
    const key = `${action}:${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({ path, action });
  }
  return normalized;
}

function inferNextAction(
  outcome: DelegationRunOutcome,
  blockers: string[],
  status: DelegationRunStatus,
  hitMaxTurns?: boolean,
): string | null {
  if (status === "failed") return "Retry after fixing the recorded failure.";
  if (status === "killed") return "Restart the run if the work is still needed.";
  if (status === "superseded" || outcome === "superseded") return null;
  if (blockers.length > 0 || outcome === "blocked") return "Resolve the blockers, then rerun.";
  if (hitMaxTurns || outcome === "partial") return "Resume from the current state and finish the remaining work.";
  return null;
}

export function resolveRunBrain(agent: Pick<AgentConfig, "provider" | "cli_fallback">): DelegationRunBrain {
  if (agent.cli_fallback === "codex" || agent.provider === "openai") return "codex";
  if (agent.provider === "anthropic") return "opus";
  return "sdk";
}

export function buildRunContextNote(runId: string, scratchpadDir: string): string {
  return [
    "[Run Context]",
    `Run ID: ${runId}`,
    `Scratchpad: ${scratchpadDir}`,
    "Use the scratchpad for temporary notes, intermediate artifacts, and machine-readable outputs you want preserved with this run.",
    "",
  ].join("\n");
}

export function deriveRunResult(params: {
  response: string;
  status: DelegationRunStatus;
  scratchpadDir: string;
  scratchpadFiles?: DelegationRunScratchpadFile[];
  filesTouched?: DelegationRunFileTouch[];
  invocation?: InvocationResult;
  fallback?: Partial<DelegationRunResult>;
  error?: string;
}): DelegationRunResult {
  const fallback = params.fallback ?? params.invocation?.run_result ?? {};
  const fallbackArtifacts = Array.isArray(fallback.artifacts) ? fallback.artifacts : [];
  const scratchpadArtifacts = (params.scratchpadFiles ?? []).map((file) => `${params.scratchpadDir}/${file.path}`);
  const verification = unique([
    ...coerceList(fallback.verification as string[] | string | null | undefined),
    ...extractLabeledList(params.response, "verification"),
  ]);
  const blockers = unique([
    ...coerceList(fallback.blockers as string[] | string | null | undefined),
    ...extractLabeledList(params.response, "blockers"),
    ...(params.error ? [params.error] : []),
  ]);
  const changedPaths = fallbackArtifacts.filter(looksLikePath);
  const filesTouched = normalizeFileTouches([
    ...(params.filesTouched ?? []),
    ...changedPaths.map((path) => ({ path, action: "edit" })),
    ...(Array.isArray(fallback.files_touched) ? fallback.files_touched : []),
  ]);

  let outcome = fallback.outcome;
  if (!outcome) {
    if (params.status === "failed") outcome = "failure";
    else if (params.status === "killed") outcome = "blocked";
    else if (params.status === "superseded") outcome = "superseded";
    else if (params.invocation?.hitMaxTurns) outcome = "partial";
    else if (blockers.length > 0) outcome = "blocked";
    else outcome = "success";
  }

  return {
    summary: fallback.summary?.trim() || normalizeSummary(params.response, params.status === "failed" ? "Run failed" : "Run completed"),
    outcome,
    artifacts: unique([...fallbackArtifacts, ...scratchpadArtifacts]),
    files_touched: filesTouched,
    verification,
    blockers,
    next_action: fallback.next_action ?? inferNextAction(outcome, blockers, params.status, params.invocation?.hitMaxTurns),
  };
}

export function describeScratchpadFile(pathname: string, scratchpadDir: string): string {
  const rel = relative(scratchpadDir, pathname).replaceAll("\\", "/");
  return rel || pathname;
}

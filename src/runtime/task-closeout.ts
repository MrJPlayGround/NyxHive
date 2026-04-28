import type { ProductRuntimeMode, RuntimeMode } from "./mode.js";

const TASK_CLOSEOUT_TASK_TYPES = new Set<string>([
  "coding",
  "code_review",
  "research",
  "long_context",
  "worker_subtask",
  "orchestrator",
]);

const EMPTY_CLOSEOUTS = new Set([
  "done",
  "all set",
  "task completed",
  "complete",
  "completed",
  "finished",
]);

const OUTCOME_OPENING_PATTERN = /^(done|fixed|implemented|added|updated|removed|changed|found|confirmed|verified|diagnosed|root cause|verdict|blocked|no issues|passed|failed|caught|the issue|the fix|this is|that is)\b/i;
const OUTCOME_PATTERN = /\b(done|fixed|implemented|added|updated|removed|changed|found|confirmed|verified|diagnosed|root cause|verdict|blocked|no issues|passed|failed|caught|the issue|the fix)\b/i;
const EVIDENCE_PATTERN = /\b(changed files?|files changed|verification|verified|tests? passed|tests?|typecheck|build|manual check|smoke check|commit|worktree|git status|blockers?|risks?|residual risk|evidence)\b/i;
const EVIDENCE_BULLET_PATTERN = /^\s*(?:[-*]|\d+\.)\s*(?:changed|files?|verification|tests?|typecheck|build|manual|smoke|commit|worktree|git status|blockers?|risks?|residual risk|evidence)\s*:/i;
const DIARY_MARKER_PATTERN = /\b(first,?\s+i|i started by|i then|then i|next,?\s+i|after that,?\s+i|i went through|i looked at|i opened|i inspected|i searched|i ran|i checked|i noticed|i decided)\b/gi;
const COMMAND_RETELLING_PATTERN = /(?:^|[.!?]\s+)(?:first,?\s+|then\s+|next,?\s+|after that,?\s+)?i\s+(?:ran|opened|checked|looked|searched|inspected|read|edited|updated|changed|tested)\b/gi;

export interface TaskCloseoutDiagnostics {
  passed: boolean;
  score: number;
  wordCount: number;
  lineCount: number;
  bulletCount: number;
  evidenceBulletCount: number;
  outcomeFirst: boolean;
  hasCompletionEvidence: boolean;
  emptyCloseout: boolean;
  diaryMarkerCount: number;
  commandRetellingCount: number;
  diaryLike: boolean;
  overlong: boolean;
  buriedOutcome: boolean;
  issues: string[];
}

export interface TaskCloseoutEvalInput {
  runtimeMode?: RuntimeMode | "unknown";
  productRuntimeMode?: ProductRuntimeMode;
  taskType?: string;
}

export function shouldInspectTaskCloseout(input: TaskCloseoutEvalInput): boolean {
  if (input.productRuntimeMode) {
    return input.productRuntimeMode === "execution" || input.productRuntimeMode === "investigation";
  }
  return input.runtimeMode === "agentic" || (!!input.taskType && TASK_CLOSEOUT_TASK_TYPES.has(input.taskType));
}

export function inspectTaskCloseout(response: string): TaskCloseoutDiagnostics {
  const trimmed = response.trim();
  const normalizedEmpty = trimmed.toLowerCase().replace(/[.!?]+$/g, "");
  const lines = trimmed.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const firstLine = lines[0]?.trim() ?? "";
  const words = trimmed.match(/\S+/g) ?? [];
  const bulletCount = lines.filter((line) => /^\s*(?:[-*]|\d+\.)\s+/.test(line)).length;
  const evidenceBulletCount = lines.filter((line) => EVIDENCE_BULLET_PATTERN.test(line)).length;
  const outcomeFirst = OUTCOME_OPENING_PATTERN.test(firstLine);
  const hasCompletionEvidence = EVIDENCE_PATTERN.test(trimmed) || evidenceBulletCount > 0;
  const emptyCloseout = EMPTY_CLOSEOUTS.has(normalizedEmpty) || (words.length <= 3 && !hasCompletionEvidence);
  const diaryMarkerCount = countMatches(trimmed, DIARY_MARKER_PATTERN);
  const commandRetellingCount = countMatches(trimmed, COMMAND_RETELLING_PATTERN);
  const diaryLike = /^first,?\s+i\b/i.test(firstLine)
    || /\bi started by\b/i.test(firstLine)
    || diaryMarkerCount >= 4
    || commandRetellingCount >= 4;
  const overlong = words.length > 220 || lines.length > 20;
  const outcomeWordOffset = findOutcomeWordOffset(trimmed);
  const buriedOutcome = !outcomeFirst && Number.isFinite(outcomeWordOffset) && outcomeWordOffset > 50;

  const issues: string[] = [];
  if (emptyCloseout) issues.push("empty_closeout");
  if (!outcomeFirst) issues.push("missing_outcome_first_opening");
  if (!hasCompletionEvidence) issues.push("missing_completion_evidence");
  if (overlong) issues.push("overlong_closeout");
  if (diaryLike) issues.push("work_diary");
  if (buriedOutcome) issues.push("buried_outcome");

  let score = 100;
  if (emptyCloseout) score -= 80;
  if (!outcomeFirst) score -= 25;
  if (!hasCompletionEvidence) score -= 20;
  if (overlong) score -= 25;
  if (words.length > 160 && !overlong) score -= 10;
  if (diaryLike) score -= 25;
  if (buriedOutcome) score -= 20;
  if (bulletCount > 0 && evidenceBulletCount === bulletCount) score += 5;
  score = Math.max(0, Math.min(100, score));

  return {
    passed: score >= 70 && outcomeFirst && !emptyCloseout && !diaryLike && !overlong && !buriedOutcome,
    score,
    wordCount: words.length,
    lineCount: lines.length,
    bulletCount,
    evidenceBulletCount,
    outcomeFirst,
    hasCompletionEvidence,
    emptyCloseout,
    diaryMarkerCount,
    commandRetellingCount,
    diaryLike,
    overlong,
    buriedOutcome,
    issues,
  };
}

function countMatches(value: string, pattern: RegExp): number {
  return [...value.matchAll(pattern)].length;
}

function findOutcomeWordOffset(value: string): number {
  const match = OUTCOME_PATTERN.exec(value);
  if (!match || match.index === undefined) return Number.POSITIVE_INFINITY;
  return value.slice(0, match.index).match(/\S+/g)?.length ?? 0;
}

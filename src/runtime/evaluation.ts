import { inspectReplyShape, type ReplyShapeDiagnostics } from "./reply-shape.js";
import { inspectTaskCloseout, type TaskCloseoutDiagnostics } from "./task-closeout.js";
import { inspectPostActionContinuity, type PostActionContinuityDiagnostics } from "./post-action-continuity.js";
import type { ProductRuntimeMode, RuntimeMode } from "./mode.js";

export type EvaluationFamily =
  | "conversational_quality"
  | "task_closeout_quality"
  | "waiting_state_integrity"
  | "trace_readability"
  | "memory_retrieval_fitness"
  | "delegation_quality"
  | "status_reporting_quality"
  | "post_action_continuity";

export type EvaluationFailureKind = "product_issue" | "prompt_runtime_issue" | "evaluator_mismatch";

export interface EvaluationFamilyContract {
  family: EvaluationFamily;
  purpose: string;
  appliesTo: string[];
  notFor: string[];
}

export interface EvaluationFinding {
  dimension: string;
  issue: string;
  why: string;
  likelyKind: EvaluationFailureKind;
}

export interface EvaluationResult {
  family: EvaluationFamily;
  passed: boolean;
  findings: EvaluationFinding[];
  diagnostics?: ReplyShapeDiagnostics | TaskCloseoutDiagnostics | PostActionContinuityDiagnostics | Record<string, unknown>;
}

export const EVALUATION_FAMILIES: Record<EvaluationFamily, EvaluationFamilyContract> = {
  conversational_quality: {
    family: "conversational_quality",
    purpose: "Judge low-action conversational replies for tone, naturalness, and absence of workflow leakage.",
    appliesTo: ["conversation", "reflection without execution", "casual follow-up", "frustration", "celebration"],
    notFor: ["implementation closeouts", "code-review findings", "handoff artifacts"],
  },
  task_closeout_quality: {
    family: "task_closeout_quality",
    purpose: "Judge execution closeouts for outcome-first structure and compact evidence.",
    appliesTo: ["coding closeout", "diagnosis closeout", "research closeout", "review closeout"],
    notFor: ["casual replies", "reflective conversation", "streaming waiting copy"],
  },
  waiting_state_integrity: {
    family: "waiting_state_integrity",
    purpose: "Catch noisy, stale, or contradictory streaming/waiting states.",
    appliesTo: ["tool progress", "long-running local work", "workspace stream activity"],
    notFor: ["final answer quality"],
  },
  trace_readability: {
    family: "trace_readability",
    purpose: "Check whether product trace stays shaped while operator trace preserves evidence.",
    appliesTo: ["context traces", "execution traces", "activity timelines"],
    notFor: ["assistant prose alone"],
  },
  memory_retrieval_fitness: {
    family: "memory_retrieval_fitness",
    purpose: "Check whether retrieved memory is typed, current, trusted, and useful for the turn.",
    appliesTo: ["retrieval traces", "memory inspection", "prompt assembly"],
    notFor: ["general knowledge not pulled from memory"],
  },
  delegation_quality: {
    family: "delegation_quality",
    purpose: "Check target fit, rationale visibility, ownership clarity, and merge-back quality.",
    appliesTo: ["delegation decisions", "federation handoffs", "synthesis replies"],
    notFor: ["single-agent direct answers"],
  },
  status_reporting_quality: {
    family: "status_reporting_quality",
    purpose: "Check compact progress/status replies without diary noise or duplicate evidence.",
    appliesTo: ["status checks", "operator updates", "interrupted task progress"],
    notFor: ["full implementation closeouts"],
  },
  post_action_continuity: {
    family: "post_action_continuity",
    purpose: "Check that tool-using replies preserve the same assistant identity instead of collapsing into operator logs.",
    appliesTo: ["lightweight post-tool answers", "hybrid post-tool reflection", "tool-assisted conversation"],
    notFor: ["heavy implementation closeouts", "raw operator trace"],
  },
};

export function listEvaluationFamilies(): EvaluationFamilyContract[] {
  return Object.values(EVALUATION_FAMILIES);
}

export function selectEvaluationFamily(input: {
  runtimeMode?: RuntimeMode | "unknown";
  productRuntimeMode?: ProductRuntimeMode;
  taskType?: string;
  sampleKind?: string;
  hasDelegation?: boolean;
  isWaitingState?: boolean;
  hasMemoryTrace?: boolean;
  hadToolUse?: boolean;
}): EvaluationFamily {
  if (input.hasDelegation || input.productRuntimeMode === "federation") return "delegation_quality";
  if (input.isWaitingState) return "waiting_state_integrity";
  if (input.hasMemoryTrace) return "memory_retrieval_fitness";
  if (input.sampleKind === "status") return "status_reporting_quality";
  if (
    input.hadToolUse
    && input.productRuntimeMode !== "execution"
    && input.productRuntimeMode !== "investigation"
    && input.runtimeMode !== "agentic"
  ) {
    return "post_action_continuity";
  }
  if (input.productRuntimeMode === "execution" || input.productRuntimeMode === "investigation") {
    return "task_closeout_quality";
  }
  if (input.runtimeMode === "agentic" || ["coding", "code_review", "research", "worker_subtask", "orchestrator"].includes(input.taskType ?? "")) {
    return "task_closeout_quality";
  }
  return "conversational_quality";
}

export function evaluateResponseFamily(response: string, family: EvaluationFamily): EvaluationResult {
  if (family === "task_closeout_quality") {
    const diagnostics = inspectTaskCloseout(response);
    return {
      family,
      passed: diagnostics.passed,
      diagnostics,
      findings: diagnostics.issues.map((issue) => ({
        dimension: "task_closeout",
        issue,
        why: taskCloseoutIssueWhy(issue),
        likelyKind: issue === "missing_outcome_first_opening" ? "prompt_runtime_issue" : "product_issue",
      })),
    };
  }

  if (family === "post_action_continuity") {
    const diagnostics = inspectPostActionContinuity(response);
    return {
      family,
      passed: diagnostics.passed,
      diagnostics,
      findings: diagnostics.issues.map((issue) => ({
        dimension: "post_action_continuity",
        issue,
        why: postActionContinuityIssueWhy(issue),
        likelyKind: "prompt_runtime_issue",
      })),
    };
  }

  const diagnostics = inspectReplyShape(response);
  const findings: EvaluationFinding[] = [];
  if (diagnostics.fillerOpening) {
    findings.push({
      dimension: "tone",
      issue: "generic_filler_opening",
      why: `Starts with generic assistant phrasing: ${diagnostics.fillerOpening}`,
      likelyKind: "prompt_runtime_issue",
    });
  }
  if (diagnostics.internalFrameworkTerms.length > 0) {
    findings.push({
      dimension: "trace_boundary",
      issue: "internal_framework_leakage",
      why: `Leaks internal terms: ${diagnostics.internalFrameworkTerms.join(", ")}`,
      likelyKind: "prompt_runtime_issue",
    });
  }
  if (diagnostics.startsWithActionFraming && family === "conversational_quality") {
    findings.push({
      dimension: "mode_contract",
      issue: "action_framing_in_conversation",
      why: "Conversation replies should answer directly instead of narrating planned work.",
      likelyKind: "evaluator_mismatch",
    });
  }
  if (diagnostics.selfFlatteningTerms.length > 0 && family === "conversational_quality") {
    findings.push({
      dimension: "agency",
      issue: "self_flattening_disclaimer",
      why: `Flattens agent presence with disclaimers: ${diagnostics.selfFlatteningTerms.join(", ")}`,
      likelyKind: "prompt_runtime_issue",
    });
  }
  return { family, passed: findings.length === 0, findings, diagnostics };
}

function postActionContinuityIssueWhy(issue: string): string {
  switch (issue) {
    case "operator_log_leakage":
      return "The final reply exposes tool/log vocabulary instead of translating the result into natural prose.";
    case "report_shape_for_light_action":
      return "A lightweight tool-assisted answer was shaped like an execution report.";
    default:
      return "The response lost conversational continuity after tool use.";
  }
}

function taskCloseoutIssueWhy(issue: string): string {
  switch (issue) {
    case "empty_closeout":
      return "The reply claims completion without evidence.";
    case "missing_outcome_first_opening":
      return "The result is not visible at the top of the closeout.";
    case "missing_completion_evidence":
      return "The closeout lacks tests, changed files, blockers, or other verification evidence.";
    case "overlong_closeout":
      return "The closeout is too verbose for an execution result.";
    case "work_diary":
      return "The reply retells the command sequence instead of the outcome.";
    case "buried_outcome":
      return "The actual result appears too late.";
    default:
      return "The response violated a task closeout contract.";
  }
}

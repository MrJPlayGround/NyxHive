import type { AssemblyTrace, MemoryLane } from "../memory/retrieval-trace.js";
import {
  hasExplicitActionIntent,
  hasFileReferenceIntent,
  resolveProductRuntimeMode,
  resolveRuntimeMode,
  type ProductRuntimeMode,
  type PromptProfile,
  type RuntimeMode,
} from "./mode.js";
import { inspectReplyShape, type ReplyShapeDiagnostics } from "./reply-shape.js";
import { inspectTaskCloseout, shouldInspectTaskCloseout, type TaskCloseoutDiagnostics } from "./task-closeout.js";
import { selectEvaluationFamily, type EvaluationFamily } from "./evaluation.js";

export interface ConversationTraceRow {
  id: number;
  conversation_id: string | null;
  agent_key: string;
  trace_json: string;
  created_at: number;
  user_message?: string | null;
  assistant_response?: string | null;
}

export interface ConversationReviewSample {
  traceId: number;
  conversationId: string | null;
  agentKey: string;
  createdAt: number;
  userMessage: string;
  assistantResponse?: string;
  taskType?: string;
  runtimeMode: RuntimeMode | "unknown";
  productRuntimeMode: ProductRuntimeMode;
  promptProfile: PromptProfile | "unknown";
  memoryLanes: MemoryLane[];
  policyToSoulRatio: number | null;
  memoryTokenEstimate: number;
  conversationMode?: string;
  sampleKind: "casual" | "reflective" | "action_followup" | "file_reference" | "status" | "other";
  evaluationFamily: EvaluationFamily;
  possibleMisroute: string | null;
  replyShape?: ReplyShapeDiagnostics;
  taskCloseout?: TaskCloseoutDiagnostics;
}

export interface RuntimeDistributionSummary {
  total: number;
  legacyTraceCount: number;
  byRuntimeMode: Record<string, number>;
  byProductRuntimeMode: Record<string, number>;
  byPromptProfile: Record<string, number>;
  byEvaluationFamily: Record<string, number>;
  memoryLaneCounts: Record<string, number>;
  medianPolicyToSoulRatioByProfile: Record<string, number>;
  possibleMisroutes: number;
  runtimePosture: RuntimePostureSummary;
}

export interface RuntimePostureSummary {
  lowActionTurns: number;
  conversationalOverstructureRate: number;
  accidentalExecutionModeRate: number;
  delegationOveruseRate: number;
  investigationMissingEvidenceRate: number;
  workspaceModeMismatchRate: number;
  lowActionMemoryTokenPressureMedian: number;
}

export interface ConversationQualityReport {
  generatedAt: number;
  summary: RuntimeDistributionSummary;
  samples: ConversationReviewSample[];
}

function parseTrace(traceJson: string): AssemblyTrace | null {
  try {
    const parsed = JSON.parse(traceJson) as AssemblyTrace;
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function increment(record: Record<string, number>, key: string): void {
  record[key] = (record[key] ?? 0) + 1;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid] ?? 0;
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

function classifySampleKind(message: string): ConversationReviewSample["sampleKind"] {
  const normalized = message.trim().toLowerCase();
  if (/\b(done yet|status|where are we|how'?s it going|progress|eta)\b/.test(normalized)) return "status";
  if (/^(do it|same\b|go ahead|ship it|run it|fix it|implement it)/.test(normalized)) return "action_followup";
  if (hasFileReferenceIntent(message)) return "file_reference";
  if (/\b(think|feel|why|should|approach|worth|brittle|architecture|voice|idea)\b/.test(normalized)) return "reflective";
  if (message.length < 90 && !hasExplicitActionIntent(message)) return "casual";
  return "other";
}

function inferPossibleMisroute(message: string, trace: AssemblyTrace | null): string | null {
  const runtimeMode = trace?.runtimeMode;
  if (!runtimeMode) return "missing_runtime_mode";
  if (
    runtimeMode === "agentic"
    && !hasExplicitActionIntent(message)
    && /\b(think|feel|why|should|approach|worth|brittle|architecture|voice|idea|noisy)\b/i.test(message)
  ) {
    return "possibly_overagentic";
  }
  const inferred = resolveRuntimeMode({
    message,
    taskType: trace.parts.find((part) => part.label === "execution_policy")?.source,
  });
  if (runtimeMode === inferred) return null;
  if (runtimeMode === "agentic" && inferred !== "agentic" && !hasExplicitActionIntent(message)) {
    return "possibly_overagentic";
  }
  if (runtimeMode === "conversation" && inferred === "agentic" && looksLikeActionRequest(message)) {
    return "possibly_underagentic";
  }
  if (runtimeMode === "conversation" && /\b(should|architecture|approach|tradeoff|brittle|worth)\b/i.test(message)) {
    return "possibly_should_be_hybrid";
  }
  return null;
}

function looksLikeActionRequest(message: string): boolean {
  return /^(please\s+)?(fix|implement|run|test|build|commit|push|deploy|search|browse|look up|research|review|audit|open|read|inspect|edit|write|create|add|remove|delete|update|change)\b/i.test(message.trim());
}

function finiteRatio(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function resolveProductModeFromTrace(
  trace: AssemblyTrace | null,
  userMessage: string,
  taskType?: string,
): ProductRuntimeMode {
  if (trace?.productRuntimeMode) return trace.productRuntimeMode;
  return resolveProductRuntimeMode({
    message: userMessage,
    taskType,
    hasDelegation: taskType === "worker_subtask" || taskType === "orchestrator",
  });
}

function getConversationMode(trace: AssemblyTrace | null): string | undefined {
  return trace?.parts.find((part) => part.label === "conversation_mode" && part.injected)?.source;
}

function getMemoryTokenEstimate(trace: AssemblyTrace | null): number {
  const totals = trace?.diagnostics?.sectionTokenTotals;
  if (!totals) return 0;
  return [
    "knowledge",
    "graph_memory",
    "patterns",
    "routing",
    "work_log",
    "wisdom",
    "active_delegations",
  ].reduce((sum, key) => sum + (totals[key] ?? 0), 0);
}

export function buildConversationReviewSamples(rows: ConversationTraceRow[]): ConversationReviewSample[] {
  return rows.flatMap((row) => {
    const trace = parseTrace(row.trace_json);
    const userMessage = row.user_message?.trim();
    if (!userMessage) return [];
    const assistantResponse = row.assistant_response?.trim() || undefined;
    const runtimeMode = trace?.runtimeMode ?? "unknown";
    const taskType = trace?.parts.find((part) => part.label === "execution_policy")?.source;
    const productRuntimeMode = resolveProductModeFromTrace(trace, userMessage, taskType);
    const promptProfile = trace?.promptProfile ?? "unknown";
    const memoryLanes = trace?.memoryLanesInjected ?? [];
    const useTaskCloseout = shouldInspectTaskCloseout({ runtimeMode, productRuntimeMode, taskType });
    const sampleKind = classifySampleKind(userMessage);
    const evaluationFamily = selectEvaluationFamily({
      runtimeMode,
      productRuntimeMode,
      taskType,
      sampleKind,
      hasMemoryTrace: (trace?.memoryLanesInjected?.length ?? 0) > 0 && !assistantResponse,
    });
    return [{
      traceId: row.id,
      conversationId: row.conversation_id,
      agentKey: row.agent_key,
      createdAt: row.created_at,
      userMessage,
      assistantResponse,
      taskType,
      runtimeMode,
      productRuntimeMode,
      promptProfile,
      memoryLanes,
      policyToSoulRatio: finiteRatio(trace?.diagnostics?.policyToSoulRatio),
      memoryTokenEstimate: getMemoryTokenEstimate(trace),
      conversationMode: getConversationMode(trace),
      sampleKind,
      evaluationFamily,
      possibleMisroute: inferPossibleMisroute(userMessage, trace),
      replyShape: assistantResponse && !useTaskCloseout ? inspectReplyShape(assistantResponse) : undefined,
      taskCloseout: assistantResponse && useTaskCloseout ? inspectTaskCloseout(assistantResponse) : undefined,
    }];
  });
}

export function summarizeRuntimeDistribution(samples: ConversationReviewSample[]): RuntimeDistributionSummary {
  const ratiosByProfile = new Map<string, number[]>();
  const lowActionMemoryTokens: number[] = [];
  const investigativeSamples: ConversationReviewSample[] = [];
  let lowActionTurns = 0;
  let overstructuredLowAction = 0;
  let accidentalExecutionLowAction = 0;
  let delegationOveruseLowAction = 0;
  let workspaceModeTotal = 0;
  let workspaceModeMismatches = 0;
  const summary: RuntimeDistributionSummary = {
    total: samples.length,
    legacyTraceCount: 0,
    byRuntimeMode: {},
    byProductRuntimeMode: {},
    byPromptProfile: {},
    byEvaluationFamily: {},
    memoryLaneCounts: {},
    medianPolicyToSoulRatioByProfile: {},
    possibleMisroutes: 0,
    runtimePosture: {
      lowActionTurns: 0,
      conversationalOverstructureRate: 0,
      accidentalExecutionModeRate: 0,
      delegationOveruseRate: 0,
      investigationMissingEvidenceRate: 0,
      workspaceModeMismatchRate: 0,
      lowActionMemoryTokenPressureMedian: 0,
    },
  };

  for (const sample of samples) {
    increment(summary.byRuntimeMode, sample.runtimeMode);
    increment(summary.byProductRuntimeMode, sample.productRuntimeMode);
    increment(summary.byPromptProfile, sample.promptProfile);
    increment(summary.byEvaluationFamily, sample.evaluationFamily);
    if (sample.possibleMisroute === "missing_runtime_mode") {
      summary.legacyTraceCount++;
    } else if (sample.possibleMisroute) {
      summary.possibleMisroutes++;
    }
    for (const lane of sample.memoryLanes) increment(summary.memoryLaneCounts, lane);
    if (sample.policyToSoulRatio !== null) {
      const ratios = ratiosByProfile.get(sample.promptProfile) ?? [];
      ratios.push(sample.policyToSoulRatio);
      ratiosByProfile.set(sample.promptProfile, ratios);
    }

    if (sample.productRuntimeMode === "investigation") {
      investigativeSamples.push(sample);
    }

    const isLowAction = sample.sampleKind === "casual" || sample.sampleKind === "reflective" || sample.sampleKind === "status";
    if (isLowAction) {
      lowActionTurns++;
      lowActionMemoryTokens.push(sample.memoryTokenEstimate);
      if (
        sample.replyShape?.overstructured
        || sample.replyShape?.summaryOpening
        || (sample.replyShape?.bulletCount ?? 0) >= 2
        || sample.replyShape?.setupOpening !== null
      ) {
        overstructuredLowAction++;
      }
      if (
        sample.productRuntimeMode === "execution"
        || sample.productRuntimeMode === "investigation"
        || sample.runtimeMode === "agentic"
      ) {
        accidentalExecutionLowAction++;
      }
      if (sample.productRuntimeMode === "federation" || sample.taskType === "orchestrator" || sample.taskType === "worker_subtask") {
        delegationOveruseLowAction++;
      }
    }

    if (sample.conversationMode) {
      workspaceModeTotal++;
      const expected = expectedProductModeForConversationMode(sample.conversationMode);
      if (expected && expected !== sample.productRuntimeMode) {
        workspaceModeMismatches++;
      }
    }
  }

  for (const [profile, ratios] of ratiosByProfile) {
    summary.medianPolicyToSoulRatioByProfile[profile] = Math.round(median(ratios) * 1000) / 1000;
  }

  const investigationMissingEvidence = investigativeSamples.filter((sample) =>
    sample.taskCloseout?.issues.includes("missing_completion_evidence"),
  ).length;
  summary.runtimePosture = {
    lowActionTurns,
    conversationalOverstructureRate: rate(overstructuredLowAction, lowActionTurns),
    accidentalExecutionModeRate: rate(accidentalExecutionLowAction, lowActionTurns),
    delegationOveruseRate: rate(delegationOveruseLowAction, lowActionTurns),
    investigationMissingEvidenceRate: rate(investigationMissingEvidence, investigativeSamples.length),
    workspaceModeMismatchRate: rate(workspaceModeMismatches, workspaceModeTotal),
    lowActionMemoryTokenPressureMedian: Math.round(median(lowActionMemoryTokens)),
  };

  return summary;
}

function expectedProductModeForConversationMode(mode: string): ProductRuntimeMode | null {
  switch (mode) {
    case "quick":
      return "conversation";
    case "build":
      return "execution";
    case "deep":
      return "reflection";
    case "task":
      return null;
    default:
      return null;
  }
}

function rate(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 1000) / 1000;
}

export function buildConversationQualityReport(rows: ConversationTraceRow[]): ConversationQualityReport {
  const samples = buildConversationReviewSamples(rows);
  return {
    generatedAt: Date.now(),
    summary: summarizeRuntimeDistribution(samples),
    samples,
  };
}

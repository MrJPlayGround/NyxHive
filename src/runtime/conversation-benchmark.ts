import type { TaskType } from "../providers/types.js";
import type { AssemblyTrace } from "../memory/retrieval-trace.js";
import { inspectReplyShape, type ReplyShapeDiagnostics } from "./reply-shape.js";
import { resolvePromptProfile, resolveRuntimeMode, type PromptProfile, type RuntimeMode } from "./mode.js";
import { inspectTaskCloseout, shouldInspectTaskCloseout, type TaskCloseoutDiagnostics } from "./task-closeout.js";
import { inspectPostActionContinuity, type PostActionContinuityDiagnostics } from "./post-action-continuity.js";

export interface ConversationBenchmarkScenario {
  name: string;
  message: string;
  taskType?: TaskType;
  lastRuntimeMode?: RuntimeMode;
  expectedMode?: RuntimeMode;
  hadToolUse?: boolean;
}

export interface PromptCompositionMetrics {
  totalTokens: number;
  policyTokens: number;
  soulTokens: number;
  policyToSoulRatio: number;
  policySectionCount: number;
  memoryLaneCount: number;
}

export interface ConversationBenchmarkResult {
  name: string;
  runtimeMode: RuntimeMode;
  promptProfile: PromptProfile;
  expectedMode?: RuntimeMode;
  passedModeExpectation: boolean;
  replyShape?: ReplyShapeDiagnostics;
  taskCloseout?: TaskCloseoutDiagnostics;
  postActionContinuity?: PostActionContinuityDiagnostics;
}

export const DEFAULT_CONVERSATION_BENCHMARKS: ConversationBenchmarkScenario[] = [
  { name: "greeting", message: "you alive?", taskType: "simple_qa", expectedMode: "conversation" },
  { name: "casual vent", message: "that's annoying", taskType: "conversation", expectedMode: "conversation" },
  { name: "opinion", message: "what do you think?", taskType: "simple_qa", lastRuntimeMode: "conversation", expectedMode: "conversation" },
  { name: "implementation", message: "fix the prompt builder tests", taskType: "coding", expectedMode: "agentic" },
  { name: "reflective discussion", message: "is this architecture too brittle?", taskType: "expert", expectedMode: "hybrid" },
  { name: "post-tool reflection", message: "ok, what did the tool actually show?", taskType: "expert", expectedMode: "hybrid", hadToolUse: true },
];

export function summarizePromptComposition(trace: AssemblyTrace): PromptCompositionMetrics {
  const policyTokens = trace.parts
    .filter((part) => part.injected && ["execution_policy", "operating_model", "clarification", "agentic_mode", "depth_guard", "response_contract"].includes(part.label))
    .reduce((sum, part) => sum + part.tokenEstimate, 0);
  const soulTokens = trace.parts
    .filter((part) => part.injected && part.label === "soul")
    .reduce((sum, part) => sum + part.tokenEstimate, 0);
  return {
    totalTokens: trace.totalTokens,
    policyTokens,
    soulTokens,
    policyToSoulRatio: soulTokens > 0 ? Math.round((policyTokens / soulTokens) * 1000) / 1000 : (policyTokens > 0 ? Infinity : 0),
    policySectionCount: trace.parts.filter((part) => part.injected && ["execution_policy", "operating_model", "clarification", "agentic_mode", "depth_guard", "response_contract"].includes(part.label)).length,
    memoryLaneCount: trace.memoryLanesInjected?.length ?? 0,
  };
}

export function runConversationBenchmark(
  scenarios: ConversationBenchmarkScenario[] = DEFAULT_CONVERSATION_BENCHMARKS,
  replies?: Record<string, string>,
): ConversationBenchmarkResult[] {
  return scenarios.map((scenario) => {
    const runtimeMode = resolveRuntimeMode({
      message: scenario.message,
      taskType: scenario.taskType,
      lastRuntimeMode: scenario.lastRuntimeMode,
    });
    const response = replies?.[scenario.name];
    const useTaskCloseout = shouldInspectTaskCloseout({ runtimeMode, taskType: scenario.taskType });
    const usePostActionContinuity = !!response && !!scenario.hadToolUse && runtimeMode !== "agentic";
    return {
      name: scenario.name,
      runtimeMode,
      promptProfile: resolvePromptProfile(runtimeMode, scenario.taskType),
      expectedMode: scenario.expectedMode,
      passedModeExpectation: scenario.expectedMode ? runtimeMode === scenario.expectedMode : true,
      replyShape: response && !useTaskCloseout && !usePostActionContinuity ? inspectReplyShape(response) : undefined,
      taskCloseout: response && useTaskCloseout ? inspectTaskCloseout(response) : undefined,
      postActionContinuity: usePostActionContinuity ? inspectPostActionContinuity(response) : undefined,
    };
  });
}

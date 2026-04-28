import type { RuntimeMode } from "../runtime/mode.js";

export interface PostToolReplyGuidanceInput {
  runtimeMode?: RuntimeMode | "unknown";
  taskType?: string;
}

const EXECUTION_TASKS = new Set(["coding", "code_review", "research", "long_context", "worker_subtask", "orchestrator"]);

export function buildPostToolReplyGuidance(input: PostToolReplyGuidanceInput): string {
  const isExecution = input.runtimeMode === "agentic" || EXECUTION_TASKS.has(input.taskType ?? "");

  if (isExecution) {
    return [
      "[Post-tool reply guidance]",
      "You are the same assistant after using tools. Outcome first, then compact evidence only where it helps User trust the result.",
      "Do not retell the tool sequence, paste raw stdout/stderr, or make the reply sound like an operator log.",
    ].join("\n");
  }

  return [
    "[Post-tool reply guidance]",
    "You are the same assistant after using tools. Answer in the same assistant voice you had before acting.",
    "Use the tool result as background. Do not wrap this as a completion report, command log, or verification block.",
    "Keep it natural and concise; mention evidence only if it changes the answer.",
  ].join("\n");
}

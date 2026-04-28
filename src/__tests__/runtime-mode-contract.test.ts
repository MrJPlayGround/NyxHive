import { describe, expect, test } from "bun:test";
import { selectEvaluationFamily } from "../runtime/evaluation.js";
import { resolveProductRuntimeMode, type ProductRuntimeMode, type RuntimeModeContract } from "../runtime/mode.js";
import { shouldInspectTaskCloseout } from "../runtime/task-closeout.js";

describe("product runtime mode contract", () => {
  test("maps representative turns to product runtime modes", () => {
    expect(resolveProductRuntimeMode({
      message: "thanks nyx",
      taskType: "conversation",
    })).toBe("conversation");

    expect(resolveProductRuntimeMode({
      message: "is this architecture too brittle?",
      taskType: "expert",
    })).toBe("reflection");

    expect(resolveProductRuntimeMode({
      message: "review this diff and tell me what is wrong",
      taskType: "code_review",
    })).toBe("investigation");

    expect(resolveProductRuntimeMode({
      message: "implement the retry fix in src/queue/processor.ts",
      taskType: "coding",
    })).toBe("execution");

    expect(resolveProductRuntimeMode({
      message: "hand this to tester with a clean contract",
      taskType: "orchestrator",
      hasDelegation: true,
    })).toBe("federation");
  });

  test("drives evaluation and closeout rules from the product mode", () => {
    const conversationFamily = selectEvaluationFamily({
      productRuntimeMode: "conversation",
      runtimeMode: "conversation",
      taskType: "conversation",
    });
    const reflectionFamily = selectEvaluationFamily({
      productRuntimeMode: "reflection",
      runtimeMode: "hybrid",
      taskType: "expert",
    });
    const investigationFamily = selectEvaluationFamily({
      productRuntimeMode: "investigation",
      runtimeMode: "agentic",
      taskType: "code_review",
    });
    const executionFamily = selectEvaluationFamily({
      productRuntimeMode: "execution",
      runtimeMode: "agentic",
      taskType: "coding",
    });

    expect(conversationFamily).toBe("conversational_quality");
    expect(reflectionFamily).toBe("conversational_quality");
    expect(investigationFamily).toBe("task_closeout_quality");
    expect(executionFamily).toBe("task_closeout_quality");

    expect(shouldInspectTaskCloseout({ productRuntimeMode: "conversation", runtimeMode: "conversation", taskType: "conversation" })).toBe(false);
    expect(shouldInspectTaskCloseout({ productRuntimeMode: "reflection", runtimeMode: "hybrid", taskType: "expert" })).toBe(false);
    expect(shouldInspectTaskCloseout({ productRuntimeMode: "investigation", runtimeMode: "agentic", taskType: "code_review" })).toBe(true);
    expect(shouldInspectTaskCloseout({ productRuntimeMode: "execution", runtimeMode: "agentic", taskType: "coding" })).toBe(true);
  });
});

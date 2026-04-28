import { describe, expect, test } from "bun:test";
import { RUNTIME_MODE_CONTRACTS, resolveProductRuntimeMode, resolvePromptProfile, resolveRuntimeMode } from "../runtime/mode.js";

describe("runtime mode selection", () => {
  test("keeps greetings in conversation mode", () => {
    const mode = resolveRuntimeMode({ message: "you alive?", taskType: "simple_qa" });
    expect(mode).toBe("conversation");
    expect(resolvePromptProfile(mode, "simple_qa")).toBe("conversation_light");
  });

  test("keeps casual thoughts conversational when no action is requested", () => {
    const mode = resolveRuntimeMode({
      message: "I keep thinking the whole thing feels too loud at the surface.",
      taskType: "conversation",
    });
    expect(mode).toBe("conversation");
  });

  test("defaults unclassified normal messages to conversation mode", () => {
    expect(resolveRuntimeMode({
      message: "this feels cleaner than the old approach",
    })).toBe("conversation");
  });

  test("keeps reflective file mentions out of execution mode", () => {
    expect(resolveRuntimeMode({
      message: "That src/queue/processor.ts path still feels like the heart of the thing",
      taskType: "conversation",
    })).toBe("hybrid");
  });

  test("escalates explicit implementation requests to agentic mode", () => {
    const mode = resolveRuntimeMode({
      message: "Implement the new queue retry behavior in src/queue/processor.ts",
      taskType: "conversation",
    });
    expect(mode).toBe("agentic");
    expect(resolvePromptProfile(mode, "coding")).toBe("agentic_heavy");
  });

  test("escalates live factual questions that need fresh evidence", () => {
    expect(resolveRuntimeMode({
      message: "who is the current OpenAI CEO?",
      taskType: "simple_qa",
    })).toBe("agentic");
  });

  test("escalates handoff artifact requests", () => {
    expect(resolveRuntimeMode({
      message: "turn this into a handoff for the next agent",
      taskType: "conversation",
    })).toBe("agentic");
  });

  test("short follow-ups inherit conversational inertia unless they ask for action", () => {
    expect(resolveRuntimeMode({
      message: "yeah",
      taskType: "simple_qa",
      lastRuntimeMode: "conversation",
    })).toBe("conversation");

    expect(resolveRuntimeMode({
      message: "run it",
      taskType: "simple_qa",
      lastRuntimeMode: "conversation",
    })).toBe("agentic");
  });

  test("operator setup and hardening requests enter execution mode", () => {
    expect(resolveRuntimeMode({
      message: "sounds good, set it up",
      taskType: "conversation",
    })).toBe("agentic");

    expect(resolveRuntimeMode({
      message: "make sure the Discord harness is safe against prompt ejection",
      taskType: "conversation",
    })).toBe("agentic");
  });

  test("ambiguous action follow-ups only escalate from prior action context", () => {
    expect(resolveRuntimeMode({
      message: "do it",
      taskType: "conversation",
      lastRuntimeMode: "conversation",
    })).toBe("conversation");

    expect(resolveRuntimeMode({
      message: "do it",
      taskType: "conversation",
      lastRuntimeMode: "agentic",
    })).toBe("agentic");
  });

  test("separates reflective thought from execution", () => {
    const mode = resolveRuntimeMode({
      message: "is this architecture too brittle?",
      taskType: "expert",
      lastRuntimeMode: "conversation",
    });

    expect(mode).toBe("hybrid");
    expect(resolvePromptProfile(mode, "expert")).toBe("agentic_standard");
  });

  test("defines product-grade runtime mode contracts", () => {
    expect(RUNTIME_MODE_CONTRACTS.execution.evidenceExpectation).toContain("Fresh verification");
    expect(RUNTIME_MODE_CONTRACTS.federation.responseShape).toContain("ownership");
    expect(RUNTIME_MODE_CONTRACTS.conversation.toolDetailVisibility).toBe("hidden");
  });

  test("maps task context to product runtime modes", () => {
    expect(resolveProductRuntimeMode({ message: "debug why the stream is noisy", taskType: "research" }))
      .toBe("investigation");
    expect(resolveProductRuntimeMode({ message: "turn this into a handoff", taskType: "conversation" }))
      .toBe("handoff_report");
    expect(resolveProductRuntimeMode({ message: "implement it", taskType: "coding" }))
      .toBe("execution");
    expect(resolveProductRuntimeMode({ message: "what would you do here?", taskType: "expert" }))
      .toBe("reflection");
    expect(resolveProductRuntimeMode({ message: "delegate this to analyst", taskType: "orchestrator", hasDelegation: true }))
      .toBe("federation");
  });
});

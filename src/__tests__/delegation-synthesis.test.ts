import { describe, test, expect } from "bun:test";
import { composeDelegationResponse, buildSynthesisPrompt } from "../queue/delegation-synthesis.js";

// Minimal ctx mock factory
function createMockCtx() {
  const emittedEvents: Array<{ event: string; data: any }> = [];
  const ctx = {
    emit: (event: string, data: any) => {
      emittedEvents.push({ event, data });
    },
  } as any;
  return { ctx, emittedEvents };
}

describe("composeDelegationResponse", () => {
  test("returns cleaned response when no subtask results", () => {
    const { ctx } = createMockCtx();
    const result = composeDelegationResponse("Here is the response", [], [], "", ctx);
    expect(result).toBe("Here is the response");
  });

  test("includes formatted subtask results with agent names", () => {
    const { ctx } = createMockCtx();
    const subtasks = [
      { agent: "Analyst", agentKey: "analyst", response: "Analysis complete" },
      { agent: "Tester", agentKey: "tester", response: "All tests pass" },
    ];
    const result = composeDelegationResponse("Lead response", [], subtasks, "", ctx);
    expect(result).toContain("Specialist support: Analyst (@analyst), Tester (@tester).");
    expect(result).not.toContain("**Analyst** (@analyst):\nAnalysis complete");
    expect(result).not.toContain("**Tester** (@tester):\nAll tests pass");
    expect(result).toStartWith("Lead response");
  });

  test("falls back to detailed subtask results when the lead has no synthesis yet", () => {
    const { ctx } = createMockCtx();
    const subtasks = [
      { agent: "Analyst", agentKey: "analyst", response: "Analysis complete" },
    ];
    const result = composeDelegationResponse("", [], subtasks, "", ctx);
    expect(result).toContain("**Analyst** (@analyst):\nAnalysis complete");
  });

  test("includes action results", () => {
    const { ctx } = createMockCtx();
    const result = composeDelegationResponse(
      "Response",
      ["Action 1 done", "Action 2 done"],
      [],
      "",
      ctx,
    );
    expect(result).toContain("Action 1 done\nAction 2 done");
  });

  test("includes unknown errors", () => {
    const { ctx } = createMockCtx();
    const result = composeDelegationResponse(
      "Response",
      [],
      [],
      "Something went wrong",
      ctx,
    );
    expect(result).toContain("Something went wrong");
  });

  test("emits synthesis_start event when subtask results present", () => {
    const { ctx, emittedEvents } = createMockCtx();
    const subtasks = [
      { agent: "Analyst", agentKey: "analyst", response: "Done" },
    ];
    composeDelegationResponse("Response", [], subtasks, "", ctx, "msg-1", "nyx", "discord");

    const synthEvent = emittedEvents.find(e => e.event === "synthesis_start");
    expect(synthEvent).toBeDefined();
    expect(synthEvent!.data.message_id).toBe("msg-1");
    expect(synthEvent!.data.channel).toBe("discord");
    expect(synthEvent!.data.agent).toBe("nyx");
    expect(synthEvent!.data.agent_count).toBe(1);
  });

  test("does not emit synthesis_start without originMessageId", () => {
    const { ctx, emittedEvents } = createMockCtx();
    const subtasks = [
      { agent: "Analyst", agentKey: "analyst", response: "Done" },
    ];
    composeDelegationResponse("Response", [], subtasks, "", ctx);

    const synthEvent = emittedEvents.find(e => e.event === "synthesis_start");
    expect(synthEvent).toBeUndefined();
  });

  test("emits response:delta with replace=true when results present", () => {
    const { ctx, emittedEvents } = createMockCtx();
    const subtasks = [
      { agent: "Analyst", agentKey: "analyst", response: "Done" },
    ];
    composeDelegationResponse("Response", [], subtasks, "", ctx, "msg-1", "nyx", "discord");

    const deltaEvent = emittedEvents.find(e => e.event === "response:delta");
    expect(deltaEvent).toBeDefined();
    expect(deltaEvent!.data.replace).toBe(true);
    expect(deltaEvent!.data.message_id).toBe("msg-1");
    expect(deltaEvent!.data.agent).toBe("nyx");
    expect(deltaEvent!.data.channel).toBe("discord");
  });

  test("emits inspectable delegation_result data even when the reply stays compact", () => {
    const { ctx, emittedEvents } = createMockCtx();
    const subtasks = [
      { agent: "Analyst", agentKey: "analyst", response: "Done" },
    ];

    composeDelegationResponse("Lead response", [], subtasks, "", ctx, "msg-1", "nyx", "discord");

    const detailEvent = emittedEvents.find((event) => event.event === "delegation_result");
    expect(detailEvent).toBeDefined();
    expect(detailEvent!.data.results).toEqual(subtasks);
    expect(detailEvent!.data.message_id).toBe("msg-1");
  });
});

describe("buildSynthesisPrompt", () => {
  test("includes [Delegation Results] header", () => {
    const result = buildSynthesisPrompt([
      { agent: "Analyst", agentKey: "analyst", response: "Done" },
    ]);
    expect(result).toContain("[Delegation Results]");
  });

  test("formats agent results with bold names", () => {
    const result = buildSynthesisPrompt([
      { agent: "Analyst", agentKey: "analyst", response: "Research complete" },
      { agent: "Tester", agentKey: "tester", response: "Tests pass" },
    ]);
    expect(result).toContain("**Analyst** (@analyst):\nResearch complete");
    expect(result).toContain("**Tester** (@tester):\nTests pass");
  });

  test("truncates long results at 4000 chars", () => {
    const longResponse = "x".repeat(5000);
    const result = buildSynthesisPrompt([
      { agent: "Analyst", agentKey: "analyst", response: longResponse },
    ]);
    expect(result).toContain("[...truncated]");
    expect(result).not.toContain("x".repeat(5000));
    // The capped portion should be exactly 4000 chars
    const cappedSection = result.split("**Analyst** (@analyst):\n")[1].split("\n[...truncated]")[0];
    expect(cappedSection.length).toBe(4000);
  });

  test("does not truncate results under 4000 chars", () => {
    const shortResponse = "x".repeat(3999);
    const result = buildSynthesisPrompt([
      { agent: "Analyst", agentKey: "analyst", response: shortResponse },
    ]);
    expect(result).not.toContain("[...truncated]");
  });

  test("includes [Original Request] when provided", () => {
    const result = buildSynthesisPrompt(
      [{ agent: "Analyst", agentKey: "analyst", response: "Done" }],
      "What is the status?",
    );
    expect(result).toContain("[Original Request]");
    expect(result).toContain("What is the status?");
  });

  test("truncates original request at 500 chars", () => {
    const longMessage = "y".repeat(600);
    const result = buildSynthesisPrompt(
      [{ agent: "Analyst", agentKey: "analyst", response: "Done" }],
      longMessage,
    );
    expect(result).toContain("y".repeat(500) + "...");
    expect(result).not.toContain("y".repeat(501));
  });

  test("includes [Instructions] section", () => {
    const result = buildSynthesisPrompt([
      { agent: "Analyst", agentKey: "analyst", response: "Done" },
    ]);
    expect(result).toContain("[Instructions]");
    expect(result).toContain("Review these results and respond to the ORIGINAL REQUEST");
  });

  test("works without originalUserMessage", () => {
    const result = buildSynthesisPrompt([
      { agent: "Analyst", agentKey: "analyst", response: "Done" },
    ]);
    expect(result).not.toContain("[Original Request]");
    expect(result).toContain("[Delegation Results]");
    expect(result).toContain("[Instructions]");
  });
});

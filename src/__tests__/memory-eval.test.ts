import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { GraphMemory } from "../memory/graph.js";
import {
  evaluateGraphMemoryCase,
  evaluateMemoryContext,
  runMemoryEvalSuite,
  type MemoryEvalCase,
} from "../memory/eval.js";

function makeGraph(): GraphMemory {
  return new GraphMemory(new Database(":memory:"));
}

function markRecurring(graph: GraphMemory, id: number): void {
  graph.bumpMentionCount(id);
  graph.bumpMentionCount(id);
}

describe("memory eval harness", () => {
  test("scores expected recall, forbidden stale terms, and token budget", () => {
    const result = evaluateMemoryContext(
      {
        id: "reload-permission",
        question: "Can Nyx reload live processes without permission?",
        expectedTerms: ["explicit user permission"],
        forbiddenTerms: ["reload whenever needed"],
        maxPromptTokens: 30,
      },
      "Assistant must wait for explicit user permission before reloading live NyxAI processes.",
    );

    expect(result.passed).toBe(true);
    expect(result.missingExpectedTerms).toEqual([]);
    expect(result.forbiddenMatches).toEqual([]);
    expect(result.estimatedTokens).toBeLessThanOrEqual(30);
  });

  test("fails compactly when memory is unsupported, stale, or fat", () => {
    const result = evaluateMemoryContext(
      {
        id: "sdk-stance",
        question: "What did we decide about SDK adoption?",
        expectedTerms: ["adapt"],
        forbiddenTerms: ["top-level blueprint"],
        maxPromptTokens: 4,
      },
      "Use the SDK as the top-level blueprint for NyxHive because it is comprehensive.",
    );

    expect(result.passed).toBe(false);
    expect(result.missingExpectedTerms).toEqual(["adapt"]);
    expect(result.forbiddenMatches).toEqual(["top-level blueprint"]);
    expect(result.tokenBudgetExceeded).toBe(true);
  });

  test("evaluates graph memory without injecting recurring operational debris", () => {
    const graph = makeGraph();
    const preference = graph.addNode("preference", "User prefers casual BDO chat to stay Quick/low unless action is requested.", undefined, 0.9);
    const fileTouch = graph.addNode("file_change", "Touched file: src/nyx-workspace/src/components/workspace-switcher.test.ts", undefined, 0.9);
    const genericFailure = graph.addNode("fact", "Test failure resolved during coding task", undefined, 0.9);
    markRecurring(graph, preference);
    markRecurring(graph, fileTouch);
    markRecurring(graph, genericFailure);

    const result = evaluateGraphMemoryCase(graph, {
      id: "casual-bdo-mode",
      question: "What mode should casual BDO chat use?",
      taskContext: { keywords: ["casual", "bdo", "chat", "mode"] },
      expectedTerms: ["Quick/low"],
      forbiddenTerms: ["Touched file:", "Test failure resolved during coding task"],
      maxPromptTokens: 80,
    });

    expect(result.passed).toBe(true);
    expect(result.context).toContain("Quick/low");
    expect(result.context).not.toContain("Touched file:");
    expect(result.context).not.toContain("Test failure resolved during coding task");
  });

  test("graph eval does not mutate graph access counters", () => {
    const graph = makeGraph();
    const id = graph.addNode("decision", "Treat Codex Agents SDK as reference material, not a NyxHive blueprint.", undefined, 0.9);

    evaluateGraphMemoryCase(graph, {
      id: "sdk-stance",
      question: "What did we decide about SDK adoption?",
      taskContext: { keywords: ["codex", "sdk", "adoption"] },
      expectedTerms: ["reference material"],
      forbiddenTerms: ["blueprint"],
      maxPromptTokens: 80,
    });

    expect(graph.getNode(id)?.access_count).toBe(0);
  });

  test("summarizes a golden suite with pass/fail counts and case diagnostics", () => {
    const cases: MemoryEvalCase[] = [
      {
        id: "permission",
        question: "Can Nyx reload live processes without permission?",
        expectedTerms: ["permission"],
        forbiddenTerms: ["without asking"],
        maxPromptTokens: 20,
      },
      {
        id: "missing",
        question: "What is stale?",
        expectedTerms: ["superseded"],
        forbiddenTerms: [],
        maxPromptTokens: 20,
      },
    ];

    const report = runMemoryEvalSuite(cases, (testCase) =>
      testCase.id === "permission"
        ? "Live process reloads require permission."
        : "No useful memory found.",
    );

    expect(report.total).toBe(2);
    expect(report.passed).toBe(1);
    expect(report.failed).toBe(1);
    expect(report.results[1].missingExpectedTerms).toEqual(["superseded"]);
  });
});

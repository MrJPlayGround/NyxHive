import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { GraphMemory } from "../memory/graph.js";

describe("getBriefing token limit", () => {
  function createTestGraph(): GraphMemory {
    const db = new Database(":memory:");
    return new GraphMemory(db);
  }

  test("should respect maxTokens budget", () => {
    const graph = createTestGraph();

    // Add 50 nodes with long content (~100 chars each)
    for (let i = 0; i < 50; i++) {
      graph.addNode(
        "fact",
        `This is a moderately long memory node number ${i} containing some detailed information about the system configuration and behavior patterns`,
        { conversationId: `conv-${i}`, channel: "test" },
        0.8,
      );
    }

    // Request with tight token budget (100 tokens ~= 400 chars)
    const briefing = graph.getBriefing(50, undefined, 100);
    // Rough check: 100 tokens * 4 chars/token = ~400 chars max
    // Allow some overhead for headers
    expect(briefing.length).toBeLessThan(600);
    expect(briefing.length).toBeGreaterThan(0);
  });

  test("should return all nodes when budget is generous", () => {
    const graph = createTestGraph();

    // Add 3 short nodes
    graph.addNode("fact", "Short memory 1", undefined, 0.9);
    graph.addNode("fact", "Short memory 2", undefined, 0.8);
    graph.addNode("fact", "Short memory 3", undefined, 0.7);

    const briefing = graph.getBriefing(20, undefined, 5000);
    expect(briefing).toContain("Short memory 1");
    expect(briefing).toContain("Short memory 2");
    expect(briefing).toContain("Short memory 3");
  });

  test("should return empty string when no nodes exist", () => {
    const graph = createTestGraph();
    const briefing = graph.getBriefing(20, undefined, 500);
    expect(briefing).toBe("");
  });
});

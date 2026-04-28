import { describe, test, expect, beforeEach } from "bun:test";
import { ConversationTracker } from "../queue/conversation.js";
import type { TeamConfig } from "../types.js";

const twoAgentTeam: TeamConfig = { name: "Dev Team", agents: ["forge", "tester"] };
const threeAgentTeam: TeamConfig = { name: "Full Team", agents: ["forge", "tester", "analyst"] };
const singleAgentTeam: TeamConfig = { name: "Solo", agents: ["nyx"] };

describe("ConversationTracker", () => {
  let tracker: ConversationTracker;

  beforeEach(() => {
    tracker = new ConversationTracker();
  });

  describe("startConversation", () => {
    test("initializes state correctly", () => {
      tracker.startConversation("conv-1", twoAgentTeam);
      expect(tracker.hasConversation("conv-1")).toBe(true);
      expect(tracker.getNextAgent("conv-1")).toBe("forge");
      expect(tracker.isComplete("conv-1")).toBe(false);
    });

    test("copies agents array by value", () => {
      const team = { ...twoAgentTeam, agents: [...twoAgentTeam.agents] };
      tracker.startConversation("conv-1", team);
      team.agents.push("extra");
      tracker.addAgentResponse("conv-1", "forge", "done");
      tracker.addAgentResponse("conv-1", "tester", "done");
      expect(tracker.isComplete("conv-1")).toBe(true);
    });
  });

  describe("getNextAgent", () => {
    test("returns agents in order", () => {
      tracker.startConversation("conv-1", threeAgentTeam);
      expect(tracker.getNextAgent("conv-1")).toBe("forge");
      tracker.addAgentResponse("conv-1", "forge", "done");
      expect(tracker.getNextAgent("conv-1")).toBe("tester");
      tracker.addAgentResponse("conv-1", "tester", "done");
      expect(tracker.getNextAgent("conv-1")).toBe("analyst");
    });

    test("returns null for unknown conversation", () => {
      expect(tracker.getNextAgent("nonexistent")).toBeNull();
    });

    test("returns null when all agents responded", () => {
      tracker.startConversation("conv-1", singleAgentTeam);
      tracker.addAgentResponse("conv-1", "nyx", "done");
      expect(tracker.getNextAgent("conv-1")).toBeNull();
    });
  });

  describe("addAgentResponse", () => {
    test("advances agent index", () => {
      tracker.startConversation("conv-1", twoAgentTeam);
      tracker.addAgentResponse("conv-1", "forge", "my response");
      expect(tracker.getNextAgent("conv-1")).toBe("tester");
    });

    test("silently ignores unknown conversation", () => {
      tracker.addAgentResponse("nonexistent", "forge", "hello");
    });
  });

  describe("isComplete", () => {
    test("false during conversation", () => {
      tracker.startConversation("conv-1", twoAgentTeam);
      tracker.addAgentResponse("conv-1", "forge", "done");
      expect(tracker.isComplete("conv-1")).toBe(false);
    });

    test("true after all agents respond", () => {
      tracker.startConversation("conv-1", twoAgentTeam);
      tracker.addAgentResponse("conv-1", "forge", "done");
      tracker.addAgentResponse("conv-1", "tester", "done");
      expect(tracker.isComplete("conv-1")).toBe(true);
    });

    test("true for unknown conversation", () => {
      expect(tracker.isComplete("nonexistent")).toBe(true);
    });

    test("true for single-agent team after one response", () => {
      tracker.startConversation("conv-1", singleAgentTeam);
      tracker.addAgentResponse("conv-1", "nyx", "done");
      expect(tracker.isComplete("conv-1")).toBe(true);
    });
  });

  describe("getAggregatedResponse", () => {
    test("single agent returns raw content", () => {
      tracker.startConversation("conv-1", singleAgentTeam);
      tracker.addAgentResponse("conv-1", "nyx", "My response here");
      expect(tracker.getAggregatedResponse("conv-1")).toBe("My response here");
    });

    test("two agents formats with headers and separator", () => {
      tracker.startConversation("conv-1", twoAgentTeam);
      tracker.addAgentResponse("conv-1", "forge", "Code written");
      tracker.addAgentResponse("conv-1", "tester", "Tests passed");
      expect(tracker.getAggregatedResponse("conv-1")).toBe(
        "**forge:**\nCode written\n\n---\n\n**tester:**\nTests passed",
      );
    });

    test("three agents includes all sections", () => {
      tracker.startConversation("conv-1", threeAgentTeam);
      tracker.addAgentResponse("conv-1", "forge", "Built");
      tracker.addAgentResponse("conv-1", "tester", "Tested");
      tracker.addAgentResponse("conv-1", "analyst", "Analyzed");
      const result = tracker.getAggregatedResponse("conv-1");
      expect(result).toContain("**forge:**\nBuilt");
      expect(result).toContain("**tester:**\nTested");
      expect(result).toContain("**analyst:**\nAnalyzed");
      expect(result.split("---").length).toBe(3);
    });

    test("returns empty string for unknown conversation", () => {
      expect(tracker.getAggregatedResponse("nonexistent")).toBe("");
    });

    test("returns empty string before any responses", () => {
      tracker.startConversation("conv-1", twoAgentTeam);
      expect(tracker.getAggregatedResponse("conv-1")).toBe("");
    });
  });

  describe("getConversationContext", () => {
    test("formats with agent labels", () => {
      tracker.startConversation("conv-1", twoAgentTeam);
      tracker.addAgentResponse("conv-1", "forge", "I wrote code");
      tracker.addAgentResponse("conv-1", "tester", "I tested it");
      expect(tracker.getConversationContext("conv-1")).toBe(
        "[forge]: I wrote code\n\n[tester]: I tested it",
      );
    });

    test("empty for unknown conversation", () => {
      expect(tracker.getConversationContext("nonexistent")).toBe("");
    });

    test("empty before any messages", () => {
      tracker.startConversation("conv-1", twoAgentTeam);
      expect(tracker.getConversationContext("conv-1")).toBe("");
    });

    test("single agent has no separator", () => {
      tracker.startConversation("conv-1", singleAgentTeam);
      tracker.addAgentResponse("conv-1", "nyx", "hello");
      expect(tracker.getConversationContext("conv-1")).toBe("[nyx]: hello");
    });
  });

  describe("endConversation", () => {
    test("removes state completely", () => {
      tracker.startConversation("conv-1", twoAgentTeam);
      tracker.endConversation("conv-1");
      expect(tracker.hasConversation("conv-1")).toBe(false);
    });

    test("safe on nonexistent conversation", () => {
      tracker.endConversation("nonexistent");
    });

    test("getNextAgent returns null after end", () => {
      tracker.startConversation("conv-1", twoAgentTeam);
      tracker.endConversation("conv-1");
      expect(tracker.getNextAgent("conv-1")).toBeNull();
    });
  });

  describe("hasConversation", () => {
    test("true for active conversation", () => {
      tracker.startConversation("conv-1", twoAgentTeam);
      expect(tracker.hasConversation("conv-1")).toBe(true);
    });

    test("false for nonexistent", () => {
      expect(tracker.hasConversation("nonexistent")).toBe(false);
    });

    test("false after ended", () => {
      tracker.startConversation("conv-1", twoAgentTeam);
      tracker.endConversation("conv-1");
      expect(tracker.hasConversation("conv-1")).toBe(false);
    });

    test("tracks multiple conversations independently", () => {
      tracker.startConversation("conv-1", twoAgentTeam);
      tracker.startConversation("conv-2", threeAgentTeam);
      expect(tracker.hasConversation("conv-1")).toBe(true);
      expect(tracker.hasConversation("conv-2")).toBe(true);
      tracker.endConversation("conv-1");
      expect(tracker.hasConversation("conv-1")).toBe(false);
      expect(tracker.hasConversation("conv-2")).toBe(true);
    });
  });
});

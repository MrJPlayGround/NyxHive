import { describe, it, expect } from "bun:test";
import { routeMessage } from "../agents/routing.js";
import type { AgentConfig, TeamConfig } from "../types.js";

const makeAgent = (name: string, role: string): AgentConfig =>
  ({
    name,
    role,
    provider: "anthropic",
    model: "sonnet",
    working_directory: "/tmp",
  }) as AgentConfig;

const agents: Record<string, AgentConfig> = {
  nyx: makeAgent("Nyx", "lead"),
  analyst: makeAgent("Analyst", "worker"),
  tester: makeAgent("Tester", "worker"),
};

const teams: Record<string, TeamConfig> = {
  engineering: { name: "Engineering", agents: ["nyx", "analyst"] },
  ops: { name: "Ops", agents: ["tester"] },
};

describe("agent routing", () => {
  describe("@mention routing", () => {
    it("routes @analyst to the analyst agent", () => {
      const result = routeMessage("@analyst check this code", agents, teams, "nyx");
      expect(result.type).toBe("agent");
      expect(result.name).toBe("analyst");
      expect(result.agent?.name).toBe("Analyst");
    });

    it("routes @tester to the tester agent", () => {
      const result = routeMessage("@tester run the suite", agents, teams, "nyx");
      expect(result.type).toBe("agent");
      expect(result.name).toBe("tester");
    });
  });

  describe("case-insensitive matching", () => {
    it("routes @Analyst (capitalized) to analyst", () => {
      const result = routeMessage("@Analyst review this", agents, teams, "nyx");
      expect(result.type).toBe("agent");
      expect(result.name).toBe("analyst");
    });

    it("routes @ANALYST (uppercase) to analyst", () => {
      const result = routeMessage("@ANALYST review this", agents, teams, "nyx");
      expect(result.type).toBe("agent");
      expect(result.name).toBe("analyst");
    });

    it("routes @Nyx (capitalized) to nyx", () => {
      const result = routeMessage("@Nyx do the thing", agents, teams, "nyx");
      expect(result.type).toBe("agent");
      expect(result.name).toBe("nyx");
    });
  });

  describe("@team mention routing", () => {
    it("routes @engineering to the engineering team", () => {
      const result = routeMessage("@engineering deploy this", agents, teams, "nyx");
      expect(result.type).toBe("team");
      expect(result.name).toBe("engineering");
      expect(result.team?.name).toBe("Engineering");
      expect(result.team?.agents).toEqual(["nyx", "analyst"]);
    });

    it("routes @Engineering (capitalized) to the engineering team", () => {
      const result = routeMessage("@Engineering deploy this", agents, teams, "nyx");
      expect(result.type).toBe("team");
      expect(result.name).toBe("engineering");
    });

    it("teams take priority over agents with same name", () => {
      const agentsWithTeamName: Record<string, AgentConfig> = {
        ...agents,
        engineering: makeAgent("Engineering", "worker"),
      };
      const result = routeMessage("@engineering build it", agentsWithTeamName, teams, "nyx");
      expect(result.type).toBe("team");
      expect(result.name).toBe("engineering");
    });
  });

  describe("default agent fallback", () => {
    it("routes to default agent when no @mention", () => {
      const result = routeMessage("hello world", agents, teams, "nyx");
      expect(result.type).toBe("agent");
      expect(result.name).toBe("nyx");
      expect(result.agent?.name).toBe("Nyx");
    });

    it("routes to first agent when no default specified", () => {
      const result = routeMessage("hello world", agents, teams);
      expect(result.type).toBe("agent");
      expect(result.name).toBe("nyx");
    });

    it("throws when no agents configured", () => {
      expect(() => routeMessage("hello", {}, teams)).toThrow("No agents configured");
    });
  });

  describe("unknown @mention fallback", () => {
    it("falls through to default agent for unknown @mention", () => {
      const result = routeMessage("@unknown do something", agents, teams, "nyx");
      expect(result.type).toBe("agent");
      expect(result.name).toBe("nyx");
    });

    it("falls through to first agent when no default and unknown mention", () => {
      const result = routeMessage("@ghost help", agents, teams);
      expect(result.type).toBe("agent");
      expect(result.name).toBe("nyx");
    });
  });

  describe("message stripping", () => {
    it("strips @mention from the message", () => {
      const result = routeMessage("@analyst check this code", agents, teams, "nyx");
      expect(result.strippedMessage).toBe("check this code");
    });

    it("preserves full message when no @mention", () => {
      const result = routeMessage("just a normal message", agents, teams, "nyx");
      expect(result.strippedMessage).toBe("just a normal message");
    });

    it("preserves full message for unknown @mention fallback", () => {
      const result = routeMessage("@unknown do something", agents, teams, "nyx");
      expect(result.strippedMessage).toBe("@unknown do something");
    });

    it("strips team @mention from the message", () => {
      const result = routeMessage("@engineering deploy now", agents, teams, "nyx");
      expect(result.strippedMessage).toBe("deploy now");
    });

    it("handles @mention with no trailing message", () => {
      // Regex matches @analyst with \s* (zero whitespace ok), stripped is empty so falls back to original
      const result = routeMessage("@analyst", agents, teams, "nyx");
      expect(result.type).toBe("agent");
      expect(result.name).toBe("analyst");
      expect(result.strippedMessage).toBe("@analyst");
    });

    it("handles multiline messages after @mention", () => {
      const result = routeMessage("@analyst check this\nand this too", agents, teams, "nyx");
      expect(result.strippedMessage).toBe("check this\nand this too");
    });
  });
});

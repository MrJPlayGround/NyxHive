import { describe, test, expect } from "bun:test";
import { routeMessage } from "../agents/routing.js";
import type { AgentConfig, TeamConfig } from "../types.js";

const agents: Record<string, AgentConfig> = {
  nyx: { name: "Nyx", provider: "anthropic", model: "claude-sonnet-4-6", working_directory: "/tmp/nyx" },
  forge: { name: "Forge", provider: "anthropic", model: "claude-sonnet-4-6", working_directory: "/tmp/forge" },
};

const teams: Record<string, TeamConfig> = {
  dev: { name: "Dev Team", agents: ["forge", "tester"] },
  ops: { name: "Ops Team", agents: ["analyst"], description: "Research and analysis" },
};

describe("routeMessage", () => {
  describe("agent mention routing", () => {
    test("routes @forge to forge agent", () => {
      const result = routeMessage("@forge fix the bug", agents, teams);
      expect(result.type).toBe("agent");
      expect(result.name).toBe("forge");
      expect(result.agent?.name).toBe("Forge");
      expect(result.strippedMessage).toBe("fix the bug");
    });

    test("case insensitive — @FORGE routes to forge", () => {
      const result = routeMessage("@FORGE fix it", agents, teams);
      expect(result.type).toBe("agent");
      expect(result.name).toBe("forge");
    });

    test("case insensitive — @Nyx routes to nyx", () => {
      const result = routeMessage("@Nyx hello", agents, teams);
      expect(result.type).toBe("agent");
      expect(result.name).toBe("nyx");
    });
  });

  describe("team mention routing", () => {
    test("routes @dev to dev team", () => {
      const result = routeMessage("@dev build the feature", agents, teams);
      expect(result.type).toBe("team");
      expect(result.name).toBe("dev");
      expect(result.team?.name).toBe("Dev Team");
      expect(result.strippedMessage).toBe("build the feature");
    });

    test("case insensitive — @OPS routes to ops team", () => {
      const result = routeMessage("@OPS check status", agents, teams);
      expect(result.type).toBe("team");
      expect(result.name).toBe("ops");
    });
  });

  describe("teams take priority", () => {
    test("team wins over agent with same name", () => {
      const conflictAgents: Record<string, AgentConfig> = {
        dev: { name: "Dev Agent", provider: "anthropic", model: "test", working_directory: "/tmp" },
      };
      const result = routeMessage("@dev do stuff", conflictAgents, teams);
      expect(result.type).toBe("team");
      expect(result.name).toBe("dev");
    });
  });

  describe("message stripping", () => {
    test("strips mention and trims whitespace", () => {
      const result = routeMessage("@nyx   lots of spaces   ", agents, teams);
      expect(result.strippedMessage).toBe("lots of spaces");
    });

    test("bare @mention uses full message as strippedMessage", () => {
      const result = routeMessage("@nyx", agents, teams);
      expect(result.strippedMessage).toBe("@nyx");
    });

    test("multiline content preserved after mention", () => {
      const result = routeMessage("@forge line 1\nline 2\nline 3", agents, teams);
      expect(result.strippedMessage).toBe("line 1\nline 2\nline 3");
    });
  });

  describe("default agent fallback", () => {
    test("no mention falls back to specified default", () => {
      const result = routeMessage("just a message", agents, teams, "forge");
      expect(result.type).toBe("agent");
      expect(result.name).toBe("forge");
      expect(result.strippedMessage).toBe("just a message");
    });

    test("no mention and no default falls back to first agent", () => {
      const result = routeMessage("hello", agents, teams);
      expect(result.type).toBe("agent");
      expect(result.name).toBe("nyx");
    });

    test("unknown mention falls through to default", () => {
      const result = routeMessage("@unknown do something", agents, teams, "nyx");
      expect(result.type).toBe("agent");
      expect(result.name).toBe("nyx");
    });

    test("unknown mention with no default falls to first agent", () => {
      const result = routeMessage("@ghost hello", agents, teams);
      expect(result.type).toBe("agent");
      expect(result.name).toBe("nyx");
    });
  });

  describe("data-driven suggestions", () => {
    const mockRoutingStore = {
      getSuggestions: () => [
        { agent: "forge", task_type: "coding", success_rate: 95, total_tasks: 10, avg_cost_cents: 5, avg_duration_ms: 3000, composite_score: 92 },
      ],
    };

    test("suggests best agent from routing store when no @mention", () => {
      const result = routeMessage("implement the auth module", agents, teams, "nyx", {
        routingStore: mockRoutingStore,
        taskType: "coding",
      });
      expect(result.name).toBe("nyx"); // still routes to default
      expect(result.suggestedAgent).toBe("forge"); // enriched with suggestion
    });

    test("does not suggest agent below score threshold", () => {
      const lowScoreStore = {
        getSuggestions: () => [
          { agent: "forge", task_type: "coding", success_rate: 40, total_tasks: 3, avg_cost_cents: 5, avg_duration_ms: 3000, composite_score: 45 },
        ],
      };
      const result = routeMessage("implement something", agents, teams, "nyx", {
        routingStore: lowScoreStore,
        taskType: "coding",
      });
      expect(result.suggestedAgent).toBeUndefined();
    });

    test("does not add suggestion when @mention is present", () => {
      const result = routeMessage("@forge fix the bug", agents, teams, "nyx", {
        routingStore: mockRoutingStore,
        taskType: "coding",
      });
      expect(result.name).toBe("forge");
      expect(result.suggestedAgent).toBeUndefined();
    });

    test("no suggestion without routing hints", () => {
      const result = routeMessage("implement the auth module", agents, teams, "nyx");
      expect(result.suggestedAgent).toBeUndefined();
    });

    test("no suggestion when agent not in config", () => {
      const unknownAgentStore = {
        getSuggestions: () => [
          { agent: "unknown_agent", task_type: "coding", success_rate: 95, total_tasks: 10, avg_cost_cents: 5, avg_duration_ms: 3000, composite_score: 92 },
        ],
      };
      const result = routeMessage("implement something", agents, teams, "nyx", {
        routingStore: unknownAgentStore,
        taskType: "coding",
      });
      expect(result.suggestedAgent).toBeUndefined();
    });
  });

  describe("error handling", () => {
    test("throws when no agents configured", () => {
      expect(() => routeMessage("hello", {}, {})).toThrow("No agents configured");
    });
  });

  describe("edge cases", () => {
    test("mid-message @mention is not parsed", () => {
      const result = routeMessage("please ask @forge to help", agents, teams);
      expect(result.type).toBe("agent");
      expect(result.name).toBe("nyx");
      expect(result.strippedMessage).toBe("please ask @forge to help");
    });

    test("empty message routes to default", () => {
      const result = routeMessage("", agents, teams);
      expect(result.type).toBe("agent");
      expect(result.name).toBe("nyx");
    });

    test("agent route includes agent config, no team", () => {
      const result = routeMessage("@forge test", agents, teams);
      expect(result.agent).toBeDefined();
      expect(result.team).toBeUndefined();
    });

    test("team route includes team config, no agent", () => {
      const result = routeMessage("@dev test", agents, teams);
      expect(result.team).toBeDefined();
      expect(result.agent).toBeUndefined();
    });
  });
});

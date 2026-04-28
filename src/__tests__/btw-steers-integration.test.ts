import { describe, it, expect } from "bun:test";
import { parseBtwTags, parseSteerTags, parseActorMentions } from "../agents/actor.js";

describe("Action tag parsing", () => {
  describe("parseBtwTags", () => {
    it("parses [@btw agent: question]", () => {
      const { btws, cleanedResponse } = parseBtwTags(
        "Working on it. [@btw forge: what file handles retries?] Will continue.",
      );
      expect(btws).toHaveLength(1);
      expect(btws[0].agent).toBe("forge");
      expect(btws[0].content).toBe("what file handles retries?");
      expect(cleanedResponse).toBe("Working on it.  Will continue.");
    });

    it("parses multiple btw tags", () => {
      const { btws } = parseBtwTags(
        "[@btw forge: question one] some text [@btw analyst: question two]",
      );
      expect(btws).toHaveLength(2);
      expect(btws[0].agent).toBe("forge");
      expect(btws[0].content).toBe("question one");
      expect(btws[1].agent).toBe("analyst");
      expect(btws[1].content).toBe("question two");
    });

    it("is case-insensitive on the btw keyword", () => {
      const { btws } = parseBtwTags("[@BTW forge: is this working?]");
      expect(btws).toHaveLength(1);
      expect(btws[0].agent).toBe("forge");
    });

    it("lowercases agent names", () => {
      const { btws } = parseBtwTags("[@btw Forge: question]");
      expect(btws).toHaveLength(1);
      expect(btws[0].agent).toBe("forge");
    });

    it("ignores btw tags inside code blocks", () => {
      const response = "Here's an example:\n```\n[@btw forge: this is code]\n```\nDone.";
      const { btws } = parseBtwTags(response);
      expect(btws).toHaveLength(0);
    });

    it("ignores btw tags inside inline code", () => {
      const { btws } = parseBtwTags("Use `[@btw forge: like this]` syntax.");
      expect(btws).toHaveLength(0);
    });

    it("strips btw tags from response", () => {
      const { cleanedResponse } = parseBtwTags(
        "Before.\n\n[@btw forge: question]\n\nAfter.",
      );
      expect(cleanedResponse).toBe("Before.\n\nAfter.");
    });

    it("returns empty array when no btw tags present", () => {
      const { btws, cleanedResponse } = parseBtwTags("No tags here.");
      expect(btws).toHaveLength(0);
      expect(cleanedResponse).toBe("No tags here.");
    });
  });

  describe("parseSteerTags", () => {
    it("parses [@steer agent: message]", () => {
      const { steers, cleanedResponse } = parseSteerTags(
        "Delegating. [@steer forge: focus on error handling first] More context.",
      );
      expect(steers).toHaveLength(1);
      expect(steers[0].agent).toBe("forge");
      expect(steers[0].content).toBe("focus on error handling first");
      expect(cleanedResponse).toBe("Delegating.  More context.");
    });

    it("parses multiple steer tags", () => {
      const { steers } = parseSteerTags(
        "[@steer forge: do X] [@steer tester: skip flaky tests]",
      );
      expect(steers).toHaveLength(2);
      expect(steers[0].agent).toBe("forge");
      expect(steers[1].agent).toBe("tester");
      expect(steers[1].content).toBe("skip flaky tests");
    });

    it("is case-insensitive on the steer keyword", () => {
      const { steers } = parseSteerTags("[@STEER forge: do something]");
      expect(steers).toHaveLength(1);
    });

    it("lowercases agent names", () => {
      const { steers } = parseSteerTags("[@steer Tester: run unit tests]");
      expect(steers).toHaveLength(1);
      expect(steers[0].agent).toBe("tester");
    });

    it("ignores steer tags inside code blocks", () => {
      const response = "```\n[@steer forge: inside code]\n```";
      const { steers } = parseSteerTags(response);
      expect(steers).toHaveLength(0);
    });

    it("strips steer tags from response", () => {
      const { cleanedResponse } = parseSteerTags(
        "Start.\n\n[@steer forge: do it]\n\nEnd.",
      );
      expect(cleanedResponse).toBe("Start.\n\nEnd.");
    });

    it("returns empty array when no steer tags present", () => {
      const { steers } = parseSteerTags("Just normal text.");
      expect(steers).toHaveLength(0);
    });
  });

  describe("mixed tags", () => {
    it("btw and steer tags do not interfere with each other", () => {
      const text = "[@btw analyst: what's the status?] [@steer forge: hurry up]";
      const { btws } = parseBtwTags(text);
      const { steers } = parseSteerTags(text);
      expect(btws).toHaveLength(1);
      expect(btws[0].agent).toBe("analyst");
      expect(steers).toHaveLength(1);
      expect(steers[0].agent).toBe("forge");
    });

    it("btw/steer are not treated as unknown agents in parseActorMentions", () => {
      const knownAgents = new Set(["forge", "analyst"]);
      const { unknownAgents } = parseActorMentions(
        "[@btw forge: question] [@steer analyst: hint] [@forge: real task]",
        knownAgents,
      );
      // btw and steer should not appear as unknown agents
      expect(unknownAgents).toHaveLength(0);
    });
  });
});

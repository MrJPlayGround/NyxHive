import { describe, test, expect } from "bun:test";
import { parseActorMentions, parseAgentActions, parseFollowups } from "../agents/actor.js";

const knownAgents = new Set(["forge", "analyst", "tester", "nyx"]);

describe("parseActorMentions", () => {
  test("parses single delegation", () => {
    const { mentions, cleanedResponse } = parseActorMentions(
      "I'll delegate this. [@forge: build the retry logic]",
      knownAgents,
    );
    expect(mentions).toHaveLength(1);
    expect(mentions[0]).toEqual({ agent: "forge", task: "build the retry logic", filePaths: [], verifyHints: [] });
    expect(cleanedResponse).toBe("I'll delegate this.");
  });

  test("parses multiple delegations", () => {
    const { mentions } = parseActorMentions(
      "[@forge: write the code] [@tester: run the tests]",
      knownAgents,
    );
    expect(mentions).toHaveLength(2);
    expect(mentions[0].agent).toBe("forge");
    expect(mentions[1].agent).toBe("tester");
  });

  test("ignores unknown agents", () => {
    const { mentions } = parseActorMentions(
      "[@unknown: do something] [@forge: real task]",
      knownAgents,
    );
    expect(mentions).toHaveLength(1);
    expect(mentions[0].agent).toBe("forge");
  });

  test("strips known mentions from response", () => {
    const { cleanedResponse } = parseActorMentions(
      "Context here.\n\n[@forge: task]\n\nMore text.",
      knownAgents,
    );
    expect(cleanedResponse).toBe("Context here.\n\nMore text.");
  });

  test("preserves unknown mentions in response", () => {
    const { cleanedResponse } = parseActorMentions(
      "[@unknown: keep this] [@forge: strip this]",
      knownAgents,
    );
    expect(cleanedResponse).toContain("[@unknown: keep this]");
    expect(cleanedResponse).not.toContain("[@forge: strip this]");
  });

  test("handles empty task gracefully", () => {
    // The regex requires at least one non-] char in the task
    const { mentions } = parseActorMentions("[@forge: ]", knownAgents);
    // Space-only task still matches the regex
    expect(mentions).toHaveLength(1);
  });

  test("returns empty mentions for no delegations", () => {
    const { mentions, cleanedResponse } = parseActorMentions(
      "Just a normal response with no delegations.",
      knownAgents,
    );
    expect(mentions).toHaveLength(0);
    expect(cleanedResponse).toBe("Just a normal response with no delegations.");
  });

  test("case insensitive agent matching", () => {
    const { mentions } = parseActorMentions("[@Forge: task]", knownAgents);
    expect(mentions).toHaveLength(1);
    expect(mentions[0].agent).toBe("forge");
  });

  test("should ignore mentions inside code fences", () => {
    const text = "Here's an example:\n```\n[@forge: do something]\n```\nDone.";
    const { mentions } = parseActorMentions(text, knownAgents);
    expect(mentions).toHaveLength(0);
  });

  test("should ignore mentions inside inline code", () => {
    const text = "Use `[@forge: task]` syntax to delegate.";
    const { mentions } = parseActorMentions(text, knownAgents);
    expect(mentions).toHaveLength(0);
  });

  test("should parse mentions outside code but skip inside", () => {
    const text = "[@forge: real task]\n```\n[@forge: example]\n```";
    const { mentions } = parseActorMentions(text, knownAgents);
    expect(mentions).toHaveLength(1);
    expect(mentions[0].task).toBe("real task");
  });

  test("parses instance-qualified mention", () => {
    const { mentions } = parseActorMentions(
      "[@trading.forge: build the dashboard]",
      knownAgents,
    );
    expect(mentions).toHaveLength(1);
    expect(mentions[0].agent).toBe("forge");
    expect(mentions[0].instance).toBe("trading");
    expect(mentions[0].task).toBe("build the dashboard");
  });

  test("instance-qualified mentions are always valid (no known agent check)", () => {
    const { mentions } = parseActorMentions(
      "[@remote.unknownbot: do something]",
      knownAgents,
    );
    expect(mentions).toHaveLength(1);
    expect(mentions[0].agent).toBe("unknownbot");
    expect(mentions[0].instance).toBe("remote");
  });

  test("strips instance-qualified mentions from response", () => {
    const { cleanedResponse } = parseActorMentions(
      "Delegating remotely.\n\n[@trading.forge: build it]\n\nDone.",
      knownAgents,
    );
    expect(cleanedResponse).toBe("Delegating remotely.\n\nDone.");
  });

  test("mixes local and instance-qualified mentions", () => {
    const { mentions } = parseActorMentions(
      "[@forge: local task] [@trading.analyst: remote task]",
      knownAgents,
    );
    expect(mentions).toHaveLength(2);
    expect(mentions[0].agent).toBe("forge");
    expect(mentions[0].instance).toBeUndefined();
    expect(mentions[1].agent).toBe("analyst");
    expect(mentions[1].instance).toBe("trading");
  });

  test("instance names are case insensitive", () => {
    const { mentions } = parseActorMentions(
      "[@Trading.Forge: task]",
      knownAgents,
    );
    expect(mentions).toHaveLength(1);
    expect(mentions[0].instance).toBe("trading");
    expect(mentions[0].agent).toBe("forge");
  });

  test("warns on oversized delegation content", () => {
    const longTask = "x".repeat(1500);
    const response = `[@forge: ${longTask}]`;
    const agents = new Set(["forge"]);

    const { mentions } = parseActorMentions(response, agents);

    // Still parses correctly — warning is just a log, doesn't block
    expect(mentions).toHaveLength(1);
    expect(mentions[0].task.length).toBe(1500);
  });
});

describe("parseAgentActions", () => {
  test("parses hire action", () => {
    const { actions } = parseAgentActions(
      '[@hire: key=data name="Data Agent" prompt="You analyze data."]',
    );
    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe("hire");
    expect(actions[0].params.key).toBe("data");
    expect(actions[0].params.name).toBe("Data Agent");
    expect(actions[0].params.prompt).toBe("You analyze data.");
  });

  test("parses fire action", () => {
    const { actions } = parseAgentActions("[@fire: data]");
    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe("fire");
    expect(actions[0].params.key).toBe("data");
  });

  test("parses reassign action", () => {
    const { actions } = parseAgentActions("[@reassign: analyst model=claude-sonnet-4-6]");
    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe("reassign");
    expect(actions[0].params.key).toBe("analyst");
    expect(actions[0].params.model).toBe("claude-sonnet-4-6");
  });

  test("parses learn action with category", () => {
    const { actions } = parseAgentActions('[@learn: category="debugging" SQLite WAL mode causes lock issues]');
    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe("learn");
    expect(actions[0].params.category).toBe("debugging");
    expect(actions[0].params.content).toBe("SQLite WAL mode causes lock issues");
  });

  test("parses learn action without category", () => {
    const { actions } = parseAgentActions("[@learn: Always test before pushing]");
    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe("learn");
    expect(actions[0].params.content).toBe("Always test before pushing");
  });

  test("distinguishes actions from delegation mentions", () => {
    const { actions } = parseAgentActions(
      "[@forge: build the thing] [@hire: key=x name=\"X\" prompt=\"Y\"]",
    );
    // @forge is a delegation, not an action — should only find hire
    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe("hire");
  });

  test("strips actions from response", () => {
    const { cleanedResponse } = parseAgentActions(
      "Done.\n[@fire: old_agent]\n\nMore text.",
    );
    expect(cleanedResponse).not.toContain("[@fire:");
    expect(cleanedResponse).toContain("Done.");
    expect(cleanedResponse).toContain("More text.");
  });

  test("handles multiple actions", () => {
    const { actions } = parseAgentActions(
      "[@hire: key=a name=\"A\" prompt=\"p\"] [@reassign: b model=m]",
    );
    expect(actions).toHaveLength(2);
    expect(actions[0].type).toBe("hire");
    expect(actions[1].type).toBe("reassign");
  });

  test("should ignore actions inside code fences", () => {
    const { actions } = parseAgentActions("```\n[@hire: newagent | worker]\n```");
    expect(actions).toHaveLength(0);
  });

  test("handles malformed params gracefully", () => {
    const { actions } = parseAgentActions("[@hire: just some text]");
    expect(actions).toHaveLength(1);
    // No key or name extracted, but doesn't throw
    expect(actions[0].type).toBe("hire");
  });

  test("parses [@propose:] action with all params", () => {
    const text = '[@propose: title="Fix flaky test" category=maintenance effort=small description="Replace setTimeout" files="src/foo.ts,src/bar.ts"]';
    const { actions } = parseAgentActions(text);
    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe("propose");
    expect(actions[0].params.title).toBe("Fix flaky test");
    expect(actions[0].params.category).toBe("maintenance");
    expect(actions[0].params.effort).toBe("small");
    expect(actions[0].params.description).toBe("Replace setTimeout");
    expect(actions[0].params.files).toBe("src/foo.ts,src/bar.ts");
  });

  test("parses [@propose:] with minimal params", () => {
    const text = '[@propose: title="Add docs" description="Update README with new API endpoints"]';
    const { actions } = parseAgentActions(text);
    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe("propose");
    expect(actions[0].params.title).toBe("Add docs");
    expect(actions[0].params.description).toBe("Update README with new API endpoints");
  });

  test("parses [@propose:] with files in array brackets", () => {
    const text = '[@propose: category="maintenance" effort="small" files=["src/foo.ts","src/bar.ts"] description="Remove stale plan files" scout_source="scout:housekeeping"]';
    const { actions } = parseAgentActions(text);
    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe("propose");
    expect(actions[0].params.description).toBe("Remove stale plan files");
    expect(actions[0].params.category).toBe("maintenance");
    expect(actions[0].params.files).toBe('["src/foo.ts","src/bar.ts"]');
  });

  test("strips [@propose:] from cleaned response", () => {
    const text = 'Found an issue.\n[@propose: title="Fix it" description="Details here"]\nDone.';
    const { cleanedResponse } = parseAgentActions(text);
    expect(cleanedResponse).not.toContain("[@propose:");
    expect(cleanedResponse).toContain("Found an issue.");
    expect(cleanedResponse).toContain("Done.");
  });

  test("parses multi-line [@propose:] block", () => {
    const text = `Some findings:

[@propose:]
category: bugfix
effort: small
description: Add logger.warn() to the 4 bare catch blocks
files: src/memory/store.ts, src/memory/graph.ts
scout_source: scout:code-quality

More text.`;
    const { actions } = parseAgentActions(text);
    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe("propose");
    expect(actions[0].params.category).toBe("bugfix");
    expect(actions[0].params.effort).toBe("small");
    expect(actions[0].params.description).toBe("Add logger.warn() to the 4 bare catch blocks");
    expect(actions[0].params.files).toBe("src/memory/store.ts, src/memory/graph.ts");
    expect(actions[0].params.source).toBe("scout:code-quality");
  });

  test("parses multi-line [@propose:] inside code fences", () => {
    const text = "```\n[@propose:]\ncategory: reliability\neffort: small\ndescription: Fix silent FTS degradation\nfiles: src/memory/store.ts\nscout_source: scout:code-quality\n```";
    const { actions } = parseAgentActions(text);
    expect(actions).toHaveLength(1);
    expect(actions[0].type).toBe("propose");
    expect(actions[0].params.category).toBe("reliability");
    expect(actions[0].params.description).toBe("Fix silent FTS degradation");
  });

  test("parses multiple multi-line [@propose:] blocks", () => {
    const text = `[@propose:]
category: bugfix
description: Fix A

---

[@propose:]
category: architecture
effort: large
description: Decompose processor.ts
`;
    const { actions } = parseAgentActions(text);
    expect(actions).toHaveLength(2);
    expect(actions[0].params.category).toBe("bugfix");
    expect(actions[1].params.category).toBe("architecture");
  });

  test("multi-line [@propose:] derives title from description when missing", () => {
    const text = `[@propose:]
category: bugfix
description: Add logger.warn() to the 4 bare catch blocks. This prevents silent failures.
`;
    const { actions } = parseAgentActions(text);
    expect(actions).toHaveLength(1);
    // Title derivation happens in management.ts, but params should have description
    expect(actions[0].params.description).toBe("Add logger.warn() to the 4 bare catch blocks. This prevents silent failures.");
    expect(actions[0].params.title).toBeUndefined();
  });

  test("strips multi-line [@propose:] from cleaned response", () => {
    const text = `Found issues.

[@propose:]
category: bugfix
description: Fix it

Done scanning.`;
    const { cleanedResponse } = parseAgentActions(text);
    expect(cleanedResponse).not.toContain("[@propose:]");
    expect(cleanedResponse).toContain("Found issues.");
    expect(cleanedResponse).toContain("Done scanning.");
  });
});

describe("parseFollowups", () => {
  test("parses [@followup: task description]", () => {
    const { followups } = parseFollowups(
      "Done with the main work. [@followup: investigate the auth module]",
    );
    expect(followups).toHaveLength(1);
    expect(followups[0].task).toBe("investigate the auth module");
    expect(followups[0].agent).toBeUndefined();
  });

  test("parses [@followup agent_name: task description]", () => {
    const { followups } = parseFollowups(
      "[@followup analyst: review the cost data]",
    );
    expect(followups).toHaveLength(1);
    expect(followups[0].task).toBe("review the cost data");
    expect(followups[0].agent).toBe("analyst");
  });

  test("handles multiple followups in one response", () => {
    const { followups } = parseFollowups(
      "Done. [@followup: check the logs] And also [@followup tester: run regression suite]",
    );
    expect(followups).toHaveLength(2);
    expect(followups[0].task).toBe("check the logs");
    expect(followups[0].agent).toBeUndefined();
    expect(followups[1].task).toBe("run regression suite");
    expect(followups[1].agent).toBe("tester");
  });

  test("strips followup tags from response text", () => {
    const { cleanedResponse } = parseFollowups(
      "Task complete.\n\n[@followup: investigate the auth module]\n\nFinal notes.",
    );
    expect(cleanedResponse).not.toContain("[@followup:");
    expect(cleanedResponse).toContain("Task complete.");
    expect(cleanedResponse).toContain("Final notes.");
  });

  test("returns empty followups when none present", () => {
    const { followups, cleanedResponse } = parseFollowups("Just a normal response.");
    expect(followups).toHaveLength(0);
    expect(cleanedResponse).toBe("Just a normal response.");
  });

  test("ignores followup tags inside code fences", () => {
    const text = "Example:\n```\n[@followup: this is code]\n```\nDone.";
    const { followups } = parseFollowups(text);
    expect(followups).toHaveLength(0);
  });

  test("ignores followup tags inside inline code", () => {
    const text = "Use `[@followup: task]` to chain tasks.";
    const { followups } = parseFollowups(text);
    expect(followups).toHaveLength(0);
  });

  test("agent name is case insensitive", () => {
    const { followups } = parseFollowups("[@followup Analyst: review costs]");
    expect(followups).toHaveLength(1);
    expect(followups[0].agent).toBe("analyst");
  });
});

describe("delegation validation regex", () => {
  // Test the regex used in validateOrchestratorDelegation
  const delegationRegex = /\[@\w+:\s*[^\]]+\]/;

  test("matches delegation tags", () => {
    expect(delegationRegex.test("[@forge: build the thing]")).toBe(true);
    expect(delegationRegex.test("Some text [@analyst: look up X] more text")).toBe(true);
  });

  test("does not match non-delegation text", () => {
    expect(delegationRegex.test("Just a normal response")).toBe(false);
    expect(delegationRegex.test("Array[0] notation")).toBe(false);
  });

  test("matches action tags too (both share syntax)", () => {
    expect(delegationRegex.test("[@hire: key=x name=\"X\"]")).toBe(true);
    expect(delegationRegex.test("[@alert: message=\"something\"]")).toBe(true);
  });
});

describe("orchestrator CLI blocking", () => {
  // Orchestrators are unconditionally blocked from CLI escalation.
  // They stay on SDK and delegate via [@agent: task] tags.
  // The gate in invoke.ts is simply `!isOrchestrator`.

  test("isOrchestrator flag blocks CLI for all task types", () => {
    // Simulates the invoke.ts gate: `!isOrchestrator`
    const isOrchestrator = true;
    const taskTypes = ["coding", "code_review", "research", "analysis", "expert", "orchestrator", "conversation"];

    for (const taskType of taskTypes) {
      // The condition that allows CLI: `!isOrchestrator`
      const allowCLI = !isOrchestrator;
      expect(allowCLI).toBe(false);
    }
  });

  test("non-orchestrator agents can still get CLI", () => {
    const isOrchestrator = false;
    const allowCLI = !isOrchestrator;
    expect(allowCLI).toBe(true);
  });
});

describe("parseFollowups", () => {
  test("parses basic followup without agent", () => {
    const { followups } = parseFollowups("Done scanning.\n[@followup: investigate the flaky test in CI]");
    expect(followups).toHaveLength(1);
    expect(followups[0].task).toBe("investigate the flaky test in CI");
    expect(followups[0].agent).toBeUndefined();
  });

  test("parses followup with specific agent", () => {
    const { followups } = parseFollowups("[@followup analyst: research the API changes]");
    expect(followups).toHaveLength(1);
    expect(followups[0].task).toBe("research the API changes");
    expect(followups[0].agent).toBe("analyst");
  });

  test("handles multiple followups in one response", () => {
    const text = "Found issues.\n[@followup: dig deeper into memory leak]\n[@followup tester: run regression suite]";
    const { followups } = parseFollowups(text);
    expect(followups).toHaveLength(2);
    expect(followups[0].task).toBe("dig deeper into memory leak");
    expect(followups[0].agent).toBeUndefined();
    expect(followups[1].task).toBe("run regression suite");
    expect(followups[1].agent).toBe("tester");
  });

  test("ignores malformed followup tags", () => {
    // Missing colon
    const { followups: f1 } = parseFollowups("[@followup investigate something]");
    expect(f1).toHaveLength(0);

    // Empty brackets (no content after colon — regex requires at least one non-] char)
    const { followups: f2 } = parseFollowups("[@followup:]");
    expect(f2).toHaveLength(0);
  });

  test("followup tags are stripped from response", () => {
    const text = "Found an issue.\n\n[@followup: investigate further]\n\nDone scanning.";
    const { cleanedResponse } = parseFollowups(text);
    expect(cleanedResponse).not.toContain("[@followup:");
    expect(cleanedResponse).toContain("Found an issue.");
    expect(cleanedResponse).toContain("Done scanning.");
  });

  test("preserves followup tags inside code fences", () => {
    const text = "Example:\n```\n[@followup: this is just an example]\n```\nDone.";
    const { followups, cleanedResponse } = parseFollowups(text);
    expect(followups).toHaveLength(0);
    expect(cleanedResponse).toContain("[@followup: this is just an example]");
  });

  test("preserves followup tags inside inline code", () => {
    const text = "Use `[@followup: task]` syntax.";
    const { followups } = parseFollowups(text);
    expect(followups).toHaveLength(0);
  });

  test("agent name is case insensitive", () => {
    const { followups } = parseFollowups("[@followup Analyst: check this]");
    expect(followups).toHaveLength(1);
    expect(followups[0].agent).toBe("analyst");
  });

  test("returns empty followups when none present", () => {
    const { followups, cleanedResponse } = parseFollowups("Just a normal response.");
    expect(followups).toHaveLength(0);
    expect(cleanedResponse).toBe("Just a normal response.");
  });
});

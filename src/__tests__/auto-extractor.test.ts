import { describe, test, expect } from "bun:test";
import {
  autoExtract,
  extractFilePaths,
  extractDecisions,
  extractErrors,
  extractCommands,
  extractDependencies,
} from "../memory/auto-extractor.js";

describe("extractFilePaths", () => {
  test("should extract src/ relative paths", () => {
    const text = `I modified src/queue/processor.ts and src/memory/graph.ts to add the new feature.`;
    const paths = extractFilePaths(text);
    expect(paths).toContain("src/queue/processor.ts");
    expect(paths).toContain("src/memory/graph.ts");
  });

  test("should extract absolute paths", () => {
    const text = `Reading /home/user/dev/nyxhive/src/types.ts for the type definitions.`;
    const paths = extractFilePaths(text);
    expect(paths).toContain("/home/user/dev/nyxhive/src/types.ts");
  });

  test("should extract paths in backticks", () => {
    const text = "Updated `src/utils/logger.ts` with new log format";
    const paths = extractFilePaths(text);
    expect(paths).toContain("src/utils/logger.ts");
  });

  test("should not extract URLs as file paths", () => {
    const text = "See https://example.com/path/to/docs.html for reference";
    const paths = extractFilePaths(text);
    expect(paths.length).toBe(0);
  });

  test("should extract test file paths", () => {
    const text = `Created tests/unit/auth.test.ts and tests/integration/api.test.ts`;
    const paths = extractFilePaths(text);
    expect(paths).toContain("tests/unit/auth.test.ts");
    expect(paths).toContain("tests/integration/api.test.ts");
  });

  test("should deduplicate paths", () => {
    const text = `Modified src/index.ts twice. First in src/index.ts line 10, then src/index.ts line 50.`;
    const paths = extractFilePaths(text);
    const indexCount = paths.filter(p => p === "src/index.ts").length;
    expect(indexCount).toBe(1);
  });
});

describe("extractDecisions", () => {
  test("should detect 'chose X over Y' pattern", () => {
    const text = "I chose SQLite over PostgreSQL because it's simpler for our use case.";
    const decisions = extractDecisions(text);
    expect(decisions.length).toBeGreaterThan(0);
    expect(decisions[0]).toContain("chose");
  });

  test("should detect 'decided to' pattern", () => {
    const text = "We decided to use Bun instead of Node for the runtime.";
    const decisions = extractDecisions(text);
    expect(decisions.length).toBeGreaterThan(0);
  });

  test("should detect 'went with' pattern", () => {
    const text = "I went with the functional approach rather than class-based.";
    const decisions = extractDecisions(text);
    expect(decisions.length).toBeGreaterThan(0);
  });

  test("should ignore short fragments", () => {
    const text = "I chose X.";
    const decisions = extractDecisions(text);
    expect(decisions.length).toBe(0);
  });

  test("should detect 'opted for' pattern", () => {
    const text = "I opted for manual stubs instead of a mocking framework to keep things lightweight.";
    const decisions = extractDecisions(text);
    expect(decisions.length).toBeGreaterThan(0);
  });
});

describe("extractErrors", () => {
  test("should extract TypeError", () => {
    const text = `TypeError: Cannot read property 'id' of undefined`;
    const errors = extractErrors(text);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("TypeError");
  });

  test("should extract generic Error", () => {
    const text = `Error: ENOENT: no such file or directory, open '/tmp/missing.json'`;
    const errors = extractErrors(text);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("ENOENT");
  });

  test("should extract FAIL lines", () => {
    const text = `FAIL src/__tests__/auth.test.ts > login > should validate credentials`;
    const errors = extractErrors(text);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("FAIL");
  });

  test("should extract stack traces", () => {
    const text = `at processMessage (/home/user/dev/nyxhive/src/queue/processor.ts:150:12)`;
    const errors = extractErrors(text);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("processMessage");
  });

  test("should extract multiple errors", () => {
    const text = `
TypeError: Cannot read property 'name' of null
ReferenceError: config is not defined
    `;
    const errors = extractErrors(text);
    expect(errors.length).toBe(2);
  });
});

describe("extractCommands", () => {
  test("should extract $ prefixed commands", () => {
    const text = `$ bun test src/__tests__/auth.test.ts`;
    const commands = extractCommands(text);
    expect(commands.length).toBe(1);
    expect(commands[0]).toContain("bun test");
  });

  test("should extract backtick-quoted commands", () => {
    const text = "I ran `git status` to check the current state";
    const commands = extractCommands(text);
    expect(commands.length).toBe(1);
    expect(commands[0]).toBe("git status");
  });

  test("should extract > prefixed known tool commands", () => {
    const text = `> npm install express`;
    const commands = extractCommands(text);
    expect(commands.length).toBe(1);
    expect(commands[0]).toContain("npm install");
  });

  test("should not extract random short strings", () => {
    const text = "The $ sign is used in template literals.";
    const commands = extractCommands(text);
    expect(commands.length).toBe(0);
  });
});

describe("extractDependencies", () => {
  test("should extract bun add packages", () => {
    const text = `$ bun add hono @hono/node-server`;
    const deps = extractDependencies(text);
    expect(deps.length).toBe(1);
    expect(deps[0]).toContain("hono");
  });

  test("should extract npm install packages", () => {
    const text = `$ npm install express cors`;
    const deps = extractDependencies(text);
    expect(deps.length).toBe(1);
    expect(deps[0]).toContain("express");
  });

  test("should extract mentioned package installs", () => {
    const text = "I added dependency `better-sqlite3` to the project";
    const deps = extractDependencies(text);
    expect(deps.length).toBe(1);
  });
});

describe("autoExtract", () => {
  test("should extract multiple types from realistic agent output", () => {
    const output = `I've completed the task. Here's what I did:

1. Modified src/queue/processor.ts to add the new extraction hook
2. Created src/memory/auto-extractor.ts with the heuristic patterns
3. I decided to use regex patterns instead of AST parsing because it's simpler and faster for our needs

$ bun test src/__tests__/auto-extractor.test.ts
FAIL src/__tests__/auto-extractor.test.ts > extractErrors > should handle edge case

TypeError: Cannot read property 'match' of undefined

Fixed the issue and ran tests again:
$ bun test
All 42 tests pass.`;

    const nodes = autoExtract(output);

    // Should have file_change nodes
    const fileNodes = nodes.filter(n => n.type === "file_change");
    expect(fileNodes.length).toBeGreaterThan(0);

    // Should have decision nodes
    const decisionNodes = nodes.filter(n => n.type === "decision");
    expect(decisionNodes.length).toBeGreaterThan(0);

    // Should have error nodes
    const errorNodes = nodes.filter(n => n.type === "error");
    expect(errorNodes.length).toBeGreaterThan(0);

    // Should have command/event nodes
    const eventNodes = nodes.filter(n => n.type === "event");
    expect(eventNodes.length).toBeGreaterThan(0);
  });

  test("should return empty array for simple text", () => {
    const nodes = autoExtract("Hello, how are you?");
    expect(nodes.length).toBe(0);
  });

  test("should cap file extractions at 20", () => {
    const paths = Array.from({ length: 30 }, (_, i) => `src/file${i}.ts`).join("\n");
    const nodes = autoExtract(paths);
    const fileNodes = nodes.filter(n => n.type === "file_change");
    expect(fileNodes.length).toBeLessThanOrEqual(20);
  });

  test("should set appropriate importance levels", () => {
    const output = `Modified src/types.ts.
I decided to use TypeScript generics for better type safety.
TypeError: Cannot read property 'id' of null`;

    const nodes = autoExtract(output);

    const fileNode = nodes.find(n => n.type === "file_change");
    const decisionNode = nodes.find(n => n.type === "decision");
    const errorNode = nodes.find(n => n.type === "error");

    expect(fileNode?.importance).toBe(0.3);
    expect(decisionNode?.importance).toBe(0.7);
    expect(errorNode?.importance).toBe(0.6);
  });
});

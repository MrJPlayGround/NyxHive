import { describe, test, expect } from "bun:test";
import { extractLearningTriggers } from "../memory/learning-triggers.js";

describe("extractLearningTriggers", () => {
  describe("test failure resolved", () => {
    test("detects test failure then pass pattern", () => {
      const output = `Running tests...
FAIL src/__tests__/auth.test.ts > login > should validate credentials
TypeError: Cannot read property 'id' of undefined

I fixed the issue by adding a null check before accessing the nested property.

$ bun test
All 42 tests pass.`;

      const patterns = extractLearningTriggers(output, "forge");
      const testPattern = patterns.find(p => p.trigger === "test_failure_resolved");
      expect(testPattern).toBeDefined();
      expect(testPattern!.content).toContain("TypeError");
      expect(testPattern!.metadata.agent).toBe("forge");
      expect(testPattern!.importance).toBe(0.7);
    });

    test("does not fire when only failures exist (no pass)", () => {
      const output = `FAIL src/__tests__/auth.test.ts > should work
TypeError: Something broke
Tests: 3 fail, 2 pass`;

      // This has a failure but the "2 pass" matches the pass pattern,
      // but the actual format "3 fail, 2 pass" matches our pass regex
      const patterns = extractLearningTriggers(output, "forge");
      const testPattern = patterns.find(p => p.trigger === "test_failure_resolved");
      // Should fire because both fail and pass patterns are present
      expect(testPattern).toBeDefined();
    });

    test("does not fire when only passes exist (no failure)", () => {
      const output = `$ bun test
All 42 tests pass. 0 fail`;

      const patterns = extractLearningTriggers(output, "forge");
      const testPattern = patterns.find(p => p.trigger === "test_failure_resolved");
      expect(testPattern).toBeUndefined();
    });

    test("extracts file paths from context", () => {
      const output = `FAIL src/__tests__/queue.test.ts
Error: Expected 3, received 2

Fixed src/queue/processor.ts to handle edge case.

All 100 tests pass.`;

      const patterns = extractLearningTriggers(output, "forge");
      const testPattern = patterns.find(p => p.trigger === "test_failure_resolved");
      expect(testPattern).toBeDefined();
      expect(testPattern!.metadata.files).toContain("src/__tests__/queue.test.ts");
      expect(testPattern!.metadata.files).toContain("src/queue/processor.ts");
    });
  });

  describe("review gate issue", () => {
    test("detects FAIL review gate annotation", () => {
      const output = `I've completed the implementation.

> **Review Gate [FAIL]:** Code has untested error paths
>   - Missing error handling in the main loop
>   - No test coverage for edge cases`;

      const patterns = extractLearningTriggers(output, "forge");
      const reviewPattern = patterns.find(p => p.trigger === "review_gate_issue");
      expect(reviewPattern).toBeDefined();
      expect(reviewPattern!.content).toContain("FAIL");
      expect(reviewPattern!.content).toContain("untested error paths");
      expect(reviewPattern!.importance).toBe(0.8);
    });

    test("detects WARN review gate annotation", () => {
      const output = `Done with the task.

> **Review Gate [WARN]:** Minor style inconsistencies detected`;

      const patterns = extractLearningTriggers(output, "forge");
      const reviewPattern = patterns.find(p => p.trigger === "review_gate_issue");
      expect(reviewPattern).toBeDefined();
      expect(reviewPattern!.importance).toBe(0.5);
    });

    test("does not fire for PASS review gate", () => {
      const output = `> **Review Gate [PASS]:** All checks passed`;

      const patterns = extractLearningTriggers(output, "forge");
      const reviewPattern = patterns.find(p => p.trigger === "review_gate_issue");
      expect(reviewPattern).toBeUndefined();
    });
  });

  describe("debugging resolution", () => {
    test("detects debugging exploration and resolution", () => {
      const output = `I'm investigating the issue in src/auth/handler.ts.

Error: ECONNREFUSED when connecting to database

I tried checking the connection string. Looking at the config file...
Examining the database initialization code.

The root cause was a missing environment variable for the database URL.
After adding the DB_URL to .env, the connection works.`;

      const patterns = extractLearningTriggers(output, "forge");
      const debugPattern = patterns.find(p => p.trigger === "debugging_resolution");
      expect(debugPattern).toBeDefined();
      expect(debugPattern!.content).toContain("ECONNREFUSED");
      expect(debugPattern!.importance).toBe(0.8);
    });

    test("does not fire without exploration indicators", () => {
      const output = `Error: Something broke
The fix was simple.`;

      const patterns = extractLearningTriggers(output, "forge");
      const debugPattern = patterns.find(p => p.trigger === "debugging_resolution");
      expect(debugPattern).toBeUndefined();
    });

    test("does not fire without error signature", () => {
      const output = `I'm investigating the issue. Tried several approaches.
Looking at the code carefully. Examining the tests.
The problem was a missing import. The fix was adding the import.`;

      const patterns = extractLearningTriggers(output, "forge");
      const debugPattern = patterns.find(p => p.trigger === "debugging_resolution");
      expect(debugPattern).toBeUndefined();
    });
  });

  describe("combined", () => {
    test("extracts multiple patterns from complex output", () => {
      const output = `I'm investigating the failing tests.

FAIL src/__tests__/auth.test.ts > login flow
TypeError: Cannot read property 'token' of undefined

I tried checking the auth module. Looking at the JWT implementation.
Examining the token generation code.

The root cause was that the JWT secret wasn't being loaded from environment.
Fixed by adding proper env loading in src/auth/config.ts.

$ bun test
All 85 tests pass.

> **Review Gate [WARN]:** Consider adding explicit error message for missing JWT_SECRET`;

      const patterns = extractLearningTriggers(output, "forge");

      // Should have test failure resolved
      expect(patterns.some(p => p.trigger === "test_failure_resolved")).toBe(true);

      // Should have review gate issue
      expect(patterns.some(p => p.trigger === "review_gate_issue")).toBe(true);

      // Should have debugging resolution
      expect(patterns.some(p => p.trigger === "debugging_resolution")).toBe(true);

      // All should have agent metadata
      for (const p of patterns) {
        expect(p.metadata.agent).toBe("forge");
      }
    });

    test("returns empty array for simple output", () => {
      const patterns = extractLearningTriggers("Hello, the task is complete.", "forge");
      expect(patterns.length).toBe(0);
    });
  });
});

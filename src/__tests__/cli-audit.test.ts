import { describe, expect, test } from "bun:test";
import { formatModelLedger, formatRuntimeAudit, parseSinceMs } from "../nyx/commands/audit.js";

describe("nyx audit command helpers", () => {
  test("parses day-based since windows", () => {
    expect(parseSinceMs("7d", 1_000_000_000)).toBe(1_000_000_000 - 7 * 86_400_000);
  });

  test("formats compact runtime audit output", () => {
    const output = formatRuntimeAudit({
      ok: true,
      status: "pass",
      checks: [
        { id: "model-default", label: "Nyx model", severity: "pass", detail: "gpt-5.5" },
      ],
    });

    expect(output).toContain("runtime audit: pass");
    expect(output).toContain("Nyx model");
  });

  test("formats warning runtime audit output as warn", () => {
    const output = formatRuntimeAudit({
      ok: true,
      status: "warn",
      checks: [
        { id: "queue-health", label: "Queue health", severity: "warn", detail: "pending=0 processing=1 dead=6 stale=0" },
      ],
    });

    expect(output).toContain("runtime audit: warn");
    expect(output).toContain("Queue health");
  });

  test("formats compact model ledger output", () => {
    const output = formatModelLedger([
      {
        model: "gpt-5.5",
        taskType: "coding",
        runs: 2,
        completed: 1,
        failed: 1,
        emptyRuns: 1,
        tokensIn: 1000,
        tokensOut: 500,
        cost: 0.02,
        avgDurationMs: 7500,
      },
    ]);

    expect(output).toContain("gpt-5.5");
    expect(output).toContain("coding");
    expect(output).toContain("$0.02");
  });
});

/**
 * Tests for HEARTBEAT_OK response suppression and adaptive scheduling wiring.
 */
import { describe, test, expect } from "bun:test";
import { isEmptyResponse } from "../scheduler/index.js";

describe("isEmptyResponse", () => {
  // Positive cases — should be suppressed
  test("null/undefined/empty responses are empty", () => {
    expect(isEmptyResponse(null)).toBe(true);
    expect(isEmptyResponse(undefined)).toBe(true);
    expect(isEmptyResponse("")).toBe(true);
    expect(isEmptyResponse("   ")).toBe(true);
  });

  test("'ok' variants are empty", () => {
    expect(isEmptyResponse("ok")).toBe(true);
    expect(isEmptyResponse("Ok.")).toBe(true);
    expect(isEmptyResponse("OK")).toBe(true);
    expect(isEmptyResponse("  ok  ")).toBe(true);
    expect(isEmptyResponse("ok.")).toBe(true);
  });

  test("'HEARTBEAT_OK' is empty", () => {
    expect(isEmptyResponse("HEARTBEAT_OK")).toBe(true);
    expect(isEmptyResponse("heartbeat_ok")).toBe(true);
    expect(isEmptyResponse("heartbeat ok")).toBe(true);
  });

  test("'no drift detected' variants are empty", () => {
    expect(isEmptyResponse("No drift detected.")).toBe(true);
    expect(isEmptyResponse("No drift detected")).toBe(true);
    expect(isEmptyResponse("No issues found.")).toBe(true);
    expect(isEmptyResponse("No issues found")).toBe(true);
    expect(isEmptyResponse("No findings to report")).toBe(true);
    expect(isEmptyResponse("No updates needed")).toBe(true);
    expect(isEmptyResponse("No changes found")).toBe(true);
    expect(isEmptyResponse("No problems detected")).toBe(true);
  });

  test("'everything is fine' variants are empty", () => {
    expect(isEmptyResponse("Everything is fine.")).toBe(true);
    expect(isEmptyResponse("Everything is healthy")).toBe(true);
    expect(isEmptyResponse("Everything is ok")).toBe(true);
    expect(isEmptyResponse("Everything fine")).toBe(true);
    expect(isEmptyResponse("Everything good")).toBe(true);
  });

  test("vault documentation current is empty", () => {
    expect(isEmptyResponse("Vault documentation is current")).toBe(true);
  });

  test("nothing noteworthy/to report is empty", () => {
    expect(isEmptyResponse("Nothing noteworthy")).toBe(true);
    expect(isEmptyResponse("Nothing to report")).toBe(true);
    expect(isEmptyResponse("Nothing actionable")).toBe(true);
  });

  test("all clear/good variants are empty", () => {
    expect(isEmptyResponse("All clear")).toBe(true);
    expect(isEmptyResponse("All good")).toBe(true);
    expect(isEmptyResponse("All systems healthy")).toBe(true);
    expect(isEmptyResponse("All systems nominal")).toBe(true);
    expect(isEmptyResponse("All systems ok")).toBe(true);
  });

  // Negative cases — should NOT be suppressed
  test("substantive responses are not empty", () => {
    expect(isEmptyResponse("Found 3 failing tasks: heartbeat:health-check, dev:execute-approved, briefing:daily")).toBe(false);
    expect(isEmptyResponse("Cost spike detected: $45 in the last 24h, up from $12 average")).toBe(false);
    expect(isEmptyResponse("[@propose: title=\"Fix auth bug\" category=bugfix effort=small]")).toBe(false);
  });

  test("long responses are never empty even if they contain patterns", () => {
    const longOk = "Everything is fine. " + "x".repeat(100);
    expect(isEmptyResponse(longOk)).toBe(false);
  });

  test("responses with action tags are not empty", () => {
    // Even short responses — action tags means something happened
    expect(isEmptyResponse("ok but also [@alert: disk full]")).toBe(false);
  });

  test("short but substantive responses are not empty", () => {
    expect(isEmptyResponse("3 tasks failed")).toBe(false);
    expect(isEmptyResponse("Cost: $45 yesterday")).toBe(false);
    expect(isEmptyResponse("Disk at 92%")).toBe(false);
  });
});

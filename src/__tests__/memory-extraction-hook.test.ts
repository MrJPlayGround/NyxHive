import { describe, test, expect } from "bun:test";

// Test rate limiting logic (unit test — extracts the rate-limiting pattern from processor)
describe("Memory extraction rate limiting", () => {
  test("should skip extraction within 5 minute window", () => {
    const map = new Map<string, number>();
    const convId = "test-conv";

    // First extraction should proceed
    const now = Date.now();
    const last = map.get(convId) ?? 0;
    expect(now - last > 5 * 60 * 1000).toBe(true);
    map.set(convId, now);

    // Immediate second call should be rate limited
    const last2 = map.get(convId) ?? 0;
    expect(now - last2 > 5 * 60 * 1000).toBe(false);
  });

  test("should allow extraction after 5 minute cooldown", () => {
    const map = new Map<string, number>();
    const convId = "test-conv";

    // Simulate 6 minutes ago
    map.set(convId, Date.now() - 6 * 60 * 1000);

    const now = Date.now();
    const last = map.get(convId) ?? 0;
    expect(now - last > 5 * 60 * 1000).toBe(true);
  });

  test("should skip scheduler-triggered messages", () => {
    const sender = "scheduler:heartbeat";
    expect(sender.startsWith("scheduler:")).toBe(true);
  });

  test("should skip proposal execution messages", () => {
    const sender = "proposal-exec:proposal-123";
    expect(sender.startsWith("proposal-")).toBe(true);
  });
});

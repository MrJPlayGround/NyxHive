import { describe, expect, test } from "bun:test";
import { nowKernelEvent } from "../kernel/events.js";

describe("kernel event helpers", () => {
  test("adds timestamp to kernel events", () => {
    const event = nowKernelEvent({ type: "kernel:status", status: "running" });

    expect(event.type).toBe("kernel:status");
    expect(event.status).toBe("running");
    expect(typeof event.timestamp).toBe("number");
  });
});

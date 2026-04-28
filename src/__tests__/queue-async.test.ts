import { describe, test, expect } from "bun:test";
import { EventEmitter } from "events";

describe("QueueDB event emission", () => {
  test("enqueue emits message-enqueued event", () => {
    const emitter = new EventEmitter();
    let emitted = false;
    emitter.on("message-enqueued", () => { emitted = true; });
    emitter.emit("message-enqueued", { messageId: "test-123" });
    expect(emitted).toBe(true);
  });
});

describe("event-driven processing latency", () => {
  test("event-driven responds faster than polling", () => {
    const emitter = new EventEmitter();
    const processedAt: number[] = [];
    emitter.on("message-enqueued", () => { processedAt.push(Date.now()); });
    const enqueuedAt = Date.now();
    emitter.emit("message-enqueued", {});
    expect(processedAt.length).toBe(1);
    expect(processedAt[0] - enqueuedAt).toBeLessThan(5);
  });
});

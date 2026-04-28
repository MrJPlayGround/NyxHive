import { describe, expect, it } from "bun:test";
import { MessageStreamManager } from "../channels/message-streaming.js";

describe("MessageStreamManager", () => {
  it("starts once and throttles edits", async () => {
    let starts = 0;
    let updates = 0;
    const manager = new MessageStreamManager<number>({
      updateIntervalMs: 100,
      forceFlushChars: 999,
      maxPreviewChars: 4000,
      onStart: async () => {
        starts++;
        return 42;
      },
      onUpdate: async () => {
        updates++;
      },
      render: (text) => text,
    });

    manager.append("Hello ");
    manager.append("world");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(starts).toBe(1);
    expect(updates).toBeLessThanOrEqual(1);
    await manager.finalize();
  });

  it("truncates previews to the configured limit", () => {
    const manager = new MessageStreamManager<number>({
      updateIntervalMs: 100,
      forceFlushChars: 999,
      maxPreviewChars: 20,
      onStart: async () => 1,
      onUpdate: async () => {},
      render: (text) => text,
    });

    manager.append("A".repeat(50));
    expect(manager.getPreviewText()).toEqual({
      text: "A".repeat(20),
      truncated: true,
    });
  });

  it("forces an early flush when the pending delta is large", async () => {
    const updates: string[] = [];
    const manager = new MessageStreamManager<number>({
      updateIntervalMs: 10_000,
      forceFlushChars: 5,
      maxPreviewChars: 4000,
      onStart: async () => 7,
      onUpdate: async (_messageId, text) => {
        updates.push(text);
      },
      render: (text) => text,
    });

    manager.append("12345");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(updates).toEqual(["12345"]);
    await manager.finalize();
  });
});

import { describe, it, expect } from "bun:test";
import { SlackStreamManager } from "../channels/slack/streaming.js";

describe("SlackStreamManager", () => {
  it("throttles updates to configured interval", async () => {
    let updateCount = 0;
    const manager = new SlackStreamManager({
      updateIntervalMs: 100,
      maxChars: 4000,
      onUpdate: async () => { updateCount++; },
      onFinalize: async () => {},
    });

    manager.append("Hello ");
    manager.append("world ");
    manager.append("test ");
    await new Promise(r => setTimeout(r, 50));
    expect(updateCount).toBeLessThanOrEqual(1);
    await manager.finalize();
  });

  it("truncates to maxChars with ellipsis", () => {
    const manager = new SlackStreamManager({
      updateIntervalMs: 100,
      maxChars: 20,
      onUpdate: async () => {},
      onFinalize: async () => {},
    });

    manager.append("A".repeat(50));
    const preview = manager.getCurrentText();
    expect(preview.length).toBeLessThanOrEqual(23);
    expect(preview.endsWith("...")).toBe(true);
  });

  it("calls onFinalize with full text on finalize()", async () => {
    let finalText = "";
    const manager = new SlackStreamManager({
      updateIntervalMs: 50,
      maxChars: 4000,
      onUpdate: async () => {},
      onFinalize: async (text) => { finalText = text; },
    });

    manager.append("Hello ");
    manager.append("world");
    await manager.finalize();
    expect(finalText).toBe("Hello world");
  });

  it("does not call onUpdate after finalize", async () => {
    let updateCount = 0;
    const manager = new SlackStreamManager({
      updateIntervalMs: 10,
      maxChars: 4000,
      onUpdate: async () => { updateCount++; },
      onFinalize: async () => {},
    });

    manager.append("test");
    await manager.finalize();
    const countAfterFinalize = updateCount;
    manager.append("more");
    await new Promise(r => setTimeout(r, 50));
    expect(updateCount).toBe(countAfterFinalize);
  });

  it("returns empty buffer when nothing appended", async () => {
    let finalText = "not-empty";
    const manager = new SlackStreamManager({
      updateIntervalMs: 50,
      maxChars: 4000,
      onUpdate: async () => {},
      onFinalize: async (text) => { finalText = text; },
    });
    await manager.finalize();
    expect(finalText).toBe("");
  });
});

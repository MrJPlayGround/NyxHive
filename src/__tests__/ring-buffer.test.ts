import { describe, it, expect } from "bun:test";
import { ActivityRingBuffer, type ActivityEvent } from "../activity/ring-buffer.js";

function makeEvent(id: string, agent = "nyx"): ActivityEvent {
  return { id, type: "completion", agent, action: "completed", subject: "test", timestamp: Date.now() };
}

describe("ActivityRingBuffer", () => {
  it("stores and retrieves events in order", () => {
    const buf = new ActivityRingBuffer(5);
    buf.push(makeEvent("1"));
    buf.push(makeEvent("2"));
    buf.push(makeEvent("3"));
    const items = buf.getAll();
    expect(items).toHaveLength(3);
    expect(items[0].id).toBe("1");
    expect(items[2].id).toBe("3");
  });

  it("evicts oldest when full", () => {
    const buf = new ActivityRingBuffer(3);
    buf.push(makeEvent("1"));
    buf.push(makeEvent("2"));
    buf.push(makeEvent("3"));
    buf.push(makeEvent("4"));
    const items = buf.getAll();
    expect(items).toHaveLength(3);
    expect(items[0].id).toBe("2");
    expect(items[2].id).toBe("4");
  });

  it("returns empty array when no events", () => {
    const buf = new ActivityRingBuffer(5);
    expect(buf.getAll()).toEqual([]);
  });

  it("handles single-capacity buffer", () => {
    const buf = new ActivityRingBuffer(1);
    buf.push(makeEvent("1"));
    buf.push(makeEvent("2"));
    const items = buf.getAll();
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("2");
  });

  it("handles wrap-around correctly", () => {
    const buf = new ActivityRingBuffer(3);
    for (let i = 1; i <= 10; i++) buf.push(makeEvent(String(i)));
    const items = buf.getAll();
    expect(items).toHaveLength(3);
    expect(items.map(e => e.id)).toEqual(["8", "9", "10"]);
  });
});

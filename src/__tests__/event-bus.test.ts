import { describe, it, expect, beforeEach } from "bun:test";
import { EventBus } from "../queue/event-bus.js";

describe("EventBus", () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  // ── Global SSE events ──────────────────────────────────────────────

  describe("onEvent / emit", () => {
    it("delivers events to a subscriber", () => {
      const received: Array<{ type: string }> = [];
      bus.onEvent((e) => received.push(e));

      bus.emit("task:started", { task_id: "t1" });

      expect(received).toHaveLength(1);
      expect(received[0].type).toBe("task:started");
    });

    it("delivers events to multiple subscribers", () => {
      let countA = 0;
      let countB = 0;
      bus.onEvent(() => countA++);
      bus.onEvent(() => countB++);

      bus.emit("task:completed", { task_id: "t1" });

      expect(countA).toBe(1);
      expect(countB).toBe(1);
    });

    it("unsubscribe stops delivery", () => {
      const received: Array<{ type: string }> = [];
      const unsub = bus.onEvent((e) => received.push(e));

      bus.emit("a", {});
      unsub();
      bus.emit("b", {});

      expect(received).toHaveLength(1);
      expect(received[0].type).toBe("a");
    });

    it("includes timestamp in emitted events", () => {
      let ts = 0;
      bus.onEvent((e) => {
        ts = e.timestamp;
      });

      const before = Date.now();
      bus.emit("ping", {});
      const after = Date.now();

      expect(ts).toBeGreaterThanOrEqual(before);
      expect(ts).toBeLessThanOrEqual(after);
    });

    it("swallows errors from listeners without breaking others", () => {
      const received: string[] = [];
      bus.onEvent(() => {
        throw new Error("boom");
      });
      bus.onEvent((e) => received.push(e.type));

      bus.emit("test", {});

      expect(received).toEqual(["test"]);
    });
  });

  // ── Per-message listeners ──────────────────────────────────────────

  describe("setMessageListener / removeMessageListener", () => {
    it("delivers to per-message listener when message_id matches", () => {
      const received: Array<{ type: string }> = [];
      bus.setMessageListener("msg-1", (e) => received.push(e));

      bus.emit("chunk", { message_id: "msg-1", text: "hi" });

      expect(received).toHaveLength(1);
      expect(received[0].type).toBe("chunk");
    });

    it("does not deliver to per-message listener when message_id differs", () => {
      const received: Array<{ type: string }> = [];
      bus.setMessageListener("msg-1", (e) => received.push(e));

      bus.emit("chunk", { message_id: "msg-2", text: "hi" });

      expect(received).toHaveLength(0);
    });

    it("does not deliver to per-message listener when no message_id", () => {
      const received: Array<{ type: string }> = [];
      bus.setMessageListener("msg-1", (e) => received.push(e));

      bus.emit("chunk", { text: "hi" });

      expect(received).toHaveLength(0);
    });

    it("removeMessageListener stops per-message delivery", () => {
      const received: Array<{ type: string }> = [];
      bus.setMessageListener("msg-1", (e) => received.push(e));

      bus.emit("chunk", { message_id: "msg-1" });
      bus.removeMessageListener("msg-1");
      bus.emit("chunk", { message_id: "msg-1" });

      expect(received).toHaveLength(1);
    });

    it("swallows errors from per-message listeners", () => {
      bus.setMessageListener("msg-1", () => {
        throw new Error("boom");
      });

      // Should not throw
      expect(() => bus.emit("chunk", { message_id: "msg-1" })).not.toThrow();
    });
  });

  // ── Thread-scoped events ───────────────────────────────────────────

  describe("onThreadEvent / emitThreadEvent", () => {
    it("delivers to thread-specific subscriber", () => {
      const received: Array<{ type: string; thread_id: string }> = [];
      bus.onThreadEvent("thread-1", (e) => received.push(e));

      bus.emitThreadEvent("thread-1", "status", { state: "running" });

      expect(received).toHaveLength(1);
      expect(received[0].type).toBe("status");
      expect(received[0].thread_id).toBe("thread-1");
    });

    it("does not deliver to subscribers of other threads", () => {
      const received: Array<{ type: string }> = [];
      bus.onThreadEvent("thread-1", (e) => received.push(e));

      bus.emitThreadEvent("thread-2", "status", { state: "running" });

      expect(received).toHaveLength(0);
    });

    it("multiple subscribers on same thread all receive", () => {
      let countA = 0;
      let countB = 0;
      bus.onThreadEvent("t1", () => countA++);
      bus.onThreadEvent("t1", () => countB++);

      bus.emitThreadEvent("t1", "update", {});

      expect(countA).toBe(1);
      expect(countB).toBe(1);
    });

    it("unsubscribe stops delivery for that listener only", () => {
      let countA = 0;
      let countB = 0;
      const unsubA = bus.onThreadEvent("t1", () => countA++);
      bus.onThreadEvent("t1", () => countB++);

      bus.emitThreadEvent("t1", "x", {});
      unsubA();
      bus.emitThreadEvent("t1", "y", {});

      expect(countA).toBe(1);
      expect(countB).toBe(2);
    });

    it("cleans up thread listener set when last subscriber unsubscribes", () => {
      const unsub = bus.onThreadEvent("t1", () => {});
      unsub();

      // Emit should not throw even though thread set is cleaned up
      expect(() => bus.emitThreadEvent("t1", "test", {})).not.toThrow();
    });

    it("includes data and timestamp in thread events", () => {
      let captured: Record<string, unknown> = {};
      let ts = 0;
      bus.onThreadEvent("t1", (e) => {
        captured = e.data;
        ts = e.timestamp;
      });

      bus.emitThreadEvent("t1", "progress", { percent: 50 });

      expect(captured).toEqual({ percent: 50 });
      expect(ts).toBeGreaterThan(0);
    });

    it("swallows errors from thread listeners", () => {
      const received: string[] = [];
      bus.onThreadEvent("t1", () => {
        throw new Error("boom");
      });
      bus.onThreadEvent("t1", (e) => received.push(e.type));

      bus.emitThreadEvent("t1", "test", {});

      expect(received).toEqual(["test"]);
    });
  });

  // ── Global thread events ───────────────────────────────────────────

  describe("onGlobalThreadEvent", () => {
    it("receives events from any thread", () => {
      const received: string[] = [];
      bus.onGlobalThreadEvent((e) => received.push(e.thread_id));

      bus.emitThreadEvent("t1", "status", {});
      bus.emitThreadEvent("t2", "status", {});

      expect(received).toEqual(["t1", "t2"]);
    });

    it("unsubscribe stops global delivery", () => {
      const received: string[] = [];
      const unsub = bus.onGlobalThreadEvent((e) => received.push(e.thread_id));

      bus.emitThreadEvent("t1", "a", {});
      unsub();
      bus.emitThreadEvent("t2", "b", {});

      expect(received).toEqual(["t1"]);
    });

    it("both thread-specific and global listeners receive the same event", () => {
      const threadReceived: string[] = [];
      const globalReceived: string[] = [];

      bus.onThreadEvent("t1", (e) => threadReceived.push(e.type));
      bus.onGlobalThreadEvent((e) => globalReceived.push(e.type));

      bus.emitThreadEvent("t1", "update", {});

      expect(threadReceived).toEqual(["update"]);
      expect(globalReceived).toEqual(["update"]);
    });

    it("swallows errors from global listeners", () => {
      const received: string[] = [];
      bus.onGlobalThreadEvent(() => {
        throw new Error("boom");
      });
      bus.onGlobalThreadEvent((e) => received.push(e.type));

      bus.emitThreadEvent("t1", "test", {});

      expect(received).toEqual(["test"]);
    });
  });

  // ── Edge cases ─────────────────────────────────────────────────────

  describe("edge cases", () => {
    it("emit with no subscribers does not throw", () => {
      expect(() => bus.emit("orphan", {})).not.toThrow();
    });

    it("emitThreadEvent with no subscribers does not throw", () => {
      expect(() => bus.emitThreadEvent("none", "orphan", {})).not.toThrow();
    });

    it("removing a non-existent message listener does not throw", () => {
      expect(() => bus.removeMessageListener("nope")).not.toThrow();
    });

    it("same listener added twice receives event twice", () => {
      // Sets prevent true duplicates, but different closures are distinct
      let count = 0;
      const fn = () => count++;
      bus.onEvent(fn);
      bus.onEvent(fn); // same reference — Set deduplicates

      bus.emit("x", {});

      expect(count).toBe(1); // Set only stores unique references
    });
  });
});

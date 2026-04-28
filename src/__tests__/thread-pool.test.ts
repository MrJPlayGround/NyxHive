import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { QueueDB } from "../queue/db.js";
import { QueueProcessor } from "../queue/processor.js";
import type { ThreadEvent } from "../types.js";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "thread-pool-test-"));
}

describe("Thread Pool — QueueDB", () => {
  let db: QueueDB;
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
    db = new QueueDB(dir, "test");
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe("enqueueMessage with thread_id", () => {
    test("enqueues a message with thread_id", () => {
      const msgId = db.enqueueMessage({
        channel: "api",
        sender: "user1",
        message: "do something",
        agent: "forge",
        thread_id: "thread-abc",
      });
      const msg = db.getMessageByMessageId(msgId);
      expect(msg).not.toBeNull();
      expect(msg!.thread_id).toBe("thread-abc");
      expect(msg!.status).toBe("pending");
    });

    test("enqueues a message without thread_id (null)", () => {
      const msgId = db.enqueueMessage({
        channel: "api",
        sender: "user1",
        message: "normal message",
        agent: "forge",
      });
      const msg = db.getMessageByMessageId(msgId);
      expect(msg).not.toBeNull();
      expect(msg!.thread_id).toBeNull();
    });
  });

  describe("claimMessage excludes thread messages", () => {
    test("claimMessage skips messages with thread_id", () => {
      db.enqueueMessage({
        channel: "api",
        sender: "user1",
        message: "thread msg",
        agent: "forge",
        thread_id: "thread-1",
      });
      const claimed = db.claimMessage("forge");
      expect(claimed).toBeNull();
    });

    test("claimMessage still claims non-thread messages", () => {
      db.enqueueMessage({
        channel: "api",
        sender: "user1",
        message: "normal msg",
        agent: "forge",
      });
      const claimed = db.claimMessage("forge");
      expect(claimed).not.toBeNull();
      expect(claimed!.message).toBe("normal msg");
      expect(claimed!.thread_id).toBeNull();
    });

    test("claimMessage skips thread messages and claims non-thread", () => {
      db.enqueueMessage({
        channel: "api",
        sender: "user1",
        message: "thread msg",
        agent: "forge",
        thread_id: "thread-1",
      });
      db.enqueueMessage({
        channel: "api",
        sender: "user1",
        message: "normal msg",
        agent: "forge",
      });
      const claimed = db.claimMessage("forge");
      expect(claimed).not.toBeNull();
      expect(claimed!.message).toBe("normal msg");
      expect(claimed!.thread_id).toBeNull();
    });
  });

  describe("claimThreadMessage", () => {
    test("claims a pending thread message", () => {
      db.enqueueMessage({
        channel: "api",
        sender: "user1",
        message: "thread task",
        agent: "forge",
        thread_id: "thread-1",
      });
      const claimed = db.claimThreadMessage([]);
      expect(claimed).not.toBeNull();
      expect(claimed!.thread_id).toBe("thread-1");
      expect(claimed!.status).toBe("processing");
      expect(claimed!.claimed_by).toBe("thread_pool");
    });

    test("returns null when no thread messages pending", () => {
      db.enqueueMessage({
        channel: "api",
        sender: "user1",
        message: "normal msg",
        agent: "forge",
      });
      const claimed = db.claimThreadMessage([]);
      expect(claimed).toBeNull();
    });

    test("skips threads already in-flight", () => {
      db.enqueueMessage({
        channel: "api",
        sender: "user1",
        message: "task A",
        agent: "forge",
        thread_id: "thread-A",
      });
      db.enqueueMessage({
        channel: "api",
        sender: "user1",
        message: "task B",
        agent: "forge",
        thread_id: "thread-B",
      });

      // thread-A is in-flight
      const claimed = db.claimThreadMessage(["thread-A"]);
      expect(claimed).not.toBeNull();
      expect(claimed!.thread_id).toBe("thread-B");
    });

    test("returns null when all thread messages are in-flight", () => {
      db.enqueueMessage({
        channel: "api",
        sender: "user1",
        message: "task A",
        agent: "forge",
        thread_id: "thread-A",
      });
      const claimed = db.claimThreadMessage(["thread-A"]);
      expect(claimed).toBeNull();
    });

    test("claims oldest thread message first (FIFO)", () => {
      db.enqueueMessage({
        channel: "api",
        sender: "user1",
        message: "second",
        agent: "forge",
        thread_id: "thread-2",
      });
      // Ensure ordering
      db.enqueueMessage({
        channel: "api",
        sender: "user1",
        message: "first",
        agent: "forge",
        thread_id: "thread-1",
      });

      // thread-2 was enqueued first, so it should be claimed first
      const claimed = db.claimThreadMessage([]);
      expect(claimed).not.toBeNull();
      expect(claimed!.thread_id).toBe("thread-2");
    });

    test("does not double-claim already processing thread messages", () => {
      db.enqueueMessage({
        channel: "api",
        sender: "user1",
        message: "task",
        agent: "forge",
        thread_id: "thread-1",
      });

      const first = db.claimThreadMessage([]);
      expect(first).not.toBeNull();

      // Try to claim again — message is now 'processing', not 'pending'
      const second = db.claimThreadMessage([]);
      expect(second).toBeNull();
    });
  });

  describe("getPendingCount excludes thread messages", () => {
    test("excludes thread messages from pending count", () => {
      db.enqueueMessage({
        channel: "api",
        sender: "user1",
        message: "thread msg",
        agent: "forge",
        thread_id: "thread-1",
      });
      expect(db.getPendingCount("forge")).toBe(0);
      expect(db.getPendingCount()).toBe(0);
    });

    test("counts non-thread messages normally", () => {
      db.enqueueMessage({
        channel: "api",
        sender: "user1",
        message: "normal",
        agent: "forge",
      });
      db.enqueueMessage({
        channel: "api",
        sender: "user1",
        message: "thread",
        agent: "forge",
        thread_id: "thread-1",
      });
      expect(db.getPendingCount("forge")).toBe(1);
    });
  });

  describe("getPendingThreadCount", () => {
    test("counts pending thread messages", () => {
      db.enqueueMessage({ channel: "api", sender: "u1", message: "t1", thread_id: "thread-1" });
      db.enqueueMessage({ channel: "api", sender: "u1", message: "t2", thread_id: "thread-2" });
      db.enqueueMessage({ channel: "api", sender: "u1", message: "normal" });
      expect(db.getPendingThreadCount()).toBe(2);
    });

    test("excludes specified thread IDs", () => {
      db.enqueueMessage({ channel: "api", sender: "u1", message: "t1", thread_id: "thread-1" });
      db.enqueueMessage({ channel: "api", sender: "u1", message: "t2", thread_id: "thread-2" });
      db.enqueueMessage({ channel: "api", sender: "u1", message: "t3", thread_id: "thread-3" });
      expect(db.getPendingThreadCount(["thread-1", "thread-3"])).toBe(1);
    });

    test("returns 0 when no thread messages", () => {
      db.enqueueMessage({ channel: "api", sender: "u1", message: "normal" });
      expect(db.getPendingThreadCount()).toBe(0);
    });
  });

  describe("countActiveThreads", () => {
    test("counts distinct processing threads", () => {
      db.enqueueMessage({ channel: "api", sender: "u1", message: "t1", thread_id: "thread-1" });
      db.enqueueMessage({ channel: "api", sender: "u1", message: "t2", thread_id: "thread-2" });
      db.enqueueMessage({ channel: "api", sender: "u1", message: "t3", thread_id: "thread-3" });

      // Claim two thread messages
      db.claimThreadMessage([]);
      db.claimThreadMessage(["thread-1"]);

      expect(db.countActiveThreads()).toBe(2);
    });

    test("returns 0 when no threads processing", () => {
      db.enqueueMessage({ channel: "api", sender: "u1", message: "t1", thread_id: "thread-1" });
      expect(db.countActiveThreads()).toBe(0);
    });

    test("does not count non-thread processing messages", () => {
      db.enqueueMessage({ channel: "api", sender: "u1", message: "normal", agent: "forge" });
      db.claimMessage("forge");
      expect(db.countActiveThreads()).toBe(0);
    });
  });

  describe("concurrent thread claiming safety", () => {
    test("multiple claims for same thread only returns one", () => {
      db.enqueueMessage({ channel: "api", sender: "u1", message: "task", thread_id: "thread-1" });

      const claimed1 = db.claimThreadMessage([]);
      const claimed2 = db.claimThreadMessage([]);

      expect(claimed1).not.toBeNull();
      expect(claimed2).toBeNull();
    });

    test("claiming respects FIFO across different threads", () => {
      // Enqueue in specific order
      db.enqueueMessage({ channel: "api", sender: "u1", message: "first", thread_id: "thread-A" });
      db.enqueueMessage({ channel: "api", sender: "u1", message: "second", thread_id: "thread-B" });
      db.enqueueMessage({ channel: "api", sender: "u1", message: "third", thread_id: "thread-C" });

      const first = db.claimThreadMessage([]);
      const second = db.claimThreadMessage(["thread-A"]);
      const third = db.claimThreadMessage(["thread-A", "thread-B"]);

      expect(first!.thread_id).toBe("thread-A");
      expect(second!.thread_id).toBe("thread-B");
      expect(third!.thread_id).toBe("thread-C");
    });
  });
});

describe("Thread Event System — QueueProcessor", () => {
  let db: QueueDB;
  let processor: QueueProcessor;
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
    db = new QueueDB(dir, "test");
    processor = new QueueProcessor(db, {
      agents: { forge: { name: "forge", provider: "anthropic", model: "claude-sonnet-4-20250514", working_directory: dir } },
      teams: {},
      baseDir: dir,
    });
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe("onThreadEvent (per-thread subscription)", () => {
    test("receives events for subscribed thread", () => {
      const events: ThreadEvent[] = [];
      processor.onThreadEvent("thread-1", (e) => events.push(e));

      processor.emitThreadEvent("thread-1", "thread:status", { status: "processing" });

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("thread:status");
      expect(events[0].thread_id).toBe("thread-1");
      expect(events[0].data.status).toBe("processing");
      expect(events[0].timestamp).toBeGreaterThan(0);
    });

    test("does NOT receive events for other threads", () => {
      const events: ThreadEvent[] = [];
      processor.onThreadEvent("thread-1", (e) => events.push(e));

      processor.emitThreadEvent("thread-2", "thread:status", { status: "processing" });

      expect(events).toHaveLength(0);
    });

    test("unsubscribe stops receiving events", () => {
      const events: ThreadEvent[] = [];
      const unsub = processor.onThreadEvent("thread-1", (e) => events.push(e));

      processor.emitThreadEvent("thread-1", "thread:status", { status: "processing" });
      expect(events).toHaveLength(1);

      unsub();
      processor.emitThreadEvent("thread-1", "thread:complete", { response: "done" });
      expect(events).toHaveLength(1); // no new events
    });

    test("multiple subscribers for same thread all receive events", () => {
      const events1: ThreadEvent[] = [];
      const events2: ThreadEvent[] = [];
      processor.onThreadEvent("thread-1", (e) => events1.push(e));
      processor.onThreadEvent("thread-1", (e) => events2.push(e));

      processor.emitThreadEvent("thread-1", "thread:progress", { description: "working" });

      expect(events1).toHaveLength(1);
      expect(events2).toHaveLength(1);
    });

    test("cleans up listener set when last subscriber unsubscribes", () => {
      const unsub1 = processor.onThreadEvent("thread-1", () => {});
      const unsub2 = processor.onThreadEvent("thread-1", () => {});

      unsub1();
      // thread-1 set still exists (unsub2 still active)
      processor.emitThreadEvent("thread-1", "thread:status", { status: "ok" }); // should not throw

      unsub2();
      // thread-1 set should be cleaned up — emit should still not throw
      processor.emitThreadEvent("thread-1", "thread:status", { status: "ok" });
    });
  });

  describe("onGlobalThreadEvent (all threads)", () => {
    test("receives events from all threads", () => {
      const events: ThreadEvent[] = [];
      processor.onGlobalThreadEvent((e) => events.push(e));

      processor.emitThreadEvent("thread-1", "thread:status", { status: "processing" });
      processor.emitThreadEvent("thread-2", "thread:complete", { response: "done" });
      processor.emitThreadEvent("thread-3", "thread:error", { error: "fail" });

      expect(events).toHaveLength(3);
      expect(events[0].thread_id).toBe("thread-1");
      expect(events[1].thread_id).toBe("thread-2");
      expect(events[2].thread_id).toBe("thread-3");
    });

    test("unsubscribe stops receiving global events", () => {
      const events: ThreadEvent[] = [];
      const unsub = processor.onGlobalThreadEvent((e) => events.push(e));

      processor.emitThreadEvent("thread-1", "thread:status", { status: "a" });
      unsub();
      processor.emitThreadEvent("thread-2", "thread:status", { status: "b" });

      expect(events).toHaveLength(1);
    });
  });

  describe("event isolation", () => {
    test("per-thread and global listeners both receive events", () => {
      const perThread: ThreadEvent[] = [];
      const global: ThreadEvent[] = [];

      processor.onThreadEvent("thread-1", (e) => perThread.push(e));
      processor.onGlobalThreadEvent((e) => global.push(e));

      processor.emitThreadEvent("thread-1", "thread:status", { status: "processing" });

      expect(perThread).toHaveLength(1);
      expect(global).toHaveLength(1);
    });

    test("thread A events do not leak to thread B subscriber", () => {
      const eventsA: ThreadEvent[] = [];
      const eventsB: ThreadEvent[] = [];

      processor.onThreadEvent("thread-A", (e) => eventsA.push(e));
      processor.onThreadEvent("thread-B", (e) => eventsB.push(e));

      processor.emitThreadEvent("thread-A", "thread:progress", { description: "reading" });
      processor.emitThreadEvent("thread-B", "thread:progress", { description: "writing" });

      expect(eventsA).toHaveLength(1);
      expect(eventsA[0].data.description).toBe("reading");
      expect(eventsB).toHaveLength(1);
      expect(eventsB[0].data.description).toBe("writing");
    });

    test("error in one listener does not prevent others from receiving", () => {
      const events: ThreadEvent[] = [];

      processor.onThreadEvent("thread-1", () => { throw new Error("boom"); });
      processor.onThreadEvent("thread-1", (e) => events.push(e));

      // Should not throw, and the second listener should still receive
      processor.emitThreadEvent("thread-1", "thread:status", { status: "ok" });
      expect(events).toHaveLength(1);
    });

    test("error in global listener does not prevent per-thread delivery", () => {
      const perThread: ThreadEvent[] = [];

      processor.onGlobalThreadEvent(() => { throw new Error("global boom"); });
      processor.onThreadEvent("thread-1", (e) => perThread.push(e));

      processor.emitThreadEvent("thread-1", "thread:status", { status: "ok" });
      expect(perThread).toHaveLength(1);
    });
  });

  describe("emitThreadEvent data", () => {
    test("includes all event fields", () => {
      const events: ThreadEvent[] = [];
      processor.onThreadEvent("t1", (e) => events.push(e));

      processor.emitThreadEvent("t1", "thread:complete", {
        response: "all done",
        cost_cents: 42,
        total_tokens: 1500,
        duration_ms: 3000,
      });

      const event = events[0];
      expect(event.type).toBe("thread:complete");
      expect(event.thread_id).toBe("t1");
      expect(event.data.response).toBe("all done");
      expect(event.data.cost_cents).toBe(42);
      expect(event.data.total_tokens).toBe(1500);
      expect(event.data.duration_ms).toBe(3000);
      expect(typeof event.timestamp).toBe("number");
    });
  });

  describe("getActiveThreadIds / getThreadPoolStats", () => {
    test("returns empty when no threads active", () => {
      expect(processor.getActiveThreadIds()).toEqual([]);
      expect(processor.getThreadPoolStats()).toEqual({ active: 0, max: 5 });
    });
  });
});

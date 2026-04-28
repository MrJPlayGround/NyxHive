import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { SteersDB } from "../queue/steers.js";
import { Database } from "bun:sqlite";

describe("SteersDB", () => {
  let db: Database;
  let steers: SteersDB;

  beforeEach(() => {
    db = new Database(":memory:");
    steers = new SteersDB(db);
  });

  afterEach(() => {
    db.close();
  });

  it("creates steers table on init", () => {
    const tables = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name='steers'").all();
    expect(tables).toHaveLength(1);
  });

  it("enqueues a steer", () => {
    const id = steers.enqueue({
      target_message_id: "msg_1",
      target_agent: "nyx",
      conversation_id: "conv_1",
      source: "human",
      channel: "discord",
      message: "check the migration",
      priority: "normal",
      ttl_seconds: 300,
      on_expire: "discard",
    });
    expect(id).toMatch(/^steer_/);
  });

  it("gets pending steers for a message", () => {
    steers.enqueue({
      target_message_id: "msg_1",
      target_agent: "nyx",
      conversation_id: "conv_1",
      source: "human",
      message: "steer 1",
      priority: "normal",
    });
    steers.enqueue({
      target_message_id: "msg_1",
      target_agent: "nyx",
      conversation_id: "conv_1",
      source: "scout",
      message: "steer 2",
      priority: "normal",
    });

    const pending = steers.getPending("msg_1");
    expect(pending).toHaveLength(2);
    expect(pending[0].message).toBe("steer 1");
    expect(pending[1].message).toBe("steer 2");
  });

  it("marks steer as delivered", () => {
    const id = steers.enqueue({
      target_message_id: "msg_1",
      target_agent: "nyx",
      conversation_id: "conv_1",
      source: "human",
      message: "check it",
      priority: "normal",
    });
    steers.markDelivered(id);

    const pending = steers.getPending("msg_1");
    expect(pending).toHaveLength(0);
  });

  it("expires steers for completed message", () => {
    steers.enqueue({
      target_message_id: "msg_1",
      target_agent: "nyx",
      conversation_id: "conv_1",
      source: "human",
      message: "too late",
      priority: "normal",
    });
    const expired = steers.expireForMessage("msg_1");
    expect(expired).toBe(1);

    const pending = steers.getPending("msg_1");
    expect(pending).toHaveLength(0);
  });

  it("expires steers past TTL", () => {
    const id = steers.enqueue({
      target_message_id: "msg_1",
      target_agent: "nyx",
      conversation_id: "conv_1",
      source: "human",
      message: "old steer",
      priority: "normal",
      ttl_seconds: 1,
    });

    // Manually backdate
    db.run("UPDATE steers SET created_at = ? WHERE steer_id = ?", [Date.now() - 2000, id]);

    const expired = steers.expirePastTtl();
    expect(expired).toBeGreaterThanOrEqual(1);
  });

  it("counts pending steers for a message", () => {
    steers.enqueue({
      target_message_id: "msg_1",
      target_agent: "nyx",
      conversation_id: "conv_1",
      source: "human",
      message: "s1",
      priority: "normal",
    });
    expect(steers.pendingCount("msg_1")).toBe(1);
    expect(steers.pendingCount("msg_other")).toBe(0);
  });
});

describe("SteersDB batching", () => {
  let db: Database;
  let steers: SteersDB;

  beforeEach(() => {
    db = new Database(":memory:");
    steers = new SteersDB(db);
  });

  afterEach(() => {
    db.close();
  });

  it("formats batch with timestamps", () => {
    steers.enqueue({
      target_message_id: "msg_1",
      target_agent: "nyx",
      conversation_id: "conv_1",
      source: "human",
      message: "check migrations",
      priority: "normal",
    });
    steers.enqueue({
      target_message_id: "msg_1",
      target_agent: "nyx",
      conversation_id: "conv_1",
      source: "scout",
      message: "found issue in schema",
      priority: "normal",
    });

    const batch = steers.formatBatch("msg_1");
    expect(batch).toContain("[STEERS RECEIVED]");
    expect(batch).toContain("from human");
    expect(batch).toContain("check migrations");
    expect(batch).toContain("from scout");
    expect(batch).toContain("found issue in schema");
    expect(batch).toContain("[END STEERS]");
  });
});

describe("Steer delivery lifecycle", () => {
  let db: Database;
  let steers: SteersDB;

  beforeEach(() => {
    db = new Database(":memory:");
    steers = new SteersDB(db);
  });

  afterEach(() => {
    db.close();
  });

  it("full lifecycle: enqueue -> getPending -> formatBatch -> markDelivered", () => {
    const id1 = steers.enqueue({
      target_message_id: "msg_1",
      target_agent: "nyx",
      conversation_id: "conv_1",
      source: "human",
      message: "check the migration",
      priority: "normal",
    });
    const id2 = steers.enqueue({
      target_message_id: "msg_1",
      target_agent: "nyx",
      conversation_id: "conv_1",
      source: "scout",
      message: "found related issue",
      priority: "normal",
    });

    expect(steers.pendingCount("msg_1")).toBe(2);

    const batch = steers.formatBatch("msg_1");
    expect(batch).toContain("[STEERS RECEIVED]");
    expect(batch).toContain("check the migration");
    expect(batch).toContain("found related issue");

    steers.markDelivered(id1);
    steers.markDelivered(id2);
    expect(steers.pendingCount("msg_1")).toBe(0);
  });

  it("interrupt steers appear in getPending alongside normal", () => {
    steers.enqueue({
      target_message_id: "msg_1",
      target_agent: "nyx",
      conversation_id: "conv_1",
      source: "human",
      message: "normal steer",
      priority: "normal",
    });
    steers.enqueue({
      target_message_id: "msg_1",
      target_agent: "nyx",
      conversation_id: "conv_1",
      source: "human",
      message: "urgent steer",
      priority: "interrupt",
    });

    const pending = steers.getPending("msg_1");
    expect(pending).toHaveLength(2);
    expect(pending.some((s) => s.priority === "interrupt")).toBe(true);
  });
});

describe("Interrupt priority detection", () => {
  let db: Database;
  let steers: SteersDB;

  beforeEach(() => {
    db = new Database(":memory:");
    steers = new SteersDB(db);
  });

  afterEach(() => {
    db.close();
  });

  it("detects interrupt steers in pending list", () => {
    steers.enqueue({
      target_message_id: "msg_1",
      target_agent: "nyx",
      conversation_id: "conv_1",
      source: "human",
      message: "stop and check this",
      priority: "interrupt",
    });

    const pending = steers.getPending("msg_1");
    const hasInterrupt = pending.some((s) => s.priority === "interrupt");
    expect(hasInterrupt).toBe(true);
  });

  it("no interrupt when only normal steers", () => {
    steers.enqueue({
      target_message_id: "msg_1",
      target_agent: "nyx",
      conversation_id: "conv_1",
      source: "human",
      message: "btw check this",
      priority: "normal",
    });

    const pending = steers.getPending("msg_1");
    const hasInterrupt = pending.some((s) => s.priority === "interrupt");
    expect(hasInterrupt).toBe(false);
  });
});

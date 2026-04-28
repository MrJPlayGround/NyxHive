import { describe, it, expect, beforeEach } from "bun:test";
import { ConnectionManager } from "../server/ws/connection";
import { MethodRouter } from "../server/ws/router";
import { DeviceStore } from "../server/ws/auth";
import { Database } from "bun:sqlite";

describe("ConnectionManager", () => {
  it("tracks connections", () => {
    const mgr = new ConnectionManager();
    const messages: string[] = [];
    const mockWs = { send: (msg: string) => messages.push(msg), readyState: 1 } as any;

    mgr.add("device-1", mockWs);
    expect(mgr.count()).toBe(1);

    mgr.remove("device-1");
    expect(mgr.count()).toBe(0);
  });

  it("broadcasts to all connections", () => {
    const mgr = new ConnectionManager();
    const messages: string[] = [];
    const mockWs = { send: (msg: string) => messages.push(msg), readyState: 1 } as any;

    mgr.add("device-1", mockWs);
    mgr.broadcast("agent:progress", { agent: "forge", text: "hello" });

    expect(messages.length).toBe(1);
    const parsed = JSON.parse(messages[0]);
    expect(parsed.type).toBe("event");
    expect(parsed.method).toBe("agent:progress");
    expect(parsed.payload.agent).toBe("forge");
  });

  it("broadcasts only to subscribed clients", () => {
    const mgr = new ConnectionManager();
    const msg1: string[] = [];
    const msg2: string[] = [];
    const ws1 = { send: (m: string) => msg1.push(m), readyState: 1 } as any;
    const ws2 = { send: (m: string) => msg2.push(m), readyState: 1 } as any;

    mgr.add("d1", ws1);
    mgr.add("d2", ws2);
    mgr.subscribe("d1", "log:entry");

    mgr.broadcastToSubscribed("log:entry", { message: "test" });

    expect(msg1.length).toBe(1);
    expect(msg2.length).toBe(0);
  });

  it("lists connected devices", () => {
    const mgr = new ConnectionManager();
    const ws = { send: () => {}, readyState: 1 } as any;

    mgr.add("d1", ws, { deviceName: "Browser" });
    mgr.add("d2", ws, { deviceName: "iOS" });

    const list = mgr.listConnected();
    expect(list.length).toBe(2);
    expect(list[0].deviceName).toBe("Browser");
  });

  it("reports connection diagnostics", () => {
    const mgr = new ConnectionManager();
    const ws = { send: () => {}, readyState: 1 } as any;

    mgr.add("d1", ws, { deviceName: "Browser" });
    mgr.subscribe("d1", "log:entry");

    const stats = mgr.getStats();
    expect(stats.connected).toBe(1);
    expect(stats.subscriptions).toBe(1);
    expect(stats.bufferedMessages).toBe(0);
  });
});

describe("MethodRouter", () => {
  let router: MethodRouter;

  beforeEach(() => {
    router = new MethodRouter();
  });

  it("dispatches to registered handler", async () => {
    // Use a real method name that has a schema in methodSchemas
    router.register("system.health", async () => {
      return { uptime: 123, queueDepth: 0, activeConnections: 1, agents: 2, memoryUsage: 1024 };
    });

    const frame = JSON.stringify({
      type: "req",
      id: "req-1",
      method: "system.health",
      payload: {},
    });

    const result = await router.dispatch(frame, "device-1");
    expect(result).not.toBeNull();
    const parsed = JSON.parse(result!);
    expect(parsed.type).toBe("res");
    expect(parsed.id).toBe("req-1");
    expect(parsed.payload.uptime).toBe(123);
    expect(router.listMethods()).toContain("system.health");
    expect(router.getMetrics().find((metric) => metric.method === "system.health")?.count).toBe(1);
  });

  it("returns error for unknown method", async () => {
    const frame = JSON.stringify({
      type: "req",
      id: "req-2",
      method: "nonexistent.method",
      payload: {},
    });

    const result = await router.dispatch(frame, "device-1");
    const parsed = JSON.parse(result!);
    expect(parsed.error.code).toBe("METHOD_NOT_FOUND");
  });

  it("returns error for invalid JSON", async () => {
    const result = await router.dispatch("not json{}", "device-1");
    const parsed = JSON.parse(result!);
    expect(parsed.error.code).toBe("INVALID_JSON");
  });

  it("returns error for invalid frame structure", async () => {
    const result = await router.dispatch(JSON.stringify({ foo: "bar" }), "device-1");
    const parsed = JSON.parse(result!);
    expect(parsed.error.code).toBe("INVALID_FRAME");
  });

  it("ignores non-request frames", async () => {
    const frame = JSON.stringify({
      type: "event",
      id: "evt-1",
      method: "test",
      payload: {},
    });

    const result = await router.dispatch(frame, "device-1");
    expect(result).toBeNull();
  });

  it("catches handler errors", async () => {
    // Use a real method name that has a schema in methodSchemas
    router.register("knowledge.stats", async () => {
      throw new Error("Intentional failure");
    });

    const frame = JSON.stringify({
      type: "req",
      id: "req-3",
      method: "knowledge.stats",
      payload: {},
    });

    const result = await router.dispatch(frame, "device-1");
    const parsed = JSON.parse(result!);
    expect(parsed.error.code).toBe("HANDLER_ERROR");
    expect(parsed.error.message).toBe("Intentional failure");
    const metric = router.getMetrics().find((entry) => entry.method === "knowledge.stats");
    expect(metric?.failures).toBe(1);
    expect(metric?.lastError).toBe("Intentional failure");
  });
});

describe("DeviceStore", () => {
  let store: DeviceStore;

  beforeEach(() => {
    const db = new Database(":memory:");
    db.exec("PRAGMA journal_mode = WAL");
    store = new DeviceStore(db);
  });

  it("registers and lists pending devices", async () => {
    await store.registerDevice("dev-1", "Test Browser", "secret123");
    const pending = store.pendingDevices();
    expect(pending.length).toBe(1);
    expect(pending[0].name).toBe("Test Browser");
  });

  it("approves a device", async () => {
    await store.registerDevice("dev-1", "Test", "secret");
    expect(store.isApproved("dev-1")).toBe(false);

    store.approveDevice("dev-1");
    expect(store.isApproved("dev-1")).toBe(true);
  });

  it("verifies an approved device", async () => {
    await store.registerDevice("dev-1", "Test", "mysecret");
    store.approveDevice("dev-1");

    const valid = await store.verifyDevice("dev-1", "mysecret");
    expect(valid).toBe(true);

    const invalid = await store.verifyDevice("dev-1", "wrong");
    expect(invalid).toBe(false);
  });

  it("rejects verification for unapproved devices", async () => {
    await store.registerDevice("dev-1", "Test", "secret");
    const valid = await store.verifyDevice("dev-1", "secret");
    expect(valid).toBe(false);
  });

  it("revokes a device", async () => {
    await store.registerDevice("dev-1", "Test", "secret");
    store.approveDevice("dev-1");
    expect(store.isApproved("dev-1")).toBe(true);

    store.revokeDevice("dev-1");
    expect(store.isApproved("dev-1")).toBe(false);
  });

  it("generates challenges", () => {
    const c1 = store.generateChallenge();
    const c2 = store.generateChallenge();
    expect(c1.nonce).toBeDefined();
    expect(c1.nonce).not.toBe(c2.nonce);
  });

  it("updates last seen timestamp", async () => {
    await store.registerDevice("dev-1", "Test", "secret");
    store.approveDevice("dev-1");
    store.updateLastSeen("dev-1");

    const devices = store.listDevices();
    expect(devices[0].last_seen).not.toBeNull();
  });
});

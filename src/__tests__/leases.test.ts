import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { LeaseStore } from "../security/leases.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("LeaseStore", () => {
  let store: LeaseStore;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "lease-test-"));
    store = new LeaseStore(tmpDir, "test");
  });

  afterEach(() => {
    store.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("acquire succeeds on free resource", () => {
    const result = store.acquire("src/index.ts", "nyx", "run-1");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.lease.resource).toBe("src/index.ts");
      expect(result.lease.holder).toBe("nyx");
      expect(result.lease.run_id).toBe("run-1");
    }
  });

  test("acquire fails when held by another", () => {
    store.acquire("src/index.ts", "nyx", "run-1");
    const result = store.acquire("src/index.ts", "forge", "run-2");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.conflict.holder).toBe("nyx");
    }
  });

  test("same holder can re-acquire (idempotent)", () => {
    store.acquire("src/index.ts", "nyx", "run-1");
    const result = store.acquire("src/index.ts", "nyx", "run-1");
    expect(result.ok).toBe(true);
  });

  test("release frees the resource", () => {
    store.acquire("src/index.ts", "nyx", "run-1");
    const released = store.release("src/index.ts", "nyx");
    expect(released).toBe(true);

    // Now another holder can acquire
    const result = store.acquire("src/index.ts", "forge", "run-2");
    expect(result.ok).toBe(true);
  });

  test("release fails for wrong holder", () => {
    store.acquire("src/index.ts", "nyx", "run-1");
    const released = store.release("src/index.ts", "forge");
    expect(released).toBe(false);
  });

  test("check returns holder info", () => {
    store.acquire("src/index.ts", "nyx", "run-1");
    const lease = store.check("src/index.ts");
    expect(lease).not.toBeNull();
    expect(lease!.holder).toBe("nyx");
  });

  test("check returns null for free resource", () => {
    const lease = store.check("src/index.ts");
    expect(lease).toBeNull();
  });

  test("expired leases are auto-released", async () => {
    store.acquire("src/index.ts", "nyx", "run-1", 1); // 1ms TTL
    await new Promise((r) => setTimeout(r, 10));
    const lease = store.check("src/index.ts");
    expect(lease).toBeNull();
  });

  test("renew extends expiry", () => {
    store.acquire("src/index.ts", "nyx", "run-1", 100);
    const renewed = store.renew("src/index.ts", "nyx", 60_000);
    expect(renewed).toBe(true);
    const lease = store.check("src/index.ts");
    expect(lease).not.toBeNull();
  });

  test("renew fails for wrong holder", () => {
    store.acquire("src/index.ts", "nyx", "run-1");
    const renewed = store.renew("src/index.ts", "forge");
    expect(renewed).toBe(false);
  });

  test("listActive returns all current leases", () => {
    store.acquire("file-a", "nyx", "r1");
    store.acquire("file-b", "forge", "r2");
    const active = store.listActive();
    expect(active).toHaveLength(2);
  });

  test("releaseAll removes all leases for holder", () => {
    store.acquire("file-a", "nyx", "r1");
    store.acquire("file-b", "nyx", "r2");
    store.acquire("file-c", "forge", "r3");
    const released = store.releaseAll("nyx");
    expect(released).toBe(2);
    expect(store.listActive()).toHaveLength(1);
  });

  test("releaseByRun removes all leases for a run", () => {
    store.acquire("file-a", "nyx", "run-1");
    store.acquire("file-b", "forge", "run-1");
    store.acquire("file-c", "forge", "run-2");
    const released = store.releaseByRun("run-1");
    expect(released).toBe(2);
    expect(store.listActive()).toHaveLength(1);
  });
});

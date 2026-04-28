import { afterEach, describe, expect, test } from "bun:test";
import { closeSync, existsSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildDatabaseChecks, buildPortCheck } from "../cli/health.js";

let tmpDir: string | undefined;

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

function touch(path: string) {
  closeSync(openSync(path, "w"));
}

describe("CLI health checks", () => {
  test("checks the current runtime database filenames", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "nyxhive-cli-health-"));
    touch(join(tmpDir, "nyxai.db"));
    touch(join(tmpDir, "memory.db"));

    const checks = buildDatabaseChecks(tmpDir);

    expect(checks.map((check) => check.name)).toEqual(["nyxai.db", "memory.db"]);
    expect(checks.every((check) => check.ok)).toBe(true);
    expect(existsSync(join(tmpDir, "queue.sqlite"))).toBe(false);
  });

  test("fails the port check when a live pid exists but health is unreachable", async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "nyxhive-cli-health-"));
    const pidFile = join(tmpDir, "nyxhive.pid");
    writeFileSync(pidFile, "12345");

    const check = await buildPortCheck(3779, {
      pidFile,
      fetchHealth: async () => {
        throw Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
      },
      signalProcess: () => {},
    });

    expect(check.ok).toBe(false);
    expect(check.name).toBe("Port");
    expect(check.detail).toContain("3779");
    expect(check.detail).toContain("unreachable");
    expect(check.detail).toContain("PID 12345");
    expect(check.detail).toContain("ECONNREFUSED");
  });

  test("fails the port check when the runtime health body is degraded", async () => {
    const check = await buildPortCheck(3779, {
      fetchHealth: async () => ({ ok: false, status: 200, healthStatus: "degraded" }),
    });

    expect(check.ok).toBe(false);
    expect(check.name).toBe("Port");
    expect(check.detail).toContain("3779");
    expect(check.detail).toContain("instance running");
    expect(check.detail).toContain("health degraded");
  });
});

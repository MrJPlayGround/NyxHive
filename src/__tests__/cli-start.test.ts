import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseStartArgs } from "../cli/start-args.js";
import { readRunningPid } from "../cli/start.js";

let tmpDir: string | undefined;

afterEach(() => {
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

describe("parseStartArgs", () => {
  it("parses instance and brain without treating brain as a second instance", () => {
    const parsed = parseStartArgs(["nyxai", "--brain", "anthropic"]);
    expect(parsed.instanceName).toBe("nyxai");
    expect(parsed.brain).toBe("anthropic");
    expect(parsed.daemon).toBe(false);
  });

  it("parses daemon and config flags alongside brain", () => {
    const parsed = parseStartArgs(["nyxai", "--daemon", "--brain", "anthropic", "--config", "/tmp/nyx.toml"]);
    expect(parsed.instanceName).toBe("nyxai");
    expect(parsed.daemon).toBe(true);
    expect(parsed.brain).toBe("anthropic");
    expect(parsed.configPath).toBe("/tmp/nyx.toml");
  });
});

describe("readRunningPid", () => {
  it("returns an active PID from the PID file", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "nyxhive-cli-start-"));
    const pidFile = join(tmpDir, "nyxhive.pid");
    writeFileSync(pidFile, "12345");

    const pid = readRunningPid(pidFile, (candidate, signal) => {
      expect(candidate).toBe(12345);
      expect(signal).toBe(0);
    });

    expect(pid).toBe(12345);
    expect(existsSync(pidFile)).toBe(true);
  });

  it("removes stale PID files", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "nyxhive-cli-start-"));
    const pidFile = join(tmpDir, "nyxhive.pid");
    writeFileSync(pidFile, "12345");

    const pid = readRunningPid(pidFile, () => {
      throw new Error("not running");
    });

    expect(pid).toBeNull();
    expect(existsSync(pidFile)).toBe(false);
  });

  it("treats EPERM PID probes as running", () => {
    tmpDir = mkdtempSync(join(tmpdir(), "nyxhive-cli-start-"));
    const pidFile = join(tmpDir, "nyxhive.pid");
    writeFileSync(pidFile, "12345");

    const pid = readRunningPid(pidFile, () => {
      throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
    });

    expect(pid).toBe(12345);
    expect(existsSync(pidFile)).toBe(true);
  });
});

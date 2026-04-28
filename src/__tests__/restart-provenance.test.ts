import { Database } from "bun:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { AuditLog } from "../utils/audit.js";
import {
  ingestRestartProvenance,
  writeRestartProvenance,
} from "../runtime/restart-provenance.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("restart provenance", () => {
  test("writes restart records as durable jsonl before the daemon is killed", () => {
    const runDir = mkdtempSync(join(tmpdir(), "nyxhive-restart-provenance-"));
    tempDirs.push(runDir);

    const record = writeRestartProvenance(runDir, {
      id: "restart-1",
      action: "execute",
      instance: "nyxai",
      source: "codex",
      reason: "load bf1a985f",
      runId: "run-123",
      traceId: "trace-123",
      callerPid: 100,
      parentPid: 99,
      cwd: "/home/user/dev/nyxhive",
      argv: ["nyxai"],
    });

    const lines = readFileSync(join(runDir, "restart-provenance.jsonl"), "utf8")
      .trim()
      .split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({
      id: "restart-1",
      action: "execute",
      instance: "nyxai",
      source: "codex",
      reason: "load bf1a985f",
      run_id: "run-123",
      trace_id: "trace-123",
      caller_pid: 100,
      parent_pid: 99,
      cwd: "/home/user/dev/nyxhive",
      argv: ["nyxai"],
    });
    expect(record.timestamp).toBeGreaterThan(0);
  });

  test("ingests restart provenance into audit log once", () => {
    const runDir = mkdtempSync(join(tmpdir(), "nyxhive-restart-provenance-"));
    tempDirs.push(runDir);
    const db = new Database(":memory:");
    const audit = new AuditLog(db);

    writeRestartProvenance(runDir, {
      id: "restart-2",
      action: "schedule",
      instance: "nyxai",
      source: "self-helper",
      reason: "load new runtime",
      runId: "run-abc",
      callerPid: 200,
      parentPid: 199,
      cwd: "/repo",
      argv: ["--self"],
      logFile: "/tmp/restart.log",
      sessionName: "self-restart-nyxai-1",
    });

    expect(ingestRestartProvenance(runDir, audit)).toEqual({ ingested: 1, skipped: 0 });
    expect(ingestRestartProvenance(runDir, audit)).toEqual({ ingested: 0, skipped: 1 });

    const rows = audit.query({ event: "runtime.restart_requested", limit: 10 });
    expect(rows).toHaveLength(1);
    expect(rows[0].channel).toBe("restart");
    expect(rows[0].sender_id).toBe("self-helper");
    expect(rows[0].agent).toBe("nyxai");
    expect(JSON.parse(rows[0].detail ?? "{}")).toMatchObject({
      id: "restart-2",
      action: "schedule",
      instance: "nyxai",
      source: "self-helper",
      reason: "load new runtime",
      run_id: "run-abc",
      log_file: "/tmp/restart.log",
      session_name: "self-restart-nyxai-1",
    });
  });
});

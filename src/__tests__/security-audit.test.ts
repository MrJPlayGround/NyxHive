import { describe, test, expect, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { AuditLog } from "../utils/audit.js";

describe("AuditLog security events", () => {
  let db: Database;
  let audit: AuditLog;

  beforeEach(() => {
    db = new Database(":memory:");
    audit = new AuditLog(db);
  });

  test("logs command_exec events", () => {
    audit.log({
      event: "security.command_exec",
      agent: "forge",
      detail: JSON.stringify({
        command: "git push origin main",
        verdict: "approval_required",
        outcome: "approved",
        trigger: "delegation",
        sender: "jay",
      }),
    });
    const results = audit.query({ event: "security.command_exec" });
    expect(results.length).toBe(1);
    expect(results[0].agent).toBe("forge");
    const detail = JSON.parse(results[0].detail!);
    expect(detail.verdict).toBe("approval_required");
  });

  test("logs credential_access events", () => {
    audit.log({
      event: "security.credential_access",
      agent: "forge",
      detail: JSON.stringify({
        credential: "GITHUB_TOKEN",
        trigger: "user_message",
      }),
    });
    const results = audit.query({ event: "security.credential_access" });
    expect(results.length).toBe(1);
  });

  test("logs delegation_blocked events", () => {
    audit.log({
      event: "security.delegation_blocked",
      agent: "nyx",
      sender_id: "unknown-user",
      detail: JSON.stringify({
        target: "forge",
        task: "rm -rf everything",
        reason: "untrusted sender",
      }),
    });
    const results = audit.query({ event: "security.delegation_blocked" });
    expect(results.length).toBe(1);
  });

  test("queries by agent", () => {
    audit.log({ event: "security.command_exec", agent: "forge", detail: "cmd1" });
    audit.log({ event: "security.command_exec", agent: "vigil", detail: "cmd2" });
    audit.log({ event: "security.command_exec", agent: "forge", detail: "cmd3" });
    const results = audit.query({ event: "security.command_exec", agent: "forge" });
    expect(results.length).toBe(2);
  });

  test("queries with since filter", () => {
    const old = Date.now() - 100000;
    audit.log({ event: "security.command_exec", agent: "forge", detail: "recent" });
    const results = audit.query({ event: "security.command_exec", since: old });
    expect(results.length).toBe(1);
  });
});

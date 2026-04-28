import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ThreadDB, generateTitle } from "../server/db/threads.js";

describe("generateTitle", () => {
  test("turns noisy verification prompts into readable labels", () => {
    expect(generateTitle("Reply with exactly: alive")).toBe("Ping check");
    expect(generateTitle("Reply only with yes or no: does src/nyx/commands/cockpit.ts exist in your repo right now?")).toBe("File existence check: cockpit.ts");
    expect(generateTitle("Reply only with the current contents of src/nyx/index.ts if it contains an import for ./commands/cockpit.js, otherwise reply NO.")).toBe("File contents check: index.ts");
    expect(generateTitle("In your nyxhive repo, reply with only: repo path, current branch, current HEAD sha, and git status --short. No prose.")).toBe("Repo state check");
  });

  test("pulls the actual mission out of handoff prompts", () => {
    expect(generateTitle("Work in /home/user/dev/nyxhive.\n\nMission:\nStart Phase 1 of the web cockpit so the gateway becomes a real fleet command center.\n\nRead first:\n- plans/gateway-cockpit.md")).toBe("Gateway cockpit phase 1");
  });
});

describe("ThreadDB undoLastExchange", () => {
  let tmpDir: string;
  let db: Database;
  let threads: ThreadDB;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "threads-db-test-"));
    db = new Database(join(tmpDir, "threads.db"));
    threads = new ThreadDB(db);
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("recalculates session cost after removing the last exchange", () => {
    const session = threads.createSession({ instance: "test", title: "Session" });

    threads.addThreadMessage(session.id, {
      role: "user",
      content: "first",
    });
    threads.addThreadMessage(session.id, {
      role: "assistant",
      content: "first reply",
      cost_cents: 10,
    });
    threads.addThreadMessage(session.id, {
      role: "user",
      content: "second",
    });
    threads.addThreadMessage(session.id, {
      role: "assistant",
      content: "second reply",
      cost_cents: 25,
    });
    threads.updateThread(session.id, { cost_cents: 35 });

    const deleted = threads.undoLastExchange(session.id);
    const updated = threads.getThread(session.id);

    expect(deleted).toBe(2);
    expect(updated?.cost_cents).toBe(10);
    expect(threads.countThreadMessages(session.id)).toBe(2);
  });

  test("refreshes session updated_at when adding messages", async () => {
    const first = threads.createSession({ instance: "test", title: "First" });
    const firstUpdatedAt = first.updated_at;

    await Bun.sleep(2);
    const second = threads.createSession({ instance: "test", title: "Second" });
    await Bun.sleep(2);

    threads.addThreadMessage(first.id, {
      role: "user",
      content: "newer activity",
    });

    const refreshed = threads.getThread(first.id);
    const listed = threads.listThreads({ category: "session" }).threads;

    expect(refreshed?.updated_at).toBeGreaterThan(firstUpdatedAt);
    expect(listed[0]?.id).toBe(first.id);
    expect(listed[1]?.id).toBe(second.id);
  });
});

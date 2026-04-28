import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { ThreadDB } from "../server/db/threads.js";
import { randomUUID } from "crypto";
import { executeTool } from "../agents/tools.js";
import type { ToolContext } from "../agents/tools.js";
import type { ToolCall } from "../providers/types.js";
import { writeFileSync, mkdirSync, rmSync, existsSync, realpathSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

describe("ThreadDB file changes", () => {
  let db: ThreadDB;
  let threadId: string;

  beforeEach(() => {
    db = new ThreadDB(new Database(":memory:"));
    const thread = db.createThread({ message: "test", instance: "test" });
    threadId = thread.id;
  });

  afterEach(() => {
    db.close();
  });

  it("records a file change", () => {
    const id = randomUUID();
    db.recordFileChange({
      id,
      threadId,
      filePath: "src/index.ts",
      operation: "write",
      linesAdded: 10,
      linesRemoved: 0,
    });

    const changes = db.getFileChanges(threadId);
    expect(changes).toHaveLength(1);
    expect(changes[0].id).toBe(id);
    expect(changes[0].threadId).toBe(threadId);
    expect(changes[0].filePath).toBe("src/index.ts");
    expect(changes[0].operation).toBe("write");
    expect(changes[0].linesAdded).toBe(10);
    expect(changes[0].linesRemoved).toBe(0);
    expect(changes[0].timestamp).toBeGreaterThan(0);
  });

  it("records a file change with messageId and diffSummary", () => {
    const id = randomUUID();
    const msgId = randomUUID();
    db.recordFileChange({
      id,
      threadId,
      messageId: msgId,
      filePath: "src/app.ts",
      operation: "edit",
      linesAdded: 5,
      linesRemoved: 3,
      diffSummary: "@@ edit @@\n-old\n+new",
    });

    const changes = db.getFileChanges(threadId);
    expect(changes).toHaveLength(1);
    expect(changes[0].messageId).toBe(msgId);
    expect(changes[0].diffSummary).toBe("@@ edit @@\n-old\n+new");
  });

  it("returns changes ordered by timestamp", async () => {
    db.recordFileChange({
      id: randomUUID(),
      threadId,
      filePath: "first.ts",
      operation: "create",
    });
    // Small delay to ensure different timestamps
    await new Promise(r => setTimeout(r, 5));
    db.recordFileChange({
      id: randomUUID(),
      threadId,
      filePath: "second.ts",
      operation: "write",
    });

    const changes = db.getFileChanges(threadId);
    expect(changes).toHaveLength(2);
    expect(changes[0].filePath).toBe("first.ts");
    expect(changes[1].filePath).toBe("second.ts");
    expect(changes[0].timestamp).toBeLessThanOrEqual(changes[1].timestamp);
  });

  it("rejects invalid operations via CHECK constraint", () => {
    expect(() => {
      db.recordFileChange({
        id: randomUUID(),
        threadId,
        filePath: "test.ts",
        operation: "invalid" as any,
      });
    }).toThrow();
  });

  it("returns empty array for thread with no changes", () => {
    const changes = db.getFileChanges(threadId);
    expect(changes).toEqual([]);
  });

  it("defaults linesAdded and linesRemoved to 0", () => {
    db.recordFileChange({
      id: randomUUID(),
      threadId,
      filePath: "test.ts",
      operation: "create",
    });

    const changes = db.getFileChanges(threadId);
    expect(changes[0].linesAdded).toBe(0);
    expect(changes[0].linesRemoved).toBe(0);
  });

  it("isolates changes by thread", () => {
    const thread2 = db.createThread({ message: "other", instance: "test" });

    db.recordFileChange({
      id: randomUUID(),
      threadId,
      filePath: "a.ts",
      operation: "write",
    });
    db.recordFileChange({
      id: randomUUID(),
      threadId: thread2.id,
      filePath: "b.ts",
      operation: "create",
    });

    const changes1 = db.getFileChanges(threadId);
    const changes2 = db.getFileChanges(thread2.id);
    expect(changes1).toHaveLength(1);
    expect(changes1[0].filePath).toBe("a.ts");
    expect(changes2).toHaveLength(1);
    expect(changes2[0].filePath).toBe("b.ts");
  });
});

describe("ThreadDB execution events", () => {
  let db: ThreadDB;
  let threadId: string;

  beforeEach(() => {
    db = new ThreadDB(new Database(":memory:"));
    const thread = db.createThread({ message: "test", instance: "test" });
    threadId = thread.id;
  });

  afterEach(() => {
    db.close();
  });

  it("records execution events for a thread", () => {
    db.recordExecutionEvent({
      threadId,
      id: "cmd:1",
      kind: "command",
      phase: "started",
      turn: 1,
      title: "Running command",
      command: "rg -n crawl src",
    });

    const events = db.getExecutionEvents(threadId);
    expect(events).toHaveLength(1);
    expect(events[0].id).toBe("cmd:1");
    expect(events[0].kind).toBe("command");
    expect(events[0].turn).toBe(1);
    expect(events[0].title).toBe("Running command");
    expect(events[0].command).toBe("rg -n crawl src");
  });

  it("updates an existing execution event by thread and id", () => {
    db.recordExecutionEvent({
      threadId,
      id: "cmd:1",
      kind: "command",
      phase: "started",
      title: "Running command",
      command: "rg -n crawl src",
      timestamp: 100,
    });
    db.recordExecutionEvent({
      threadId,
      id: "cmd:1",
      kind: "command",
      phase: "completed",
      title: "Command run complete",
      command: "rg -n crawl src",
      outputPreview: "src/crawl/index.ts:1:export * from ...",
      exitCode: 0,
      timestamp: 200,
    });

    const events = db.getExecutionEvents(threadId);
    expect(events).toHaveLength(1);
    expect(events[0].phase).toBe("completed");
    expect(events[0].title).toBe("Command run complete");
    expect(events[0].outputPreview).toContain("src/crawl/index.ts");
    expect(events[0].exitCode).toBe(0);
    expect(events[0].timestamp).toBe(100);
  });

  it("returns execution events ordered by timestamp", () => {
    db.recordExecutionEvent({
      threadId,
      id: "one",
      kind: "status",
      phase: "completed",
      title: "First",
      timestamp: 10,
    });
    db.recordExecutionEvent({
      threadId,
      id: "two",
      kind: "status",
      phase: "completed",
      title: "Second",
      timestamp: 20,
    });

    const events = db.getExecutionEvents(threadId);
    expect(events.map((event) => event.id)).toEqual(["one", "two"]);
  });

  it("cascades file changes and execution events when deleting a thread", () => {
    db.recordFileChange({
      id: randomUUID(),
      threadId,
      filePath: "src/example.ts",
      operation: "edit",
    });
    db.recordExecutionEvent({
      threadId,
      id: "cleanup",
      kind: "command",
      phase: "completed",
      title: "Cleanup command complete",
      command: "git status --short",
    });

    expect(db.getFileChanges(threadId)).toHaveLength(1);
    expect(db.getExecutionEvents(threadId)).toHaveLength(1);

    expect(db.deleteThread(threadId)).toBe(true);
    expect(db.getThread(threadId)).toBeNull();
    expect(db.getFileChanges(threadId)).toHaveLength(0);
    expect(db.getExecutionEvents(threadId)).toHaveLength(0);
  });
});

describe("onFileChange callback in executeTool", () => {
  let workDir: string;

  beforeEach(() => {
    const raw = join(tmpdir(), `file-changes-test-${randomUUID()}`);
    mkdirSync(raw, { recursive: true });
    workDir = realpathSync(raw); // resolve symlinks so path validation works
  });

  afterEach(() => {
    if (existsSync(workDir)) {
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  it("calls onFileChange for write_file (new file = create)", async () => {
    const changes: any[] = [];
    const ctx: ToolContext = {
      workDir,
      writable: true,
      onFileChange: (c) => changes.push(c),
    };

    const tool: ToolCall = {
      name: "write_file",
      arguments: { path: "newfile.ts", content: "line1\nline2\nline3" },
    };

    await executeTool(tool, ctx);

    expect(changes).toHaveLength(1);
    expect(changes[0].filePath).toBe("newfile.ts");
    expect(changes[0].operation).toBe("create");
    expect(changes[0].linesAdded).toBe(3);
    expect(changes[0].linesRemoved).toBe(0);
  });

  it("calls onFileChange for write_file (existing file = write)", async () => {
    // Create the file first
    writeFileSync(join(workDir, "existing.ts"), "old content");

    const changes: any[] = [];
    const ctx: ToolContext = {
      workDir,
      writable: true,
      onFileChange: (c) => changes.push(c),
    };

    const tool: ToolCall = {
      name: "write_file",
      arguments: { path: "existing.ts", content: "new\ncontent" },
    };

    await executeTool(tool, ctx);

    expect(changes).toHaveLength(1);
    expect(changes[0].operation).toBe("write");
    expect(changes[0].linesAdded).toBe(2);
  });

  it("calls onFileChange for edit_file", async () => {
    writeFileSync(join(workDir, "edit-me.ts"), "const x = 1;\nconst y = 2;\n");

    const changes: any[] = [];
    const ctx: ToolContext = {
      workDir,
      writable: true,
      onFileChange: (c) => changes.push(c),
    };

    const tool: ToolCall = {
      name: "edit_file",
      arguments: {
        path: "edit-me.ts",
        old_string: "const x = 1;",
        new_string: "const x = 42;\nconst z = 99;",
      },
    };

    await executeTool(tool, ctx);

    expect(changes).toHaveLength(1);
    expect(changes[0].filePath).toBe("edit-me.ts");
    expect(changes[0].operation).toBe("edit");
    expect(changes[0].linesAdded).toBe(1); // 2 new lines - 1 old line
    expect(changes[0].linesRemoved).toBe(0);
    expect(changes[0].diffSummary).toContain("-const x = 1;");
    expect(changes[0].diffSummary).toContain("+const x = 42;");
  });

  it("does not call onFileChange when callback is not set", async () => {
    const ctx: ToolContext = {
      workDir,
      writable: true,
      // no onFileChange
    };

    const tool: ToolCall = {
      name: "write_file",
      arguments: { path: "notrack.ts", content: "hello" },
    };

    // Should not throw
    const result = await executeTool(tool, ctx);
    expect(result).toContain("Wrote");
  });

  it("truncates diffSummary to 500 chars", async () => {
    const longOld = "x".repeat(300);
    const longNew = "y".repeat(300);
    writeFileSync(join(workDir, "long.ts"), `prefix\n${longOld}\nsuffix`);

    const changes: any[] = [];
    const ctx: ToolContext = {
      workDir,
      writable: true,
      onFileChange: (c) => changes.push(c),
    };

    const tool: ToolCall = {
      name: "edit_file",
      arguments: {
        path: "long.ts",
        old_string: longOld,
        new_string: longNew,
      },
    };

    await executeTool(tool, ctx);

    expect(changes).toHaveLength(1);
    expect(changes[0].diffSummary!.length).toBeLessThanOrEqual(500);
  });
});

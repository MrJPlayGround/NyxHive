import { describe, expect, test } from "bun:test";
import { buildTerminalContextBlock, resolveRuntimeEvents } from "../gateway/src/lib/chat-runtime";
import { buildChangeTree } from "../gateway/src/lib/thread-changes";

describe("gateway chat runtime helpers", () => {
  test("maps diff.updated frames into typed runtime events", () => {
    const [event] = resolveRuntimeEvents({
      type: "event",
      id: "evt-1",
      method: "diff.updated",
      payload: {
        threadId: "thread-1",
        changes: [
          {
            id: "change-1",
            threadId: "thread-1",
            filePath: "src/gateway/src/pages/Chat.tsx",
            operation: "edit",
            linesAdded: 12,
            linesRemoved: 4,
            timestamp: 123,
          },
        ],
      },
    });

    expect(event.type).toBe("diff.updated");
    if (event.type !== "diff.updated") throw new Error("unexpected event");
    expect(event.changes[0].filePath).toBe("src/gateway/src/pages/Chat.tsx");
  });

  test("preserves run ids on turn lifecycle frames", () => {
    const [started] = resolveRuntimeEvents({
      type: "event",
      id: "evt-start",
      method: "turn.started",
      payload: {
        threadId: "thread-1",
        turn: 2,
        runId: "chat:thread-1:2",
        agent: "nyx",
        startedAt: 100,
      },
    });
    const [completed] = resolveRuntimeEvents({
      type: "event",
      id: "evt-complete",
      method: "turn.completed",
      payload: {
        threadId: "thread-1",
        turn: 2,
        runId: "chat:thread-1:2",
        status: "completed",
        finishedAt: 200,
      },
    });

    expect(started.type).toBe("turn.started");
    expect(completed.type).toBe("turn.completed");
    if (started.type !== "turn.started" || completed.type !== "turn.completed") {
      throw new Error("unexpected event types");
    }
    expect(started.runId).toBe("chat:thread-1:2");
    expect(completed.runId).toBe("chat:thread-1:2");
  });

  test("maps run heartbeat frames with run ids", () => {
    const [event] = resolveRuntimeEvents({
      type: "event",
      id: "evt-heartbeat",
      method: "run.heartbeat",
      payload: {
        threadId: "thread-1",
        runId: "chat:thread-1:2",
      },
    });

    expect(event.type).toBe("heartbeat");
    if (event.type !== "heartbeat") throw new Error("unexpected event");
    expect(event.threadId).toBe("thread-1");
    expect(event.runId).toBe("chat:thread-1:2");
  });

  test("normalizes assistant output directives on turn completion", () => {
    const [event] = resolveRuntimeEvents({
      type: "event",
      id: "evt-output",
      method: "turn.completed",
      payload: {
        threadId: "thread-1",
        turn: 2,
        runId: "chat:thread-1:2",
        agent: "nyx",
        status: "completed",
        finishedAt: 200,
        text: "done",
        output: {
          directives: [
            { type: "text", text: "done" },
            { type: "actionCard", title: "Review", actions: [{ id: "open", label: "Open", variant: "primary" }] },
          ],
        },
      },
    });

    expect(event.type).toBe("turn.completed");
    if (event.type !== "turn.completed") throw new Error("unexpected event");
    expect(event.output?.directives).toHaveLength(2);
    expect(event.output?.directives[0]).toEqual({ type: "text", text: "done" });
    expect(event.output?.directives[1]).toMatchObject({ type: "actionCard", title: "Review" });
  });

  test("uses legacy text as a text output fallback", () => {
    const [event] = resolveRuntimeEvents({
      type: "event",
      id: "evt-output-fallback",
      method: "turn.completed",
      payload: {
        threadId: "thread-1",
        turn: 2,
        agent: "nyx",
        status: "completed",
        finishedAt: 200,
        text: "legacy answer",
      },
    });

    expect(event.type).toBe("turn.completed");
    if (event.type !== "turn.completed") throw new Error("unexpected event");
    expect(event.output).toEqual({ directives: [{ type: "text", text: "legacy answer" }] });
  });

  test("builds a nested change tree from file paths", () => {
    const tree = buildChangeTree([
      {
        id: "change-1",
        threadId: "thread-1",
        filePath: "src/gateway/src/pages/Chat.tsx",
        operation: "edit",
        linesAdded: 1,
        linesRemoved: 0,
        timestamp: 1,
      },
      {
        id: "change-2",
        threadId: "thread-1",
        filePath: "src/gateway/src/components/chat/ExecutionPanel.tsx",
        operation: "edit",
        linesAdded: 1,
        linesRemoved: 0,
        timestamp: 2,
      },
    ]);

    expect(tree).toHaveLength(1);
    expect(tree[0].label).toBe("src");
    expect(tree[0].children.some((child) => child.label === "gateway")).toBe(true);
  });

  test("renders terminal context blocks with snippet labels and ranges", () => {
    const block = buildTerminalContextBlock([
      {
        id: "snippet-1",
        itemId: "item-1",
        label: "git status",
        content: "M src/index.ts",
        lineStart: 1,
        lineEnd: 1,
        createdAt: 1,
      },
    ]);

    expect(block).toContain("[Terminal Context]");
    expect(block).toContain("git status");
    expect(block).toContain("line 1");
  });
});

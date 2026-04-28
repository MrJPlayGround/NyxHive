import { describe, expect, test } from "bun:test";
import {
  buildFallbackExecutionEvent,
  buildInlineExecutionPreview,
  describeChatActivity,
  describeExecutionEvent,
  isPrimaryChatExecutionEvent,
  mapExecutionToMessages,
  parseMessageContent,
  stripThinking,
} from "./message-execution";
import type { ChatMessage, ExecutionEvent } from "../../stores/chat";

function assistantMessage(
  id: string,
  timestamp: number,
  streaming = false,
): ChatMessage {
  return {
    id,
    role: "assistant",
    content: streaming ? "" : `reply-${id}`,
    timestamp,
    streaming,
  };
}

describe("message execution helpers", () => {
  test("buildFallbackExecutionEvent derives a command event from streaming activity", () => {
    const events = buildFallbackExecutionEvent({
      id: "msg-1",
      role: "assistant",
      content: "",
      timestamp: 100,
      streaming: true,
      activity: "git status --short",
    });

    expect(events).toEqual([
      {
        id: "msg-1:activity",
        kind: "command",
        phase: "started",
        title: "Command run",
        command: "git status --short",
        details: undefined,
        timestamp: 100,
      },
    ]);
  });

  test("mapExecutionToMessages prefers explicit message ids", () => {
    const messages = [assistantMessage("a", 1000), assistantMessage("b", 2000)];
    const events: ExecutionEvent[] = [
      {
        id: "evt-1",
        kind: "mcp_tool",
        phase: "completed",
        title: "Search",
        timestamp: 1500,
        messageId: "b",
      },
    ];

    const result = mapExecutionToMessages(messages, events);
    expect(result.get("a")).toBeUndefined();
    expect(result.get("b")?.map((event) => event.id)).toEqual(["evt-1"]);
  });

  test("mapExecutionToMessages attaches live events to the streaming assistant turn", () => {
    const messages = [
      assistantMessage("old", 1_000, false),
      assistantMessage("live", 2_000, true),
    ];
    const events: ExecutionEvent[] = [
      {
        id: "evt-live",
        kind: "command",
        phase: "started",
        title: "Command run",
        command: "bun test",
        timestamp: 2_500,
      },
    ];

    const result = mapExecutionToMessages(messages, events);
    expect(result.get("live")?.map((event) => event.id)).toEqual(["evt-live"]);
    expect(result.get("old")).toBeUndefined();
  });

  test("stripThinking removes reasoning blocks while preserving the answer", () => {
    expect(
      stripThinking("<thinking>private trace</thinking>\nFinal answer"),
    ).toBe("Final answer");
  });

  test("parseMessageContent keeps reasoning separate from the final answer", () => {
    expect(
      parseMessageContent("<thinking>step one</thinking>\nFinal answer"),
    ).toEqual({
      answer: "Final answer",
      reasoning: "step one",
    });
  });

  test("describeExecutionEvent summarizes file changes cleanly", () => {
    expect(
      describeExecutionEvent({
        id: "evt-file",
        kind: "file_change",
        phase: "completed",
        title: "File change",
        timestamp: 100,
        changes: [{ path: "/repo/src/cockpit.tsx", kind: "update" }],
      }),
    ).toBe("update cockpit.tsx");
  });

  test("buildInlineExecutionPreview keeps primary chat free of live command chatter", () => {
    const events: ExecutionEvent[] = [
      {
        id: "done-1",
        kind: "command",
        phase: "completed",
        title: "Command run",
        command: "git status",
        timestamp: 100,
      },
      {
        id: "done-2",
        kind: "command",
        phase: "completed",
        title: "Command run",
        command: "bun test",
        timestamp: 200,
      },
      {
        id: "live",
        kind: "mcp_tool",
        phase: "started",
        title: "OpenClaw",
        timestamp: 300,
      },
      {
        id: "failed",
        kind: "status",
        phase: "failed",
        title: "Network retry failed",
        timestamp: 400,
      },
    ];

    expect(buildInlineExecutionPreview(events, 3)).toEqual({
      items: [events[3]],
      hiddenCount: 0,
    });
  });

  test("primary chat execution events keep evidence, not runtime stream noise", () => {
    expect(isPrimaryChatExecutionEvent({
      id: "running-command",
      kind: "command",
      phase: "started",
      title: "Command run",
      command: "bun test",
      timestamp: 100,
    })).toBe(false);
    expect(isPrimaryChatExecutionEvent({
      id: "changed",
      kind: "file_change",
      phase: "completed",
      title: "File change",
      changes: [{ path: "/repo/src/file.ts", kind: "update" }],
      timestamp: 100,
    })).toBe(true);
  });

  test("describeChatActivity rewrites raw activity into human waiting states", () => {
    expect(describeChatActivity("git status --short")).toBe("Nyx is working...");
    expect(describeChatActivity("Reading src/queue/processor.ts")).toBe("Nyx is checking context...");
    expect(describeChatActivity(undefined)).toBe("Nyx is thinking...");
  });
});

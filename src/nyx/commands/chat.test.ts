import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  cancelActiveTurn,
  getResponseEventCostCents,
  getThreadSnapshot,
  handleChatStreamEvent,
  parsePipeInputFrame,
  renderWelcomeBanner,
  resolveActiveMessageId,
  runPipeMode,
  runPromptMode,
  type ChatStreamRenderState,
} from "./chat.js";
import type { StatusBarData } from "../lib/skin.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function makeState(): ChatStreamRenderState {
  return {
    agentName: "onyx",
    responded: false,
    streamingTextStarted: false,
    responseFrameOpen: false,
  };
}

describe("handleChatStreamEvent", () => {
  test("streams token text inline and only renders the footer once the response arrives", () => {
    const calls: string[] = [];
    const spinnerCalls = { clear: 0, stop: 0, start: 0, update: 0 };
    const spinner = {
      clear: () => { spinnerCalls.clear++; },
      stop: () => { spinnerCalls.stop++; },
      start: () => { spinnerCalls.start++; },
      update: () => { spinnerCalls.update++; },
      notifyToken: () => {},
    };
    const statusData: StatusBarData = { tokensIn: 1000, tokensOut: 500 };
    const state = makeState();

    handleChatStreamEvent({ type: "token", text: "Hel", agent: "forge" }, {
      spinner,
      statusData,
      state,
      instName: "onyx",
      sessionMode: true,
      turnStart: Date.now() - 1000,
      addCostCents: (costCents) => { statusData.costCents = (statusData.costCents ?? 0) + costCents; },
      writeStdout: (text) => { calls.push(`stdout:${text}`); },
      writeLine: (text = "") => { calls.push(`line:${text}`); },
    });

    handleChatStreamEvent({ type: "token", text: "lo" }, {
      spinner,
      statusData,
      state,
      instName: "onyx",
      sessionMode: true,
      turnStart: Date.now() - 1000,
      addCostCents: (costCents) => { statusData.costCents = (statusData.costCents ?? 0) + costCents; },
      writeStdout: (text) => { calls.push(`stdout:${text}`); },
      writeLine: (text = "") => { calls.push(`line:${text}`); },
    });

    handleChatStreamEvent({ type: "response", response: "Hello", agent: "forge", cost_cents: 12 }, {
      spinner,
      statusData,
      state,
      instName: "onyx",
      sessionMode: true,
      turnStart: Date.now() - 1000,
      addCostCents: (costCents) => { statusData.costCents = (statusData.costCents ?? 0) + costCents; },
      writeStdout: (text) => { calls.push(`stdout:${text}`); },
      writeLine: (text = "") => { calls.push(`line:${text}`); },
    });

    expect(spinnerCalls.clear).toBeGreaterThanOrEqual(1);
    expect(spinnerCalls.stop).toBe(0);
    expect(state.responded).toBe(true);
    expect(calls[0]).toContain("forge");
    expect(calls).toContain("stdout:Hel");
    expect(calls).toContain("stdout:lo");
    expect(calls.some((call) => call.includes("Hello"))).toBe(false);
    expect(calls.at(-1)).toBe("line:");
  });

  test("falls back to full-response rendering when no token events were streamed", () => {
    const calls: string[] = [];
    let stopped = 0;
    const spinner = {
      clear: () => {},
      stop: () => { stopped++; },
      start: () => {},
      update: () => {},
      notifyToken: () => {},
    };
    const statusData: StatusBarData = {};
    const state = makeState();

    handleChatStreamEvent({ type: "response", response: "Full response", agent: "forge" }, {
      spinner,
      statusData,
      state,
      instName: "onyx",
      sessionMode: false,
      turnStart: Date.now() - 1000,
      addCostCents: () => {},
      writeStdout: (text) => { calls.push(`stdout:${text}`); },
      writeLine: (text = "") => { calls.push(`line:${text}`); },
    });

    expect(stopped).toBe(1);
    expect(calls.some((call) => call.includes("Full response"))).toBe(true);
  });

  test("reads response cost from wrapped SSE payloads", () => {
    const statusData: StatusBarData = {};
    const state = makeState();
    let addedCost = 0;

    handleChatStreamEvent({
      type: "response",
      data: { response: "Wrapped response", agent: "forge", cost_cents: 27 },
    }, {
      spinner: {
        clear: () => {},
        stop: () => {},
        start: () => {},
        update: () => {},
        notifyToken: () => {},
      },
      statusData,
      state,
      instName: "onyx",
      sessionMode: false,
      turnStart: Date.now() - 1000,
      addCostCents: (costCents) => { addedCost += costCents; },
      writeStdout: () => {},
      writeLine: () => {},
    });

    expect(addedCost).toBe(27);
    expect(state.agentName).toBe("forge");
  });
});

describe("runPromptMode", () => {
  test("prints plain text response in text mode", async () => {
    let stdout = "";
    const exitCode = await runPromptMode({
      prompt: "check vortex health",
      outputFormat: "text",
      executeMessage: async () => ({ ok: true, response: "Vortex is healthy." }),
      writeStdout: (text) => { stdout += text; },
    });

    expect(exitCode).toBe(0);
    expect(stdout).toBe("Vortex is healthy.\n");
    expect(stdout.includes("\"type\":\"done\"")).toBe(false);
  });

  test("emits jsonl in json mode", async () => {
    let stdout = "";
    const exitCode = await runPromptMode({
      prompt: "check vortex health",
      outputFormat: "json",
      executeMessage: async (emitEvent) => {
        emitEvent?.({ type: "turn_start", message_id: "m1", session_id: "sess-1" });
        emitEvent?.({ type: "text_delta", message_id: "m1", content: "Vortex " });
        emitEvent?.({ type: "done", message_id: "m1", session_id: "sess-1", response: "Vortex is healthy." });
        return { ok: true, response: "Vortex is healthy." };
      },
      writeStdout: (text) => { stdout += text; },
    });

    expect(exitCode).toBe(0);
    const lines = stdout.trim().split("\n").map((line) => JSON.parse(line));
    expect(lines[0]).toMatchObject({ type: "turn_start", message_id: "m1" });
    expect(lines.some((line) => line.type === "done")).toBe(true);
  });
});

describe("pipe helpers", () => {
  test("parses valid pipe frames", () => {
    expect(parsePipeInputFrame("{\"type\":\"message\",\"content\":\"oi\"}")).toEqual({
      type: "message",
      content: "oi",
    });
  });

  test("runPipeMode routes message and command frames", async () => {
    const seen: string[] = [];
    let stdout = "";

    const exitCode = await runPipeMode({
      input: [
        "{\"type\":\"message\",\"content\":\"check on vortex\",\"message_id\":\"m1\"}",
        "{\"type\":\"command\",\"command\":\"/new\",\"message_id\":\"m2\"}",
        "{\"type\":\"command\",\"command\":\"/stop\",\"message_id\":\"m3\"}",
      ],
      emitEvent: (event) => { stdout += `${JSON.stringify(event)}\n`; },
      handleMessage: async (frame) => {
        seen.push(`message:${frame.message_id}:${frame.content}`);
        stdout += `${JSON.stringify({ type: "text_delta", message_id: frame.message_id, content: "ok" })}\n`;
        stdout += `${JSON.stringify({ type: "done", message_id: frame.message_id, response: "ok" })}\n`;
      },
      handleCommand: async (frame) => {
        seen.push(`command:${frame.message_id}:${frame.command}`);
        stdout += `${JSON.stringify({ type: "command_done", message_id: frame.message_id, command: frame.command })}\n`;
        if (frame.command === "/stop") return { exit: true };
      },
    });

    expect(exitCode).toBe(0);
    expect(seen).toEqual([
      "message:m1:check on vortex",
      "command:m2:/new",
      "command:m3:/stop",
    ]);

    const lines = stdout.trim().split("\n").map((line) => JSON.parse(line));
    expect(lines.some((line) => line.type === "text_delta" && line.message_id === "m1")).toBe(true);
    expect(lines.some((line) => line.type === "done" && line.message_id === "m1")).toBe(true);
    expect(lines.some((line) => line.type === "command_done" && line.message_id === "m2")).toBe(true);
  });

  test("builds the shared thread snapshot for session and stateless modes", () => {
    expect(getThreadSnapshot("session-123", "nyx-cli:abcdefgh")).toEqual({
      session_id: "session-123",
      session_label: "session-123",
      stateless: false,
    });
    expect(getThreadSnapshot(null, "nyx-cli:abcdefgh")).toEqual({
      session_id: null,
      session_label: "stateless:abcdefgh",
      stateless: true,
    });
  });
});

describe("response event helpers", () => {
  test("prefers top-level response cost and falls back to wrapped SSE data", () => {
    expect(getResponseEventCostCents({ type: "response", cost_cents: 12 })).toBe(12);
    expect(getResponseEventCostCents({
      type: "response",
      data: { cost_cents: 34 },
    })).toBe(34);
    expect(getResponseEventCostCents({ type: "response" })).toBeUndefined();
  });
});

describe("interrupt helpers", () => {
  test("keeps the first known remote message id until a later event replaces it", () => {
    const first = resolveActiveMessageId(null, { message_id: "msg-1" });
    const unchanged = resolveActiveMessageId(first, {});
    const replaced = resolveActiveMessageId(unchanged, { message_id: "msg-2" });

    expect(first).toBe("msg-1");
    expect(unchanged).toBe("msg-1");
    expect(replaced).toBe("msg-2");
  });

  test("posts to the cancel endpoint before aborting the local stream", async () => {
    const abortController = new AbortController();
    const fetchMock = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("http://localhost:4000/api/message/msg-1/cancel");
      expect(init?.method).toBe("POST");
      expect(init?.headers).toEqual({ Authorization: "Bearer test-key" });
      expect(abortController.signal.aborted).toBe(false);
      return new Response(JSON.stringify({ cancelled: true }), { status: 200 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await cancelActiveTurn("http://localhost:4000", "test-key", abortController, "msg-1");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(abortController.signal.aborted).toBe(true);
  });

  test("still aborts locally when no remote message id is available", async () => {
    const abortController = new AbortController();
    const fetchMock = mock(async () => new Response(null, { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await cancelActiveTurn("http://localhost:4000", "test-key", abortController, null);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(abortController.signal.aborted).toBe(true);
  });
});

describe("renderWelcomeBanner", () => {
  test("includes instance, model, port, and version metadata", () => {
    const banner = renderWelcomeBanner({
      instName: "Onyx",
      sessionId: "session-12345678",
      agentHint: "strider",
      statelessId: "nyx-cli:abcd1234",
      model: "claude-sonnet-4-6",
      port: 3777,
      host: "http://localhost:3777",
    });

    expect(banner).toContain("onyx");
    expect(banner).toContain("strider");
    expect(banner).toContain("claude-sonnet-4-6");
    expect(banner).toContain("3777");
    expect(banner).toContain("0.1.0");
  });
});

describe("renderWelcomeBanner", () => {
  test("includes instance, model, port, and version metadata", () => {
    const banner = renderWelcomeBanner({
      instName: "Onyx",
      sessionId: "session-12345678",
      agentHint: "strider",
      statelessId: "nyx-cli:abcd1234",
      model: "claude-sonnet-4-6",
      port: 3777,
      host: "http://localhost:3777",
    });

    expect(banner).toContain("onyx");
    expect(banner).toContain("strider");
    expect(banner).toContain("claude-sonnet-4-6");
    expect(banner).toContain("3777");
    expect(banner).toContain("0.1.0");
  });
});

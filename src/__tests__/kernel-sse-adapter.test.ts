import { describe, expect, test } from "bun:test";
import { kernelEventToSSE } from "../kernel/sse-adapter.js";

describe("kernelEventToSSE", () => {
  test("maps token events into SSE data payloads", () => {
    const event = kernelEventToSSE({
      type: "kernel:token",
      text: "hello",
      agent: "nyx",
      timestamp: 123,
    });

    expect(event).toEqual({
      type: "token",
      data: { text: "hello", agent: "nyx" },
      timestamp: 123,
    });
  });

  test("maps response events into SSE data payloads", () => {
    const event = kernelEventToSSE({
      type: "kernel:response",
      response: "done",
      agent: "nyx",
      message_id: "msg-1",
      cost_cents: 7,
      timestamp: 456,
    });

    expect(event).toEqual({
      type: "response",
      data: { response: "done", agent: "nyx", message_id: "msg-1", cost_cents: 7 },
      timestamp: 456,
    });
  });

  test("maps error and usage events", () => {
    expect(kernelEventToSSE({ type: "kernel:error", error: "boom", timestamp: 1 })).toEqual({
      type: "error",
      data: { error: "boom" },
      timestamp: 1,
    });

    expect(kernelEventToSSE({
      type: "kernel:usage",
      model: "gpt-5.4",
      input_tokens: 10,
      output_tokens: 5,
      cost_cents: 2,
      timestamp: 2,
    })).toEqual({
      type: "usage",
      data: { model: "gpt-5.4", input_tokens: 10, output_tokens: 5, cost_cents: 2 },
      timestamp: 2,
    });
  });
});

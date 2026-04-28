import { afterEach, describe, expect, mock, test } from "bun:test";
import { NyxHiveProvider } from "./provider.js";

const originalFetch = globalThis.fetch;

function makeSseResponse() {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("data: {\"type\":\"response\",\"response\":\"ok\"}\n\n"));
      controller.close();
    },
  });

  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

describe("NyxHiveProvider", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("uses custom sender identity when provided for stateless turns", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      });
      return makeSseResponse();
    }) as unknown as typeof fetch;

    const provider = new NyxHiveProvider({
      host: "http://localhost:4000",
      apiKey: "test-key",
      instanceName: "nyx",
    });

    const events: Array<{ type: string }> = [];
    for await (const event of provider.stream("hello", {
      sender: "nyx-cli",
      senderId: "nyx-cli:stateless-123",
    })) {
      events.push({ type: event.type });
    }

    expect(events).toEqual([{ type: "response" }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://localhost:4000/api/message");
    expect(calls[0]?.body.sender).toBe("nyx-cli");
    expect(calls[0]?.body.sender_id).toBe("nyx-cli:stateless-123");
  });

  test("forwards model overrides to the server payload", async () => {
    const calls: Array<Record<string, unknown>> = [];
    globalThis.fetch = mock(async (_input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>);
      return makeSseResponse();
    }) as unknown as typeof fetch;

    const provider = new NyxHiveProvider({
      host: "http://localhost:4000",
      apiKey: "test-key",
      instanceName: "nyx",
    });

    for await (const _event of provider.stream("hello", {
      sessionId: "session-1",
      modelOverride: "claude-opus-4-6",
    })) {
      // consume stream
    }

    expect(calls).toHaveLength(1);
    expect(calls[0]?.model_override).toBe("claude-opus-4-6");
  });
});

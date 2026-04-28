import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { MiniMaxProvider } from "../providers/minimax.js";

// --- Helpers ---

function makeSuccessResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: "mm-123",
    choices: [{
      message: { role: "assistant", content: "Hello from MiniMax" },
      finish_reason: "stop",
    }],
    usage: { prompt_tokens: 30, completion_tokens: 12, total_tokens: 42 },
    model: "mimo-v2-flash",
    ...overrides,
  };
}

function okResponse(data: Record<string, unknown> = makeSuccessResponse()) {
  return {
    ok: true,
    status: 200,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(""),
  } as unknown as Response;
}

function lastBody(fetchSpy: ReturnType<typeof spyOn>): any {
  const calls = fetchSpy.mock.calls;
  const [, opts] = calls[calls.length - 1] as [string, RequestInit];
  return JSON.parse(opts.body as string);
}

describe("MiniMaxProvider", () => {
  let provider: MiniMaxProvider;
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    provider = new MiniMaxProvider("mm-test-key", ["mimo-v2-flash", "mimo-v2-large"]);
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(okResponse());
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  // --- Basic properties ---

  it("has name 'minimax'", () => {
    expect(provider.name).toBe("minimax");
  });

  describe("listModels", () => {
    it("returns configured models", () => {
      expect(provider.listModels()).toEqual(["mimo-v2-flash", "mimo-v2-large"]);
    });
  });

  // --- complete ---

  describe("complete", () => {
    it("sends POST to MiniMax API", async () => {
      await provider.complete({
        messages: [{ role: "user", content: "Hi" }],
      });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://api.minimaxi.chat/v1/text/chatcompletion_v2");
      expect(opts.method).toBe("POST");
    });

    it("sends auth header", async () => {
      await provider.complete({
        messages: [{ role: "user", content: "Hi" }],
      });

      const [, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const headers = opts.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer mm-test-key");
      expect(headers["Content-Type"]).toBe("application/json");
    });

    it("returns formatted response", async () => {
      const result = await provider.complete({
        messages: [{ role: "user", content: "Hi" }],
      });

      expect(result.content).toBe("Hello from MiniMax");
      expect(result.model).toBe("mimo-v2-flash");
      expect(result.provider).toBe("minimax");
      expect(result.tokensIn).toBe(30);
      expect(result.tokensOut).toBe(12);
      expect(result.finishReason).toBe("stop");
      expect(result.toolCalls).toBeUndefined();
    });

    it("uses first model when none specified", async () => {
      await provider.complete({
        messages: [{ role: "user", content: "Hi" }],
      });

      expect(lastBody(fetchSpy).model).toBe("mimo-v2-flash");
    });

    it("uses specified model", async () => {
      await provider.complete({
        messages: [{ role: "user", content: "Hi" }],
        model: "mimo-v2-large",
      });

      expect(lastBody(fetchSpy).model).toBe("mimo-v2-large");
    });

    it("sends default maxTokens and temperature", async () => {
      await provider.complete({
        messages: [{ role: "user", content: "Hi" }],
      });

      const body = lastBody(fetchSpy);
      expect(body.max_tokens).toBe(4096);
      expect(body.temperature).toBe(0.7);
    });

    it("sends custom maxTokens and temperature", async () => {
      await provider.complete({
        messages: [{ role: "user", content: "Hi" }],
        maxTokens: 200,
        temperature: 0.3,
      });

      const body = lastBody(fetchSpy);
      expect(body.max_tokens).toBe(200);
      expect(body.temperature).toBe(0.3);
    });

    // --- System messages ---

    it("prepends system message from explicit param", async () => {
      await provider.complete({
        messages: [{ role: "user", content: "Hi" }],
        system: "Be brief",
      });

      const body = lastBody(fetchSpy);
      expect(body.messages[0]).toEqual({ role: "system", content: "Be brief" });
      expect(body.messages[1]).toEqual({ role: "user", content: "Hi" });
    });

    it("extracts system from messages when no explicit param", async () => {
      await provider.complete({
        messages: [
          { role: "system", content: "From msgs" },
          { role: "user", content: "Hi" },
        ],
      });

      const body = lastBody(fetchSpy);
      const systemMsgs = body.messages.filter((m: any) => m.role === "system");
      expect(systemMsgs.length).toBe(1);
      expect(systemMsgs[0].content).toBe("From msgs");
    });

    it("filters system messages from non-system message list", async () => {
      await provider.complete({
        messages: [
          { role: "system", content: "System" },
          { role: "user", content: "Hi" },
        ],
      });

      const body = lastBody(fetchSpy);
      // Should have system (extracted) + user, no duplicate system
      expect(body.messages.length).toBe(2);
      expect(body.messages[0].role).toBe("system");
      expect(body.messages[1].role).toBe("user");
    });

    // --- Think block stripping ---

    it("strips <think> blocks from response", async () => {
      fetchSpy.mockResolvedValueOnce(okResponse(makeSuccessResponse({
        choices: [{
          message: { role: "assistant", content: "<think>Let me reason about this carefully...</think>The answer is 42." },
          finish_reason: "stop",
        }],
      })));

      const result = await provider.complete({
        messages: [{ role: "user", content: "What's the answer?" }],
      });

      expect(result.content).toBe("The answer is 42.");
      expect(result.content).not.toContain("<think>");
    });

    it("strips multiple think blocks", async () => {
      fetchSpy.mockResolvedValueOnce(okResponse(makeSuccessResponse({
        choices: [{
          message: {
            role: "assistant",
            content: "<think>First thought</think>Part one. <think>Second thought\nwith newlines</think>Part two.",
          },
          finish_reason: "stop",
        }],
      })));

      const result = await provider.complete({
        messages: [{ role: "user", content: "Think twice" }],
      });

      expect(result.content).toBe("Part one. Part two.");
    });

    it("handles response with no think blocks", async () => {
      const result = await provider.complete({
        messages: [{ role: "user", content: "Hi" }],
      });

      expect(result.content).toBe("Hello from MiniMax");
    });

    it("handles response that is entirely a think block", async () => {
      fetchSpy.mockResolvedValueOnce(okResponse(makeSuccessResponse({
        choices: [{
          message: { role: "assistant", content: "<think>Only thinking, no output</think>" },
          finish_reason: "stop",
        }],
      })));

      const result = await provider.complete({
        messages: [{ role: "user", content: "Think" }],
      });

      expect(result.content).toBe("");
    });

    it("strips multiline think blocks", async () => {
      fetchSpy.mockResolvedValueOnce(okResponse(makeSuccessResponse({
        choices: [{
          message: {
            role: "assistant",
            content: "<think>\nStep 1: consider\nStep 2: analyze\nStep 3: decide\n</think>\nHere's my answer.",
          },
          finish_reason: "stop",
        }],
      })));

      const result = await provider.complete({
        messages: [{ role: "user", content: "Analyze" }],
      });

      expect(result.content).toBe("Here's my answer.");
    });

    // --- File handling (text-only fallback) ---

    it("prepends file description to last user message", async () => {
      await provider.complete({
        messages: [{ role: "user", content: "Describe this" }],
        files: [
          { name: "photo.jpg", mimeType: "image/jpeg", base64: "abc", size: 1000 },
        ],
      });

      const body = lastBody(fetchSpy);
      const userMsg = body.messages.find((m: any) => m.role === "user");
      expect(userMsg.content).toContain("[1 image(s) attached: photo.jpg");
      expect(userMsg.content).toContain("this model cannot view images");
      expect(userMsg.content).toContain("Describe this");
    });

    it("lists multiple files in description", async () => {
      await provider.complete({
        messages: [{ role: "user", content: "Compare" }],
        files: [
          { name: "a.png", mimeType: "image/png", base64: "x", size: 100 },
          { name: "b.jpg", mimeType: "image/jpeg", base64: "y", size: 200 },
        ],
      });

      const body = lastBody(fetchSpy);
      const userMsg = body.messages.find((m: any) => m.role === "user");
      expect(userMsg.content).toContain("[2 image(s) attached: a.png, b.jpg");
    });

    it("does not send tools in request body", async () => {
      await provider.complete({
        messages: [{ role: "user", content: "Hi" }],
        tools: [{ name: "test", description: "test", parameters: {} }],
      });

      const body = lastBody(fetchSpy);
      expect(body.tools).toBeUndefined();
    });

    // --- Error handling ---

    it("throws on non-ok HTTP response", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve("Internal server error"),
      } as unknown as Response);

      await expect(provider.complete({
        messages: [{ role: "user", content: "Hi" }],
      })).rejects.toThrow("MiniMax API error 500");
    });

    it("throws when no choices returned", async () => {
      fetchSpy.mockResolvedValueOnce(okResponse({
        id: "mm-x",
        choices: [],
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        model: "test",
      }));

      await expect(provider.complete({
        messages: [{ role: "user", content: "Hi" }],
      })).rejects.toThrow("no choices");
    });
  });
});

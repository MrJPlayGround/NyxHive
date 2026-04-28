import { describe, it, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { OpenAIProvider } from "../providers/openai.js";

function makeSuccessResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: "chatcmpl-123",
    choices: [{
      message: { role: "assistant", content: "Hello from GPT", tool_calls: undefined },
      finish_reason: "stop",
    }],
    usage: { prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 },
    model: "gpt-5.4",
    ...overrides,
  };
}

function okResponse(data: Record<string, unknown> = makeSuccessResponse()) {
  return {
    ok: true, status: 200,
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(""),
  } as unknown as Response;
}

function lastBody(fetchSpy: ReturnType<typeof spyOn>): any {
  const calls = fetchSpy.mock.calls;
  const [, opts] = calls[calls.length - 1] as [string, RequestInit];
  return JSON.parse(opts.body as string);
}

function lastOpts(fetchSpy: ReturnType<typeof spyOn>): RequestInit {
  const calls = fetchSpy.mock.calls;
  return calls[calls.length - 1][1] as RequestInit;
}

describe("OpenAIProvider", () => {
  let provider: OpenAIProvider;
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    provider = new OpenAIProvider("sk-test-key", ["gpt-5.4", "gpt-5-mini"]);
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(okResponse());
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("has name 'openai'", () => {
    expect(provider.name).toBe("openai");
  });

  describe("listModels", () => {
    it("returns configured models", () => {
      expect(provider.listModels()).toEqual(["gpt-5.4", "gpt-5-mini"]);
    });
  });

  describe("complete", () => {
    it("sends POST to OpenAI Chat Completions API", async () => {
      await provider.complete({ messages: [{ role: "user", content: "Hi" }] });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://api.openai.com/v1/chat/completions");
      expect(opts.method).toBe("POST");
    });

    it("sends correct auth header", async () => {
      await provider.complete({ messages: [{ role: "user", content: "Hi" }] });
      const opts = lastOpts(fetchSpy);
      const headers = opts.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer sk-test-key");
    });

    it("maps system prompt to system message", async () => {
      await provider.complete({
        messages: [{ role: "user", content: "Hi" }],
        system: "You are helpful",
      });
      const body = lastBody(fetchSpy);
      expect(body.messages[0]).toEqual({ role: "system", content: "You are helpful" });
      expect(body.messages[1]).toEqual({ role: "user", content: "Hi" });
    });

    it("uses first model as default", async () => {
      await provider.complete({ messages: [{ role: "user", content: "Hi" }] });
      const body = lastBody(fetchSpy);
      expect(body.model).toBe("gpt-5.4");
    });

    it("uses specified model", async () => {
      await provider.complete({
        messages: [{ role: "user", content: "Hi" }],
        model: "gpt-5-mini",
      });
      const body = lastBody(fetchSpy);
      expect(body.model).toBe("gpt-5-mini");
    });

    it("maps tools to OpenAI function format", async () => {
      await provider.complete({
        messages: [{ role: "user", content: "Hi" }],
        tools: [{
          name: "get_weather",
          description: "Get weather info",
          parameters: { type: "object", properties: { city: { type: "string" } } },
        }],
      });
      const body = lastBody(fetchSpy);
      expect(body.tools).toEqual([{
        type: "function",
        function: {
          name: "get_weather",
          description: "Get weather info",
          parameters: { type: "object", properties: { city: { type: "string" } } },
        },
      }]);
    });

    it("parses tool calls from response", async () => {
      fetchSpy.mockResolvedValue(okResponse(makeSuccessResponse({
        choices: [{
          message: {
            role: "assistant",
            content: null,
            tool_calls: [{
              id: "call_1",
              type: "function",
              function: { name: "get_weather", arguments: '{"city":"Lisbon"}' },
            }],
          },
          finish_reason: "tool_calls",
        }],
      })));

      const result = await provider.complete({ messages: [{ role: "user", content: "Weather?" }] });
      expect(result.toolCalls).toEqual([{ name: "get_weather", arguments: { city: "Lisbon" } }]);
      expect(result.finishReason).toBe("tool_calls");
    });

    it("handles malformed tool call arguments", async () => {
      fetchSpy.mockResolvedValue(okResponse(makeSuccessResponse({
        choices: [{
          message: {
            role: "assistant",
            content: "fallback text",
            tool_calls: [{
              id: "call_1",
              type: "function",
              function: { name: "broken", arguments: "not-json{" },
            }],
          },
          finish_reason: "tool_calls",
        }],
      })));

      const result = await provider.complete({ messages: [{ role: "user", content: "Hi" }] });
      expect(result.toolCalls).toBeUndefined();
      expect(result.content).toBe("fallback text");
    });

    it("returns token counts and model", async () => {
      const result = await provider.complete({ messages: [{ role: "user", content: "Hi" }] });
      expect(result.tokensIn).toBe(50);
      expect(result.tokensOut).toBe(20);
      expect(result.model).toBe("gpt-5.4");
      expect(result.provider).toBe("openai");
    });

    it("throws on API error", async () => {
      fetchSpy.mockResolvedValue({
        ok: false, status: 429,
        text: () => Promise.resolve("Rate limited"),
      } as unknown as Response);

      await expect(
        provider.complete({ messages: [{ role: "user", content: "Hi" }] })
      ).rejects.toThrow("OpenAI API error 429");
    });

    it("throws when no choices returned", async () => {
      fetchSpy.mockResolvedValue(okResponse({ ...makeSuccessResponse(), choices: [] }));
      await expect(
        provider.complete({ messages: [{ role: "user", content: "Hi" }] })
      ).rejects.toThrow("no choices");
    });

    it("handles image file attachments", async () => {
      await provider.complete({
        messages: [{ role: "user", content: "What's this?" }],
        files: [{
          name: "photo.jpg",
          mimeType: "image/jpeg",
          base64: "abc123",
          size: 1000,
        }],
      });
      const body = lastBody(fetchSpy);
      const lastMsg = body.messages[body.messages.length - 1];
      expect(Array.isArray(lastMsg.content)).toBe(true);
      expect(lastMsg.content[1].type).toBe("image_url");
      expect(lastMsg.content[1].image_url.url).toBe("data:image/jpeg;base64,abc123");
    });

    it("handles text file attachments", async () => {
      const encoded = Buffer.from("console.log('hello')").toString("base64");
      await provider.complete({
        messages: [{ role: "user", content: "Review this" }],
        files: [{
          name: "app.ts",
          mimeType: "text/plain",
          base64: encoded,
          size: 20,
        }],
      });
      const body = lastBody(fetchSpy);
      const lastMsg = body.messages[body.messages.length - 1];
      expect(Array.isArray(lastMsg.content)).toBe(true);
      expect(lastMsg.content[1].text).toContain("console.log('hello')");
    });

    it("does not decode binary non-image files as UTF-8 garbage", async () => {
      await provider.complete({
        messages: [{ role: "user", content: "Handle this" }],
        files: [{
          name: "clip.mp3",
          mimeType: "audio/mpeg",
          base64: "AAEC",
          size: 3,
        }],
      });

      const body = lastBody(fetchSpy);
      const lastMsg = body.messages[body.messages.length - 1];
      const fileBlock = lastMsg.content.find((b: any) => b.type === "text" && b.text?.includes("[File omitted:"));
      expect(fileBlock.text).toContain("[File omitted: clip.mp3 (audio/mpeg)]");
      expect(fileBlock.text).toContain("Binary non-image attachments are not supported by the OpenAI provider in NyxHive.");
    });
  });
});

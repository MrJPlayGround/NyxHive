import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from "bun:test";
import { OpenRouterProvider } from "../providers/openrouter.js";

// --- Helpers ---

function makeSuccessResponse(overrides: Record<string, unknown> = {}) {
  return {
    id: "gen-123",
    choices: [{
      message: { role: "assistant", content: "Hello from OpenRouter", tool_calls: undefined },
      finish_reason: "stop",
    }],
    usage: { prompt_tokens: 40, completion_tokens: 15, total_tokens: 55 },
    model: "google/gemini-2.0-flash-lite-001",
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

/** Get the request body from the last fetch call */
function lastBody(fetchSpy: ReturnType<typeof spyOn>): any {
  const calls = fetchSpy.mock.calls;
  const [, opts] = calls[calls.length - 1] as [string, RequestInit];
  return JSON.parse(opts.body as string);
}

/** Get the request options from the last fetch call */
function lastOpts(fetchSpy: ReturnType<typeof spyOn>): RequestInit {
  const calls = fetchSpy.mock.calls;
  return calls[calls.length - 1][1] as RequestInit;
}

describe("OpenRouterProvider", () => {
  let provider: OpenRouterProvider;
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    provider = new OpenRouterProvider("or-test-key", ["google/gemini-2.0-flash-lite-001", "mimo-v2-flash"]);
    fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(okResponse());
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  // --- Basic properties ---

  it("has name 'openrouter'", () => {
    expect(provider.name).toBe("openrouter");
  });

  describe("listModels", () => {
    it("returns configured models", () => {
      expect(provider.listModels()).toEqual(["google/gemini-2.0-flash-lite-001", "mimo-v2-flash"]);
    });
  });

  // --- complete: request formation ---

  describe("complete", () => {
    it("sends POST to OpenRouter API", async () => {
      await provider.complete({
        messages: [{ role: "user", content: "Hi" }],
      });

      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
      expect(opts.method).toBe("POST");
    });

    it("sends correct headers", async () => {
      await provider.complete({
        messages: [{ role: "user", content: "Hi" }],
      });

      const headers = lastOpts(fetchSpy).headers as Record<string, string>;
      expect(headers["Content-Type"]).toBe("application/json");
      expect(headers.Authorization).toBe("Bearer or-test-key");
      expect(headers["X-Title"]).toBe("NyxHive");
    });

    it("uses custom app name in X-Title", async () => {
      const p = new OpenRouterProvider("key", ["model"], "MyApp");
      await p.complete({ messages: [{ role: "user", content: "Hi" }] });

      const headers = lastOpts(fetchSpy).headers as Record<string, string>;
      expect(headers["X-Title"]).toBe("MyApp");
    });

    it("returns formatted response", async () => {
      const result = await provider.complete({
        messages: [{ role: "user", content: "Hi" }],
      });

      expect(result.content).toBe("Hello from OpenRouter");
      expect(result.model).toBe("google/gemini-2.0-flash-lite-001");
      expect(result.provider).toBe("openrouter");
      expect(result.tokensIn).toBe(40);
      expect(result.tokensOut).toBe(15);
      expect(result.finishReason).toBe("stop");
      expect(result.toolCalls).toBeUndefined();
    });

    it("uses first model when none specified", async () => {
      await provider.complete({
        messages: [{ role: "user", content: "Hi" }],
      });

      expect(lastBody(fetchSpy).model).toBe("google/gemini-2.0-flash-lite-001");
    });

    it("uses specified model", async () => {
      await provider.complete({
        messages: [{ role: "user", content: "Hi" }],
        model: "mimo-v2-flash",
      });

      expect(lastBody(fetchSpy).model).toBe("mimo-v2-flash");
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
        maxTokens: 500,
        temperature: 0.1,
      });

      const body = lastBody(fetchSpy);
      expect(body.max_tokens).toBe(500);
      expect(body.temperature).toBe(0.1);
    });

    // --- System messages ---

    it("prepends system message from explicit param", async () => {
      await provider.complete({
        messages: [{ role: "user", content: "Hi" }],
        system: "Be concise",
      });

      const body = lastBody(fetchSpy);
      expect(body.messages[0]).toEqual({ role: "system", content: "Be concise" });
      expect(body.messages[1]).toEqual({ role: "user", content: "Hi" });
    });

    it("extracts system from messages when no explicit param", async () => {
      await provider.complete({
        messages: [
          { role: "system", content: "From messages" },
          { role: "user", content: "Hi" },
        ],
      });

      const body = lastBody(fetchSpy);
      const systemMsgs = body.messages.filter((m: any) => m.role === "system");
      expect(systemMsgs.length).toBe(1);
      expect(systemMsgs[0].content).toBe("From messages");
    });

    it("prefers explicit system param", async () => {
      await provider.complete({
        messages: [
          { role: "system", content: "From messages" },
          { role: "user", content: "Hi" },
        ],
        system: "Explicit",
      });

      const body = lastBody(fetchSpy);
      const systemMsgs = body.messages.filter((m: any) => m.role === "system");
      expect(systemMsgs.length).toBe(1);
      expect(systemMsgs[0].content).toBe("Explicit");
    });

    // --- Tool calls ---

    it("converts tools to OpenAI function format", async () => {
      await provider.complete({
        messages: [{ role: "user", content: "Search" }],
        tools: [{
          name: "search",
          description: "Search the web",
          parameters: { type: "object", properties: { query: { type: "string" } } },
        }],
      });

      expect(lastBody(fetchSpy).tools).toEqual([{
        type: "function",
        function: {
          name: "search",
          description: "Search the web",
          parameters: { type: "object", properties: { query: { type: "string" } } },
        },
      }]);
    });

    it("omits tools when empty", async () => {
      await provider.complete({
        messages: [{ role: "user", content: "Hi" }],
        tools: [],
      });

      expect(lastBody(fetchSpy).tools).toBeUndefined();
    });

    it("parses tool calls from response", async () => {
      fetchSpy.mockResolvedValueOnce(okResponse(makeSuccessResponse({
        choices: [{
          message: {
            role: "assistant",
            content: "Let me search",
            tool_calls: [
              { function: { name: "search", arguments: '{"query":"weather"}' } },
            ],
          },
          finish_reason: "tool_calls",
        }],
      })));

      const result = await provider.complete({
        messages: [{ role: "user", content: "Weather?" }],
      });

      expect(result.toolCalls).toEqual([{ name: "search", arguments: { query: "weather" } }]);
    });

    it("filters out malformed tool calls and keeps valid ones", async () => {
      fetchSpy.mockResolvedValueOnce(okResponse(makeSuccessResponse({
        choices: [{
          message: {
            role: "assistant",
            content: "",
            tool_calls: [
              { function: { name: "good", arguments: '{"x":1}' } },
              { function: { name: "bad", arguments: "not-json{{{" } },
            ],
          },
          finish_reason: "tool_calls",
        }],
      })));

      const result = await provider.complete({
        messages: [{ role: "user", content: "Do stuff" }],
      });

      expect(result.toolCalls).toEqual([{ name: "good", arguments: { x: 1 } }]);
    });

    it("sets toolCalls to undefined when all fail to parse", async () => {
      fetchSpy.mockResolvedValueOnce(okResponse(makeSuccessResponse({
        choices: [{
          message: {
            role: "assistant",
            content: "hmm",
            tool_calls: [
              { function: { name: "bad1", arguments: "nope" } },
              { function: { name: "bad2", arguments: "{invalid" } },
            ],
          },
          finish_reason: "tool_calls",
        }],
      })));

      const result = await provider.complete({
        messages: [{ role: "user", content: "Do stuff" }],
      });

      expect(result.toolCalls).toBeUndefined();
    });

    // --- File attachments ---

    it("injects images as data URLs", async () => {
      await provider.complete({
        messages: [{ role: "user", content: "What's this?" }],
        files: [{
          name: "photo.jpg",
          mimeType: "image/jpeg",
          base64: "aW1hZ2VkYXRh",
          size: 1024,
        }],
      });

      const body = lastBody(fetchSpy);
      const lastUserMsg = body.messages.find((m: any) => m.role === "user");
      const imageBlock = lastUserMsg.content.find((b: any) => b.type === "image_url");
      expect(imageBlock).toBeDefined();
      expect(imageBlock.image_url.url).toBe("data:image/jpeg;base64,aW1hZ2VkYXRh");
    });

    it("injects text files as decoded text blocks", async () => {
      const jsonContent = '{"hello": "world"}';
      await provider.complete({
        messages: [{ role: "user", content: "Parse this" }],
        files: [{
          name: "data.json",
          mimeType: "application/json",
          base64: Buffer.from(jsonContent).toString("base64"),
          size: jsonContent.length,
        }],
      });

      const body = lastBody(fetchSpy);
      const lastUserMsg = body.messages.find((m: any) => m.role === "user");
      const fileBlock = lastUserMsg.content.find((b: any) => b.type === "text" && b.text?.includes("[File:"));
      expect(fileBlock.text).toContain("[File: data.json]");
      expect(fileBlock.text).toContain('"hello": "world"');
    });

    it("keeps original text as first content block when files attached", async () => {
      await provider.complete({
        messages: [{ role: "user", content: "Describe this" }],
        files: [{ name: "img.png", mimeType: "image/png", base64: "cG5n", size: 50 }],
      });

      const body = lastBody(fetchSpy);
      const lastUserMsg = body.messages.find((m: any) => m.role === "user");
      expect(lastUserMsg.content[0]).toEqual({ type: "text", text: "Describe this" });
    });

    // --- Error handling ---

    it("throws on non-ok HTTP response", async () => {
      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 429,
        text: () => Promise.resolve("Rate limit exceeded"),
      } as unknown as Response);

      await expect(provider.complete({
        messages: [{ role: "user", content: "Hi" }],
      })).rejects.toThrow("OpenRouter API error 429");
    });

    it("throws when no choices returned", async () => {
      fetchSpy.mockResolvedValueOnce(okResponse({
        id: "gen-x", choices: [], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }, model: "test",
      }));

      await expect(provider.complete({
        messages: [{ role: "user", content: "Hi" }],
      })).rejects.toThrow("no choices");
    });

    it("returns empty string when content is null", async () => {
      fetchSpy.mockResolvedValueOnce(okResponse(makeSuccessResponse({
        choices: [{
          message: { role: "assistant", content: null },
          finish_reason: "stop",
        }],
      })));

      const result = await provider.complete({
        messages: [{ role: "user", content: "Hi" }],
      });

      expect(result.content).toBe("");
    });
  });
});

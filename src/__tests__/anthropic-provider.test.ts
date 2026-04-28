import { describe, it, expect, mock, beforeEach } from "bun:test";

// Mock the Anthropic SDK before importing the provider
const mockCreate = mock(() => Promise.resolve({
  content: [{ type: "text", text: "Hello from Claude" }],
  model: "claude-sonnet-4-6",
  usage: { input_tokens: 50, output_tokens: 20 },
  stop_reason: "end_turn",
}));

mock.module("@anthropic-ai/sdk", () => ({
  default: class MockAnthropic {
    messages = { create: mockCreate };
    constructor(public opts: Record<string, unknown>) {}
  },
}));

import { AnthropicProvider, normalizeAnthropicToolSchema } from "../providers/anthropic.js";

/** Get the args passed to the last mockCreate call */
function lastCallArgs(): any {
  const calls = mockCreate.mock.calls;
  return (calls as any)[calls.length - 1][0];
}

describe("AnthropicProvider", () => {
  let provider: AnthropicProvider;

  beforeEach(() => {
    mockCreate.mockClear();
    mockCreate.mockResolvedValue({
      content: [{ type: "text", text: "Hello from Claude" }],
      model: "claude-sonnet-4-6",
      usage: { input_tokens: 50, output_tokens: 20 },
      stop_reason: "end_turn",
    });
    provider = new AnthropicProvider("test-key", ["claude-sonnet-4-6", "claude-opus-4-6"]);
  });

  // --- Constructor ---

  describe("constructor", () => {
    it("creates client with API key by default", () => {
      const p = new AnthropicProvider("sk-test-123", ["claude-sonnet-4-6"]);
      const client = p.getClient() as any;
      expect(client.opts.apiKey).toBe("sk-test-123");
    });

    it("creates client with auth token when specified", () => {
      const p = new AnthropicProvider("oauth-token-xyz", ["claude-sonnet-4-6"], "authToken");
      const client = p.getClient() as any;
      expect(client.opts.authToken).toBe("oauth-token-xyz");
      expect(client.opts.apiKey).toBeNull();
      expect(client.opts.defaultHeaders?.["anthropic-beta"]).toBe("oauth-2025-04-20");
    });
  });

  // --- listModels ---

  describe("listModels", () => {
    it("returns configured models", () => {
      expect(provider.listModels()).toEqual(["claude-sonnet-4-6", "claude-opus-4-6"]);
    });
  });

  // --- name ---

  it("has name 'anthropic'", () => {
    expect(provider.name).toBe("anthropic");
  });

  // --- complete: basic ---

  describe("complete", () => {
    it("sends messages and returns formatted response", async () => {
      const result = await provider.complete({
        messages: [{ role: "user", content: "Hi" }],
      });

      expect(result.content).toBe("Hello from Claude");
      expect(result.model).toBe("claude-sonnet-4-6");
      expect(result.provider).toBe("anthropic");
      expect(result.tokensIn).toBe(50);
      expect(result.tokensOut).toBe(20);
      expect(result.finishReason).toBe("end_turn");
      expect(result.toolCalls).toBeUndefined();
    });

    it("uses first model when none specified", async () => {
      await provider.complete({
        messages: [{ role: "user", content: "Hi" }],
      });

      const callArgs = lastCallArgs();
      expect(callArgs.model).toBe("claude-sonnet-4-6");
    });

    it("uses specified model", async () => {
      await provider.complete({
        messages: [{ role: "user", content: "Hi" }],
        model: "claude-opus-4-6",
      });

      const callArgs = lastCallArgs();
      expect(callArgs.model).toBe("claude-opus-4-6");
    });

    it("uses default maxTokens of 4096", async () => {
      await provider.complete({
        messages: [{ role: "user", content: "Hi" }],
      });

      const callArgs = lastCallArgs();
      expect(callArgs.max_tokens).toBe(4096);
    });

    it("uses specified maxTokens", async () => {
      await provider.complete({
        messages: [{ role: "user", content: "Hi" }],
        maxTokens: 1000,
      });

      const callArgs = lastCallArgs();
      expect(callArgs.max_tokens).toBe(1000);
    });

    it("uses default temperature of 0.7", async () => {
      await provider.complete({
        messages: [{ role: "user", content: "Hi" }],
      });

      const callArgs = lastCallArgs();
      expect(callArgs.temperature).toBe(0.7);
    });

    it("uses specified temperature", async () => {
      await provider.complete({
        messages: [{ role: "user", content: "Hi" }],
        temperature: 0.2,
      });

      const callArgs = lastCallArgs();
      expect(callArgs.temperature).toBe(0.2);
    });

    // --- System messages ---

    it("filters system messages from message list", async () => {
      await provider.complete({
        messages: [
          { role: "system", content: "Be helpful" },
          { role: "user", content: "Hi" },
        ],
      });

      const callArgs = lastCallArgs();
      const roles = callArgs.messages.map((m: any) => m.role);
      expect(roles).not.toContain("system");
      expect(roles).toEqual(["user"]);
    });

    it("extracts system content from messages when no system param", async () => {
      await provider.complete({
        messages: [
          { role: "system", content: "Be helpful" },
          { role: "user", content: "Hi" },
        ],
      });

      const callArgs = lastCallArgs();
      expect(callArgs.system).toBe("Be helpful");
    });

    it("prefers explicit system param over system messages", async () => {
      await provider.complete({
        messages: [
          { role: "system", content: "From messages" },
          { role: "user", content: "Hi" },
        ],
        system: "Explicit system prompt",
      });

      const callArgs = lastCallArgs();
      expect(callArgs.system).toBe("Explicit system prompt");
    });

    it("omits system key when no system content", async () => {
      await provider.complete({
        messages: [{ role: "user", content: "Hi" }],
      });

      const callArgs = lastCallArgs();
      expect(callArgs.system).toBeUndefined();
    });

    // --- Effort parameter ---

    it("sends effort for supported models when not 'high'", async () => {
      await provider.complete({
        messages: [{ role: "user", content: "Hi" }],
        model: "claude-opus-4-6",
        effort: "low",
      });

      const callArgs = lastCallArgs();
      expect(callArgs.output_config).toEqual({ effort: "low" });
    });

    it("skips effort when set to 'high' (default)", async () => {
      await provider.complete({
        messages: [{ role: "user", content: "Hi" }],
        model: "claude-opus-4-6",
        effort: "high",
      });

      const callArgs = lastCallArgs();
      expect(callArgs.output_config).toBeUndefined();
    });

    it("skips effort for unsupported models", async () => {
      await provider.complete({
        messages: [{ role: "user", content: "Hi" }],
        model: "claude-haiku-4-5-20251001",
        effort: "low",
      });

      const callArgs = lastCallArgs();
      expect(callArgs.output_config).toBeUndefined();
    });

    it("supports effort 'medium' on sonnet", async () => {
      await provider.complete({
        messages: [{ role: "user", content: "Hi" }],
        model: "claude-sonnet-4-6",
        effort: "medium",
      });

      const callArgs = lastCallArgs();
      expect(callArgs.output_config).toEqual({ effort: "medium" });
    });

    // --- Tool calls ---

    it("converts tools to Anthropic format", async () => {
      await provider.complete({
        messages: [{ role: "user", content: "What's the weather?" }],
        tools: [{
          name: "get_weather",
          description: "Get weather for a city",
          parameters: { type: "object", properties: { city: { type: "string" } } },
        }],
      });

      const callArgs = lastCallArgs();
      expect(callArgs.tools).toEqual([{
        name: "get_weather",
        description: "Get weather for a city",
        input_schema: { type: "object", properties: { city: { type: "string" } } },
      }]);
    });

    it("normalizes nested tool schemas before sending them", async () => {
      await provider.complete({
        messages: [{ role: "user", content: "Use the tool" }],
        tools: [{
          name: "run_check",
          description: "Run a nested check",
          parameters: {
            type: "object",
            required: ["payload"],
            properties: {
              payload: {
                type: "object",
                title: "Payload",
                description: "Nested payload",
                required: ["path"],
                properties: {
                  path: { type: "string", title: "Path" },
                  limit: { type: "integer", nullable: true, description: "Optional limit" },
                },
              },
            },
          },
        }],
      });

      const callArgs = lastCallArgs();
      expect(callArgs.tools?.[0]?.input_schema).toEqual({
        required: ["path"],
        properties: {
          path: { type: "string" },
          limit: { anyOf: [{ type: "integer" }, { type: "null" }] },
        },
        type: "object",
      });
    });

    it("omits tools when empty array", async () => {
      await provider.complete({
        messages: [{ role: "user", content: "Hi" }],
        tools: [],
      });

      const callArgs = lastCallArgs();
      expect(callArgs.tools).toBeUndefined();
    });

    it("extracts tool calls from response", async () => {
      mockCreate.mockResolvedValueOnce({
        content: [
          { type: "text", text: "Let me check" },
          { type: "tool_use", name: "get_weather", input: { city: "Lisbon" } } as any,
        ],
        model: "claude-sonnet-4-6",
        usage: { input_tokens: 50, output_tokens: 30 },
        stop_reason: "tool_use",
      });

      const result = await provider.complete({
        messages: [{ role: "user", content: "Weather in Lisbon?" }],
      });

      expect(result.content).toBe("Let me check");
      expect(result.toolCalls).toEqual([{ name: "get_weather", arguments: { city: "Lisbon" } }]);
      expect(result.finishReason).toBe("tool_use");
    });

    it("returns undefined toolCalls when no tool_use blocks", async () => {
      const result = await provider.complete({
        messages: [{ role: "user", content: "Hi" }],
      });

      expect(result.toolCalls).toBeUndefined();
    });

    // --- File attachments ---

    it("injects image files as image content blocks", async () => {
      await provider.complete({
        messages: [{ role: "user", content: "What's in this image?" }],
        files: [{
          name: "photo.jpg",
          mimeType: "image/jpeg",
          base64: "aW1hZ2VkYXRh",
          size: 1024,
        }],
      });

      const callArgs = lastCallArgs();
      const lastMsg = callArgs.messages[0];
      expect(Array.isArray(lastMsg.content)).toBe(true);

      const imageBlock = lastMsg.content.find((b: any) => b.type === "image");
      expect(imageBlock).toBeDefined();
      expect(imageBlock.source.type).toBe("base64");
      expect(imageBlock.source.media_type).toBe("image/jpeg");
      expect(imageBlock.source.data).toBe("aW1hZ2VkYXRh");

      // Original text should be last block
      const textBlock = lastMsg.content[lastMsg.content.length - 1];
      expect(textBlock.type).toBe("text");
      expect(textBlock.text).toBe("What's in this image?");
    });

    it("injects PDF files as document content blocks", async () => {
      await provider.complete({
        messages: [{ role: "user", content: "Summarize this PDF" }],
        files: [{
          name: "report.pdf",
          mimeType: "application/pdf",
          base64: "cGRmZGF0YQ==",
          size: 2048,
        }],
      });

      const callArgs = lastCallArgs();
      const lastMsg = callArgs.messages[0];
      const docBlock = lastMsg.content.find((b: any) => b.type === "document");
      expect(docBlock).toBeDefined();
      expect(docBlock.source.media_type).toBe("application/pdf");
    });

    it("injects text files as decoded text blocks", async () => {
      const csvContent = "name,age\nAlice,30\nBob,25";
      const base64 = Buffer.from(csvContent).toString("base64");

      await provider.complete({
        messages: [{ role: "user", content: "Analyze this CSV" }],
        files: [{
          name: "data.csv",
          mimeType: "text/csv",
          base64,
          size: csvContent.length,
        }],
      });

      const callArgs = lastCallArgs();
      const lastMsg = callArgs.messages[0];
      const fileBlock = lastMsg.content.find((b: any) => b.type === "text" && b.text.startsWith("[File:"));
      expect(fileBlock).toBeDefined();
      expect(fileBlock.text).toContain("[File: data.csv]");
      expect(fileBlock.text).toContain("name,age");
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

      const callArgs = lastCallArgs();
      const lastMsg = callArgs.messages[0];
      const fileBlock = lastMsg.content.find((b: any) => b.type === "text" && b.text?.includes("[File omitted:"));
      expect(fileBlock.text).toContain("[File omitted: clip.mp3 (audio/mpeg)]");
      expect(fileBlock.text).toContain("Binary non-image attachments are not supported by the Anthropic provider in NyxHive.");
    });

    it("handles multiple files", async () => {
      await provider.complete({
        messages: [{ role: "user", content: "Compare these" }],
        files: [
          { name: "a.png", mimeType: "image/png", base64: "cG5n", size: 100 },
          { name: "b.json", mimeType: "application/json", base64: Buffer.from('{"x":1}').toString("base64"), size: 50 },
        ],
      });

      const callArgs = lastCallArgs();
      const lastMsg = callArgs.messages[0];
      // Should have: image block, text file block, original text block
      expect(lastMsg.content.length).toBe(3);
    });

    it("attaches files to last user message only", async () => {
      await provider.complete({
        messages: [
          { role: "user", content: "First message" },
          { role: "assistant", content: "Response" },
          { role: "user", content: "Look at this" },
        ],
        files: [{
          name: "img.png",
          mimeType: "image/png",
          base64: "cG5n",
          size: 100,
        }],
      });

      const callArgs = lastCallArgs();
      // First user message should be plain string
      expect(typeof callArgs.messages[0].content).toBe("string");
      // Last user message should have content blocks
      expect(Array.isArray(callArgs.messages[2].content)).toBe(true);
    });

    // --- Multiple text blocks ---

    it("joins multiple text blocks with newline", async () => {
      mockCreate.mockResolvedValueOnce({
        content: [
          { type: "text", text: "First part" },
          { type: "text", text: "Second part" },
        ],
        model: "claude-sonnet-4-6",
        usage: { input_tokens: 10, output_tokens: 10 },
        stop_reason: "end_turn",
      });

      const result = await provider.complete({
        messages: [{ role: "user", content: "Hi" }],
      });

      expect(result.content).toBe("First part\nSecond part");
    });

    // --- Error handling ---

    it("rethrows SDK errors", async () => {
      const sdkError = new Error("Rate limited") as any;
      sdkError.status = 429;
      sdkError.error = { type: "rate_limit_error", message: "Too many requests" };
      sdkError.headers = { "request-id": "req-123" };
      mockCreate.mockRejectedValueOnce(sdkError);

      await expect(provider.complete({
        messages: [{ role: "user", content: "Hi" }],
      })).rejects.toThrow("Rate limited");
    });

    it("handles deeply nested error structures", async () => {
      const sdkError = new Error("API error") as any;
      sdkError.status = 500;
      sdkError.error = {
        error: { type: "server_error", message: "Internal failure" },
      };
      mockCreate.mockRejectedValueOnce(sdkError);

      await expect(provider.complete({
        messages: [{ role: "user", content: "Hi" }],
      })).rejects.toThrow("API error");
    });
  });
});

describe("normalizeAnthropicToolSchema", () => {
  it("keeps required ahead of properties and removes nested descriptions", () => {
    expect(normalizeAnthropicToolSchema({
      type: "object",
      properties: {
        input: {
          type: "object",
          description: "Nested wrapper",
          required: ["path"],
          properties: {
            path: { type: "string", description: "Path" },
          },
        },
      },
      required: ["input"],
    })).toEqual({
      required: ["path"],
      properties: {
        path: { type: "string" },
      },
      type: "object",
    });
  });
});

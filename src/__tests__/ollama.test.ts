import { describe, it, expect, mock } from "bun:test";

describe("OllamaProvider", () => {
  it("implements the Provider interface", async () => {
    const { OllamaProvider } = await import("../providers/ollama.js");
    const provider = new OllamaProvider("http://localhost:11434", "gemma3:4b");
    expect(provider.name).toBe("ollama");
    expect(typeof provider.complete).toBe("function");
    expect(typeof provider.listModels).toBe("function");
  });

  it("formats messages and calls Ollama API", async () => {
    const { OllamaProvider } = await import("../providers/ollama.js");
    const provider = new OllamaProvider("http://localhost:11434", "gemma3:4b");

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify({
        response: "NORMAL",
        model: "gemma3:4b",
        prompt_eval_count: 50,
        eval_count: 5,
        done: true,
      })))
    ) as any;

    try {
      const result = await provider.complete({
        messages: [{ role: "user", content: "test" }],
        system: "You are a classifier.",
      });
      expect(result.content).toBe("NORMAL");
      expect(result.model).toBe("gemma3:4b");
      expect(result.provider).toBe("ollama");
      expect(result.tokensIn).toBe(50);
      expect(result.tokensOut).toBe(5);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("throws on non-200 response", async () => {
    const { OllamaProvider } = await import("../providers/ollama.js");
    const provider = new OllamaProvider("http://localhost:11434", "gemma3:4b");

    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response("model not found", { status: 404 }))
    ) as any;

    try {
      await expect(provider.complete({
        messages: [{ role: "user", content: "test" }],
      })).rejects.toThrow();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns the default model from listModels", async () => {
    const { OllamaProvider } = await import("../providers/ollama.js");
    const provider = new OllamaProvider("http://localhost:11434", "gemma3:4b");
    expect(provider.listModels()).toEqual(["gemma3:4b"]);
  });
});

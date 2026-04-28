import { describe, expect, it } from "bun:test";
import {
  FallbackProvider,
  createProvider,
  type NyxHiveProviderOpts,
  type ProviderClient,
  type ProviderOptions,
  type SSEEvent,
} from "../nyx/lib/provider.js";

const NYX_OPTS: NyxHiveProviderOpts = {
  host: "http://localhost:4000",
  apiKey: "nyx-key",
  instanceName: "local",
};

class StubStreamProvider implements ProviderClient {
  calls: Array<{ message: string; options?: ProviderOptions }> = [];

  constructor(
    public readonly modelId: string,
    private readonly events: SSEEvent[] = [],
    private readonly error?: Error,
  ) {}

  async *stream(message: string, options?: ProviderOptions): AsyncGenerator<SSEEvent> {
    this.calls.push({ message, options });
    if (this.error) throw this.error;
    for (const event of this.events) {
      yield event;
    }
  }

  cost(_inputTokens: number, _outputTokens: number): number {
    return 0;
  }
}

async function collectEvents(stream: AsyncGenerator<SSEEvent>): Promise<SSEEvent[]> {
  const events: SSEEvent[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

describe("FallbackProvider", () => {
  it("falls back to the next provider when the first one throws", async () => {
    const first = new StubStreamProvider("primary", [], new Error("primary failed"));
    const second = new StubStreamProvider("secondary", [
      { type: "token", text: "hello", agent: "secondary" },
      { type: "response", response: "hello", agent: "secondary", cost_cents: 0 },
    ]);
    const provider = new FallbackProvider([first, second]);
    const options: ProviderOptions = { agent: "nyx", sender: "tester" };

    const events = await collectEvents(provider.stream("hi", options));

    expect(events).toEqual([
      { type: "token", text: "hello", agent: "secondary" },
      { type: "response", response: "hello", agent: "secondary", cost_cents: 0 },
    ]);
    expect(first.calls).toEqual([{ message: "hi", options }]);
    expect(second.calls).toEqual([{ message: "hi", options }]);
  });

  it("rethrows the last error when all providers fail", async () => {
    const first = new StubStreamProvider("primary", [], new Error("primary failed"));
    const second = new StubStreamProvider("secondary", [], new Error("secondary failed"));
    const provider = new FallbackProvider([first, second]);

    await expect(collectEvents(provider.stream("hi"))).rejects.toThrow("secondary failed");
  });
});

describe("createProvider", () => {
  it("creates an OpenAI provider from config and env fallback", async () => {
    const created: Array<{ apiKey: string; model: string }> = [];

    class StubOpenAIProvider implements ProviderClient {
      readonly modelId = "stub-openai";

      constructor(public apiKey: string, public model = "gpt-default") {
        created.push({ apiKey, model });
      }

      async *stream(_message: string, _options?: ProviderOptions): AsyncGenerator<SSEEvent> {}

      cost(_inputTokens: number, _outputTokens: number): number {
        return 0;
      }
    }

    const provider = await createProvider(NYX_OPTS, {
      loadModelConfig: async () => ({ provider: "openai", model: "gpt-test" }),
      env: { OPENAI_API_KEY: "sk-env" },
      openAIProvider: StubOpenAIProvider,
    });

    expect(provider).toBeInstanceOf(StubOpenAIProvider);
    expect(created).toEqual([{ apiKey: "sk-env", model: "gpt-test" }]);
  });

  it("creates an Anthropic provider from config api_key", async () => {
    const created: Array<{ apiKey: string; model: string }> = [];

    class StubAnthropicProvider implements ProviderClient {
      readonly modelId = "stub-anthropic";

      constructor(public apiKey: string, public model = "claude-default") {
        created.push({ apiKey, model });
      }

      async *stream(_message: string, _options?: ProviderOptions): AsyncGenerator<SSEEvent> {}

      cost(_inputTokens: number, _outputTokens: number): number {
        return 0;
      }
    }

    const provider = await createProvider(NYX_OPTS, {
      loadModelConfig: async () => ({
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        apiKey: "anthropic-config-key",
      }),
      anthropicProvider: StubAnthropicProvider,
    });

    expect(provider).toBeInstanceOf(StubAnthropicProvider);
    expect(created).toEqual([{ apiKey: "anthropic-config-key", model: "claude-sonnet-4-6" }]);
  });

  it("defaults to NyxHive for unknown providers", async () => {
    const created: NyxHiveProviderOpts[] = [];

    class StubNyxHiveProvider implements ProviderClient {
      readonly modelId = "stub-nyxhive";

      constructor(opts: NyxHiveProviderOpts) {
        created.push(opts);
      }

      async *stream(_message: string, _options?: ProviderOptions): AsyncGenerator<SSEEvent> {}

      cost(_inputTokens: number, _outputTokens: number): number {
        return 0;
      }
    }

    const provider = await createProvider(NYX_OPTS, {
      loadModelConfig: async () => ({ provider: "custom", model: "ignored" }),
      nyxHiveProvider: StubNyxHiveProvider,
    });

    expect(provider).toBeInstanceOf(StubNyxHiveProvider);
    expect(created).toEqual([NYX_OPTS]);
  });

  it("throws when OpenAI is selected without any API key", async () => {
    await expect(
      createProvider(NYX_OPTS, {
        loadModelConfig: async () => ({ provider: "openai", model: "gpt-test" }),
        env: {},
      }),
    ).rejects.toThrow("OpenAI provider selected but no API key found");
  });
});

/**
 * Provider abstraction for nyx CLI.
 *
 * Supports:
 *   NyxHiveProvider  — routes through a running NyxHive server (default)
 *   AnthropicProvider — direct Anthropic API (no server required)
 *   OpenAIProvider   — direct OpenAI-compatible API
 *   FallbackProvider — tries providers in order, falls back on error
 *
 * Config-driven via ~/.config/nyx/config.toml [model] section.
 * Override: nyx config set model <provider:model>
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import TOML from "@iarna/toml";
import Anthropic from "@anthropic-ai/sdk";
import { streamSSE, type SSEEvent } from "./stream.js";

export type { SSEEvent };

// ─── Interface ────────────────────────────────────────────────────────────────

export interface ProviderOptions {
  /** Server-side session ID (NyxHive only). */
  sessionId?: string;
  /** Target agent name. */
  agent?: string;
  /** Per-turn model override for NyxHive routes. */
  modelOverride?: string;
  /** Execution mode (e.g. "ralph"). */
  mode?: string;
  /** Optional sender display name override (NyxHive only). */
  sender?: string;
  /** Optional sender identity override (NyxHive only). */
  senderId?: string;
  /** Abort signal to cancel the stream. */
  signal?: AbortSignal;
}

export interface ProviderClient {
  readonly modelId: string;
  /** Stream a user message, yielding SSE-compatible events. */
  stream(message: string, options?: ProviderOptions): AsyncGenerator<SSEEvent>;
  /** Estimate cost in cents for given token counts. */
  cost(inputTokens: number, outputTokens: number): number;
}

// ─── NyxHive server provider ──────────────────────────────────────────────────

export interface NyxHiveProviderOpts {
  host: string;
  apiKey: string;
  instanceName: string;
}

interface CreateProviderDeps {
  loadModelConfig?: typeof loadModelConfig;
  env?: Record<string, string | undefined>;
  openAIProvider?: new (apiKey: string, model?: string) => ProviderClient;
  anthropicProvider?: new (apiKey: string, model?: string) => ProviderClient;
  nyxHiveProvider?: new (opts: NyxHiveProviderOpts) => ProviderClient;
}

export class NyxHiveProvider implements ProviderClient {
  readonly modelId = "nyxhive";

  constructor(private opts: NyxHiveProviderOpts) {}

  async *stream(message: string, options?: ProviderOptions): AsyncGenerator<SSEEvent> {
    const { host, apiKey } = this.opts;
    const url = options?.sessionId
      ? `${host}/api/sessions/${options.sessionId}/message`
      : `${host}/api/message`;

    const payload: Record<string, unknown> = {
      message,
      stream: true,
      sender: options?.sender ?? "nyx-cli",
      sender_id: options?.senderId ?? options?.sender ?? "nyx-cli",
    };
    if (options?.agent) payload.agent = options.agent;
    if (options?.modelOverride) payload.model_override = options.modelOverride;
    if (options?.mode) payload.mode = options.mode;
    if (!options?.sessionId) payload.async = false;

    yield* streamSSE(url, apiKey, payload, options?.signal);
  }

  cost(_inputTokens: number, _outputTokens: number): number {
    return 0; // tracked server-side
  }
}

// ─── Anthropic direct provider ────────────────────────────────────────────────

export class AnthropicProvider implements ProviderClient {
  readonly modelId: string;
  private client: Anthropic;

  constructor(apiKey: string, model = "claude-sonnet-4-6") {
    this.modelId = model;
    this.client = new Anthropic({ apiKey });
  }

  async *stream(message: string, options?: ProviderOptions): AsyncGenerator<SSEEvent> {
    const agentLabel = "anthropic";
    let inputTokens = 0;
    let outputTokens = 0;
    let fullText = "";

    const sdkStream = await this.client.messages.create({
      model: this.modelId,
      max_tokens: 8192,
      messages: [{ role: "user", content: message }],
      stream: true,
    });

    for await (const event of sdkStream) {
      if (options?.signal?.aborted) break;

      if (
        event.type === "content_block_delta" &&
        event.delta.type === "text_delta"
      ) {
        const text = event.delta.text;
        fullText += text;
        yield { type: "token", text, agent: agentLabel };
      } else if (event.type === "message_start" && event.message.usage) {
        inputTokens = event.message.usage.input_tokens;
        outputTokens = event.message.usage.output_tokens;
      } else if (event.type === "message_delta" && event.usage) {
        outputTokens = event.usage.output_tokens;
      }
    }

    const costCents = this.cost(inputTokens, outputTokens);
    yield { type: "usage", input_tokens: inputTokens, output_tokens: outputTokens, model: this.modelId };
    yield { type: "response", response: fullText, agent: agentLabel, cost_cents: costCents };
  }

  cost(inputTokens: number, outputTokens: number): number {
    // claude-sonnet-4-6: ~$3/M in, $15/M out
    return (inputTokens / 1_000_000) * 300 + (outputTokens / 1_000_000) * 1500;
  }
}

// ─── OpenAI-compatible provider ───────────────────────────────────────────────

interface OpenAIChunk {
  choices?: { delta?: { content?: string } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export class OpenAIProvider implements ProviderClient {
  readonly modelId: string;

  constructor(
    private apiKey: string,
    model = "gpt-4o",
    private baseUrl = "https://api.openai.com",
  ) {
    this.modelId = model;
  }

  async *stream(message: string, options?: ProviderOptions): AsyncGenerator<SSEEvent> {
    const agentLabel = "openai";
    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.modelId,
        messages: [{ role: "user", content: message }],
        stream: true,
        stream_options: { include_usage: true },
      }),
      signal: options?.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`OpenAI HTTP ${res.status}: ${body.slice(0, 120)}`);
    }
    if (!res.body) throw new Error("No response body");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let fullText = "";
    let inputTokens = 0;
    let outputTokens = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n|\r/g, "\n");
      const parts = buffer.split("\n\n");
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        const dataLine = part.split("\n").find((l) => l.startsWith("data: "))?.slice(6);
        if (!dataLine || dataLine === "[DONE]") continue;
        try {
          const chunk = JSON.parse(dataLine) as OpenAIChunk;
          const text = chunk.choices?.[0]?.delta?.content ?? "";
          if (text) { fullText += text; yield { type: "token", text, agent: agentLabel }; }
          if (chunk.usage) {
            inputTokens = chunk.usage.prompt_tokens ?? 0;
            outputTokens = chunk.usage.completion_tokens ?? 0;
          }
        } catch { /* malformed chunk */ }
      }
    }

    const costCents = this.cost(inputTokens, outputTokens);
    yield { type: "usage", input_tokens: inputTokens, output_tokens: outputTokens, model: this.modelId };
    yield { type: "response", response: fullText, agent: agentLabel, cost_cents: costCents };
  }

  cost(inputTokens: number, outputTokens: number): number {
    // gpt-4o: ~$2.50/M in, $10/M out
    return (inputTokens / 1_000_000) * 250 + (outputTokens / 1_000_000) * 1000;
  }
}

// ─── Fallback provider ────────────────────────────────────────────────────────

export class FallbackProvider implements ProviderClient {
  get modelId() { return this.providers[0]?.modelId ?? "none"; }

  constructor(private providers: ProviderClient[]) {}

  async *stream(message: string, options?: ProviderOptions): AsyncGenerator<SSEEvent> {
    let lastErr: unknown;
    for (const p of this.providers) {
      try {
        yield* p.stream(message, options);
        return;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr ?? new Error("All providers failed");
  }

  cost(inputTokens: number, outputTokens: number): number {
    return this.providers[0]?.cost(inputTokens, outputTokens) ?? 0;
  }
}

// ─── Config-driven factory ────────────────────────────────────────────────────

const CONFIG_PATH = join(homedir(), ".config", "nyx", "config.toml");

interface NyxToml {
  model?: { provider?: string; model?: string; api_key?: string };
  [key: string]: unknown;
}

export async function loadModelConfig(): Promise<{ provider: string; model: string; apiKey?: string }> {
  try {
    if (existsSync(CONFIG_PATH)) {
      const raw = await readFile(CONFIG_PATH, "utf-8");
      const parsed = TOML.parse(raw) as unknown as NyxToml;
      if (parsed.model?.provider) {
        return {
          provider: parsed.model.provider,
          model: parsed.model.model ?? "claude-sonnet-4-6",
          apiKey: parsed.model.api_key,
        };
      }
    }
  } catch { /* fall through */ }
  return { provider: "nyxhive", model: "claude-sonnet-4-6" };
}

/** Write [model] section to ~/.config/nyx/config.toml. */
export async function saveModelConfig(provider: string, model: string): Promise<void> {
  await mkdir(dirname(CONFIG_PATH), { recursive: true });

  let existing: NyxToml = {};
  if (existsSync(CONFIG_PATH)) {
    try {
      const raw = await readFile(CONFIG_PATH, "utf-8");
      existing = TOML.parse(raw) as NyxToml;
    } catch { /* ignore */ }
  }

  existing.model = { ...(existing.model ?? {}), provider, model };
  await writeFile(CONFIG_PATH, TOML.stringify(existing as TOML.JsonMap), "utf-8");
}

/** Create the right ProviderClient from config + NyxHive instance context. */
export async function createProvider(
  opts: NyxHiveProviderOpts,
  deps: CreateProviderDeps = {},
): Promise<ProviderClient> {
  const cfg = await (deps.loadModelConfig ?? loadModelConfig)();
  const env = deps.env ?? process.env;

  if (cfg.provider === "openai") {
    const key = cfg.apiKey ?? env.OPENAI_API_KEY ?? "";
    if (!key) throw new Error("OpenAI provider selected but no API key found (set OPENAI_API_KEY or add api_key to [model] config)");
    return new (deps.openAIProvider ?? OpenAIProvider)(key, cfg.model);
  }

  if (cfg.provider === "anthropic") {
    const key = cfg.apiKey ?? env.ANTHROPIC_API_KEY ?? "";
    if (!key) throw new Error("Anthropic provider selected but no API key found (set ANTHROPIC_API_KEY or add api_key to [model] config)");
    return new (deps.anthropicProvider ?? AnthropicProvider)(key, cfg.model);
  }

  // Default: route through NyxHive server
  return new (deps.nyxHiveProvider ?? NyxHiveProvider)(opts);
}

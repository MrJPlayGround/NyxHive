/**
 * CLI-native provider abstraction.
 *
 * Lets `nyx chat` stream from NyxHive OR call LLM providers directly,
 * using the same SSEEvent shape throughout so the rendering layer is
 * identical regardless of where the response comes from.
 *
 * The fallback chain: configured provider → NyxHive (if provider unavailable)
 */

import type { SSEEvent } from "./stream.js";
import type { InstanceConfig } from "./config.js";
import { loadModelConfig } from "./provider.js";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface StreamOpts {
  system?: string;
  model?: string;
  maxTokens?: number;
  signal?: AbortSignal;
  agent?: string;
  sessionId?: string | null;
  sender?: string;
  mode?: string;
}

export interface CLIProvider {
  readonly name: string;
  /** Stream a single message, yielding SSEEvent-shaped objects. */
  stream(message: string, opts?: StreamOpts): AsyncIterable<SSEEvent>;
}

// ─── NyxHive provider (default) ──────────────────────────────────────────────

import { streamSSE } from "./stream.js";

export class NyxHiveProvider implements CLIProvider {
  readonly name = "nyxhive";

  constructor(private inst: InstanceConfig) {}

  async *stream(message: string, opts: StreamOpts = {}): AsyncIterable<SSEEvent> {
    const host = this.inst.host ?? `http://localhost:${this.inst.port}`;
    const apiKey = this.inst.apiKey ?? "";
    const url = opts.sessionId
      ? `${host}/api/sessions/${opts.sessionId}/message`
      : `${host}/api/message`;

    const payload: Record<string, unknown> = {
      message,
      stream: true,
      sender: opts.sender ?? "nyx-cli-chat",
      sender_id: opts.sender ?? "nyx-cli-chat",
    };
    if (opts.agent) payload.agent = opts.agent;
    if (opts.mode) payload.mode = opts.mode;
    if (!opts.sessionId) payload.async = false;

    yield* streamSSE(url, apiKey, payload, opts.signal);
  }
}

// ─── Anthropic direct provider ────────────────────────────────────────────────

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_DEFAULT_MODEL = "claude-sonnet-4-6";
const ANTHROPIC_MAX_TOKENS = 8096;

export class AnthropicProvider implements CLIProvider {
  readonly name = "anthropic";

  constructor(private apiKey: string) {}

  async *stream(message: string, opts: StreamOpts = {}): AsyncIterable<SSEEvent> {
    const model = opts.model ?? ANTHROPIC_DEFAULT_MODEL;
    const maxTokens = opts.maxTokens ?? ANTHROPIC_MAX_TOKENS;

    const messages: Array<{ role: string; content: string }> = [
      { role: "user", content: message },
    ];

    const body: Record<string, unknown> = {
      model,
      max_tokens: maxTokens,
      stream: true,
      messages,
    };
    if (opts.system) body.system = opts.system;

    const res = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
      signal: opts.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Anthropic API error ${res.status}: ${text.slice(0, 200)}`);
    }
    if (!res.body) throw new Error("No response body");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let fullText = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true }).replace(/\r\n|\r/g, "\n");

        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";

        for (const part of parts) {
          if (!part.trim() || part.startsWith(":")) continue;

          let eventType = "";
          let dataStr = "";
          for (const line of part.split("\n")) {
            if (line.startsWith("event: ")) eventType = line.slice(7).trim();
            if (line.startsWith("data: ")) dataStr = line.slice(6).trim();
          }

          if (eventType === "content_block_delta" && dataStr) {
            try {
              const data = JSON.parse(dataStr) as { delta?: { type?: string; text?: string } };
              const text = data.delta?.type === "text_delta" ? (data.delta.text ?? "") : "";
              if (text) {
                fullText += text;
                yield { type: "token", text, agent: `${model}` };
              }
            } catch { /* malformed delta */ }
          }

          if (eventType === "message_start" && dataStr) {
            try {
              const data = JSON.parse(dataStr) as { message?: { usage?: { input_tokens?: number } } };
              const tokensIn = data.message?.usage?.input_tokens;
              if (tokensIn !== undefined) {
                yield { type: "usage", input_tokens: tokensIn, output_tokens: 0, model };
              }
            } catch { /* malformed */ }
          }

          if (eventType === "message_delta" && dataStr) {
            try {
              const data = JSON.parse(dataStr) as { usage?: { output_tokens?: number } };
              if (data.usage?.output_tokens !== undefined) {
                yield { type: "usage", output_tokens: data.usage.output_tokens, model };
              }
            } catch { /* malformed */ }
          }

          if (eventType === "message_stop") {
            yield { type: "response", response: fullText, agent: model };
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}

// ─── Ollama provider ──────────────────────────────────────────────────────────

export class OllamaProvider implements CLIProvider {
  readonly name = "ollama";

  constructor(
    private baseUrl: string = "http://localhost:11434",
    private defaultModel: string = "llama3.2",
  ) {}

  async *stream(message: string, opts: StreamOpts = {}): AsyncIterable<SSEEvent> {
    const model = opts.model ?? this.defaultModel;
    const messages = [{ role: "user", content: message }];

    const res = await fetch(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages, stream: true }),
      signal: opts.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Ollama error ${res.status}: ${text.slice(0, 200)}`);
    }
    if (!res.body) throw new Error("No response body");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let fullText = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const data = JSON.parse(line) as {
              message?: { content?: string };
              done?: boolean;
              prompt_eval_count?: number;
              eval_count?: number;
            };
            const text = data.message?.content ?? "";
            if (text) {
              fullText += text;
              yield { type: "token", text, agent: model };
            }
            if (data.done) {
              yield {
                type: "usage",
                input_tokens: data.prompt_eval_count ?? 0,
                output_tokens: data.eval_count ?? 0,
                model,
              };
              yield { type: "response", response: fullText, agent: model };
            }
          } catch { /* malformed line */ }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Build a CLIProvider from a provider name string.
 * When providerName is undefined, reads from ~/.config/nyx/config.toml [model] section.
 * Falls back to NyxHive if provider is unknown or misconfigured.
 */
export function buildProvider(
  providerName: string | undefined,
  inst: InstanceConfig,
): CLIProvider {
  switch (providerName) {
    case "anthropic": {
      const key = process.env.ANTHROPIC_API_KEY;
      if (!key) throw new Error("ANTHROPIC_API_KEY not set — cannot use anthropic provider directly");
      return new AnthropicProvider(key);
    }
    case "ollama": {
      const url = process.env.OLLAMA_URL ?? "http://localhost:11434";
      const model = process.env.OLLAMA_MODEL ?? "llama3.2";
      return new OllamaProvider(url, model);
    }
    default:
      return new NyxHiveProvider(inst);
  }
}

/**
 * Like buildProvider but reads the provider from config when not specified.
 * Use this when you want config-driven provider selection (e.g. set via `nyx config set model`).
 */
export async function buildProviderFromConfig(
  providerName: string | undefined,
  inst: InstanceConfig,
): Promise<CLIProvider> {
  const resolved = providerName ?? (await loadModelConfig()).provider;
  return buildProvider(resolved === "nyxhive" ? undefined : resolved, inst);
}

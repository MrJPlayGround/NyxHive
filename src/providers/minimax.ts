import type {
  Provider,
  CompletionParams,
  ProviderResponse,
} from "./types.js";
import { logger } from "../utils/logger.js";

const MINIMAX_API_URL = "https://api.minimaxi.chat/v1/text/chatcompletion_v2";

interface MiniMaxMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface MiniMaxResponse {
  id: string;
  choices: Array<{
    message: { role: string; content: string };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  model: string;
}

export class MiniMaxProvider implements Provider {
  name = "minimax" as const;
  private apiKey: string;
  private models: string[];

  constructor(apiKey: string, models: string[]) {
    this.apiKey = apiKey;
    this.models = models;
  }

  listModels(): string[] {
    return this.models;
  }

  async complete(params: CompletionParams): Promise<ProviderResponse> {
    const model = params.model ?? this.models[0];
    const maxTokens = params.maxTokens ?? 4096;

    logger.info(`[minimax] Request: ${model}, ${params.messages.length} messages, max_tokens=${maxTokens}`);
    const startTime = Date.now();

    const messages: MiniMaxMessage[] = [];

    const systemContent = params.system
      ?? params.messages.find((m) => m.role === "system")?.content;

    if (systemContent) {
      messages.push({ role: "system", content: systemContent });
    }

    for (const m of params.messages) {
      if (m.role !== "system") {
        messages.push({ role: m.role, content: m.content });
      }
    }

    // MiniMax doesn't support images — prepend text description to last user message
    if (params.files?.length) {
      const lastUserIdx = messages.findLastIndex((m) => m.role === "user");
      if (lastUserIdx >= 0) {
        const fileList = params.files.map((f) => f.name).join(", ");
        messages[lastUserIdx].content = `[${params.files.length} image(s) attached: ${fileList} — this model cannot view images, describe what help is needed]\n\n${messages[lastUserIdx].content}`;
      }
    }

    const response = await fetch(MINIMAX_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: maxTokens,
        temperature: params.temperature ?? 0.7,
      }),
    });

    if (!response.ok) {
      const latency = Date.now() - startTime;
      const text = await response.text();
      logger.warn(`[minimax] Failed ${model} after ${latency}ms — HTTP ${response.status}: ${text.slice(0, 500)}`);
      throw new Error(`MiniMax API error ${response.status}: ${text}`);
    }

    const data = (await response.json()) as MiniMaxResponse;
    const choice = data.choices?.[0];
    if (!choice) {
      throw new Error(`MiniMax returned no choices: ${JSON.stringify(data)}`);
    }

    const latency = Date.now() - startTime;

    // Strip <think>...</think> blocks — M2.5 always includes chain-of-thought
    const content = choice.message.content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();

    logger.info(`[minimax] Completed ${data.model} in ${latency}ms — ${data.usage.prompt_tokens}in/${data.usage.completion_tokens}out, stop=${choice.finish_reason}`);

    return {
      content,
      model: data.model,
      provider: this.name,
      tokensIn: data.usage.prompt_tokens,
      tokensOut: data.usage.completion_tokens,
      finishReason: choice.finish_reason,
    };
  }
}

import type {
  Provider,
  CompletionParams,
  ProviderResponse,
} from "./types.js";
import { logger } from "../utils/logger.js";

interface OllamaGenerateResponse {
  response: string;
  model: string;
  prompt_eval_count?: number;
  eval_count?: number;
  done: boolean;
}

export class OllamaProvider implements Provider {
  name = "ollama" as const;
  private baseUrl: string;
  private defaultModel: string;
  private availableModels: string[];

  constructor(baseUrl: string, defaultModel: string, availableModels?: string[]) {
    this.baseUrl = baseUrl;
    this.defaultModel = defaultModel;
    this.availableModels = availableModels ?? [defaultModel];
  }

  async complete(params: CompletionParams): Promise<ProviderResponse> {
    const model = params.model || this.defaultModel;

    const system = params.system ?? params.messages.find((m) => m.role === "system")?.content;
    const userMessages = params.messages.filter((m) => m.role !== "system");
    const prompt = userMessages.map((m) => m.content).join("\n");

    const body = {
      model,
      prompt,
      system,
      stream: false,
      options: {
        temperature: params.temperature ?? 0,
        num_predict: params.maxTokens ?? 100,
      },
    };

    const startTime = Date.now();
    logger.info(`[ollama] ${model}: "${prompt.slice(0, 60)}..."`);

    const res = await fetch(`${this.baseUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Ollama ${res.status}: ${text}`);
    }

    const data = (await res.json()) as OllamaGenerateResponse;
    const latency = Date.now() - startTime;

    logger.info(`[ollama] Completed ${data.model} in ${latency}ms — ${data.prompt_eval_count ?? 0}in/${data.eval_count ?? 0}out`);

    return {
      content: data.response,
      model: data.model,
      provider: "ollama",
      tokensIn: data.prompt_eval_count ?? 0,
      tokensOut: data.eval_count ?? 0,
    };
  }

  listModels(): string[] {
    return this.availableModels;
  }
}

import type {
  Provider,
  CompletionParams,
  ProviderResponse,
  ToolCall,
} from "./types.js";
import { logger } from "../utils/logger.js";

const OPENROUTER_API_URL = "https://openrouter.ai/api/v1/chat/completions";

interface OpenRouterMessage {
  role: "system" | "user" | "assistant";
  content: string | Array<Record<string, any>>;
}

interface OpenRouterTool {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface OpenRouterResponse {
  id: string;
  choices: Array<{
    message: {
      role: string;
      content: string | null;
      tool_calls?: Array<{
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
  model: string;
}

export class OpenRouterProvider implements Provider {
  name = "openrouter" as const;
  private apiKey: string;
  private models: string[];
  private appName: string;

  constructor(apiKey: string, models: string[], appName?: string) {
    this.apiKey = apiKey;
    this.models = models;
    this.appName = appName ?? "NyxHive";
  }

  listModels(): string[] {
    return this.models;
  }

  async complete(params: CompletionParams): Promise<ProviderResponse> {
    const model = params.model ?? this.models[0];
    const maxTokens = params.maxTokens ?? 4096;

    logger.debug(`[openrouter] Request: ${model}, ${params.messages.length} messages, max_tokens=${maxTokens}`);
    const startTime = Date.now();

    const messages: OpenRouterMessage[] = [];

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

    // Inject file content blocks into the last user message
    if (params.files?.length) {
      const lastUserIdx = messages.findLastIndex((m) => m.role === "user");
      if (lastUserIdx >= 0) {
        const textContent = messages[lastUserIdx].content as string;
        const contentBlocks: Array<Record<string, any>> = [];
        contentBlocks.push({ type: "text", text: textContent });
        for (const file of params.files) {
          if (file.mimeType.startsWith("image/")) {
            contentBlocks.push({
              type: "image_url",
              image_url: { url: `data:${file.mimeType};base64,${file.base64}` },
            });
          } else {
            // Text-based files and PDFs — decode and inject as text
            const decoded = Buffer.from(file.base64, "base64").toString("utf-8");
            contentBlocks.push({
              type: "text",
              text: `[File: ${file.name}]\n${decoded}`,
            });
          }
        }
        messages[lastUserIdx].content = contentBlocks;
      }
    }

    const tools: OpenRouterTool[] | undefined = params.tools?.map((t) => ({
      type: "function" as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));

    const response = await fetch(OPENROUTER_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
        "X-Title": this.appName,
      },
      body: JSON.stringify({
        model,
        messages,
        max_tokens: maxTokens,
        temperature: params.temperature ?? 0.7,
        ...(tools?.length ? { tools } : {}),
      }),
    });

    if (!response.ok) {
      const latency = Date.now() - startTime;
      const text = await response.text();
      logger.warn(`[openrouter] Failed ${model} after ${latency}ms — HTTP ${response.status}: ${text.slice(0, 500)}`);
      throw new Error(`OpenRouter API error ${response.status}: ${text}`);
    }

    const data = (await response.json()) as OpenRouterResponse;
    const choice = data.choices?.[0];
    if (!choice) {
      throw new Error(`OpenRouter returned no choices for model ${params.model}`);
    }
    const latency = Date.now() - startTime;

    let toolCalls: ToolCall[] | undefined;
    if (choice.message.tool_calls?.length) {
      const rawCount = choice.message.tool_calls.length;
      toolCalls = choice.message.tool_calls
        .map((tc) => {
          try {
            return {
              name: tc.function.name,
              arguments: JSON.parse(tc.function.arguments),
            };
          } catch {
            logger.warn(`[openrouter] Malformed tool call arguments for ${tc.function.name}: ${tc.function.arguments.slice(0, 200)}`);
            return null;
          }
        })
        .filter((tc): tc is ToolCall => tc !== null);
      if (toolCalls.length === 0) {
        logger.warn(`[openrouter] All ${rawCount} tool call(s) failed to parse — treating as text-only response`);
        toolCalls = undefined;
      }
    }

    logger.debug(`[openrouter] Completed ${data.model} in ${latency}ms — ${data.usage.prompt_tokens}in/${data.usage.completion_tokens}out, stop=${choice.finish_reason}`);

    return {
      content: choice.message.content ?? "",
      model: data.model,
      provider: this.name,
      tokensIn: data.usage.prompt_tokens,
      tokensOut: data.usage.completion_tokens,
      toolCalls,
      finishReason: choice.finish_reason,
    };
  }
}

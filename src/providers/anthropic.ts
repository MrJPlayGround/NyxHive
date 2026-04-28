import Anthropic from "@anthropic-ai/sdk";
import type {
  Provider,
  CompletionParams,
  ProviderResponse,
  EffortLevel,
} from "./types.js";
import { isTextAttachmentMimeType } from "./types.js";
import { logger } from "../utils/logger.js";

// Models that support the effort parameter (output_config.effort)
const EFFORT_SUPPORTED_MODELS = new Set(["claude-opus-4-6", "claude-sonnet-4-6", "claude-opus-4-5"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function canFlattenSchemaWrapper(schema: Record<string, unknown>): boolean {
  if (schema.type !== "object") return false;
  if (!isPlainObject(schema.properties)) return false;

  const propertyEntries = Object.entries(schema.properties);
  if (propertyEntries.length !== 1) return false;

  const [key, child] = propertyEntries[0];
  if (!Array.isArray(schema.required) || schema.required.length !== 1 || schema.required[0] !== key) {
    return false;
  }

  const allowedKeys = new Set(["type", "properties", "required", "additionalProperties", "title", "description"]);
  if (Object.keys(schema).some((entry) => !allowedKeys.has(entry))) {
    return false;
  }

  return isPlainObject(child) && child.type === "object";
}

export function normalizeAnthropicToolSchema(schema: unknown, depth = 0): unknown {
  if (Array.isArray(schema)) {
    return schema.map((entry) => normalizeAnthropicToolSchema(entry, depth + 1));
  }

  if (!isPlainObject(schema)) {
    return schema;
  }

  const rawEntries = Object.entries(schema);
  const nullable = schema.nullable === true;
  const entries: Array<[string, unknown]> = [];

  if (schema.required !== undefined) {
    entries.push(["required", normalizeAnthropicToolSchema(schema.required, depth + 1)]);
  }
  if (schema.properties !== undefined) {
    entries.push(["properties", normalizeAnthropicToolSchema(schema.properties, depth + 1)]);
  }

  for (const [key, value] of rawEntries) {
    if (key === "required" || key === "properties" || key === "nullable") continue;
    if (depth > 0 && (key === "title" || key === "description")) continue;
    entries.push([key, normalizeAnthropicToolSchema(value, depth + 1)]);
  }

  let normalized = Object.fromEntries(entries);
  if (canFlattenSchemaWrapper(normalized)) {
    const child = (normalized.properties as Record<string, unknown>)[String((normalized.required as unknown[])[0])];
    normalized = isPlainObject(child) ? child : normalized;
  }

  if (!nullable) {
    return normalized;
  }

  const anyOf = Array.isArray(normalized.anyOf) ? [...normalized.anyOf] : [normalized];
  if (!anyOf.some((entry) => isPlainObject(entry) && entry.type === "null")) {
    anyOf.push({ type: "null" });
  }
  return { anyOf };
}

export class AnthropicProvider implements Provider {
  name = "anthropic" as const;
  private client: Anthropic;
  private models: string[];

  constructor(apiKeyOrToken: string, models: string[], authMethod: "apiKey" | "authToken" = "apiKey") {
    if (authMethod === "authToken") {
      this.client = new Anthropic({
        authToken: apiKeyOrToken,
        apiKey: null,
        defaultHeaders: {
          "anthropic-beta": "oauth-2025-04-20",
        },
      });
    } else {
      this.client = new Anthropic({ apiKey: apiKeyOrToken });
    }
    this.models = models;
  }

  getClient(): Anthropic {
    return this.client;
  }

  listModels(): string[] {
    return this.models;
  }

  async complete(params: CompletionParams): Promise<ProviderResponse> {
    const model = params.model ?? this.models[0];
    const maxTokens = params.maxTokens ?? 4096;

    // Resolve effort: only send to models that support it, skip "high" (it's the default)
    const effort: EffortLevel | undefined =
      params.effort && EFFORT_SUPPORTED_MODELS.has(model) && params.effort !== "high"
        ? params.effort
        : undefined;

    logger.info(`[anthropic] Request: ${model}, ${params.messages.length} messages, max_tokens=${maxTokens}${effort ? `, effort=${effort}` : ""}`);
    const startTime = Date.now();

    const messages = params.messages
      .filter((m) => m.role !== "system")
      .map((m) => ({ role: m.role as "user" | "assistant", content: m.content as string | Anthropic.ContentBlockParam[] }));

    // Inject file content blocks into the last user message
    if (params.files?.length) {
      const lastUserIdx = messages.findLastIndex((m) => m.role === "user");
      if (lastUserIdx >= 0) {
        const textContent = messages[lastUserIdx].content as string;
        const contentBlocks: Anthropic.ContentBlockParam[] = [];
        for (const file of params.files) {
          if (file.mimeType.startsWith("image/")) {
            contentBlocks.push({
              type: "image",
              source: { type: "base64", media_type: file.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp", data: file.base64 },
            });
          } else if (file.mimeType === "application/pdf") {
            contentBlocks.push({
              type: "document",
              source: { type: "base64", media_type: "application/pdf", data: file.base64 },
            } as Anthropic.ContentBlockParam);
          } else if (isTextAttachmentMimeType(file.mimeType)) {
            const decoded = Buffer.from(file.base64, "base64").toString("utf-8");
            contentBlocks.push({
              type: "text",
              text: `[File: ${file.name}]\n${decoded}`,
            });
          } else {
            contentBlocks.push({
              type: "text",
              text: `[File omitted: ${file.name} (${file.mimeType})]\nBinary non-image attachments are not supported by the Anthropic provider in NyxHive.`,
            });
          }
        }
        contentBlocks.push({ type: "text", text: textContent });
        messages[lastUserIdx].content = contentBlocks;
      }
    }

    const systemPrompt = params.system
      ?? params.messages.find((m) => m.role === "system")?.content;

    let response: Anthropic.Message;
    try {
      const createParams: Anthropic.MessageCreateParamsNonStreaming = {
        model,
        max_tokens: maxTokens,
        temperature: params.temperature ?? 0.7,
        ...(systemPrompt ? { system: systemPrompt } : {}),
        messages,
        ...(params.tools?.length
          ? {
              tools: params.tools.map((t) => ({
                name: t.name,
                description: t.description,
                input_schema: normalizeAnthropicToolSchema(t.parameters) as Anthropic.Tool.InputSchema,
              })),
            }
          : {}),
      };
      // output_config.effort — SDK v0.39.0 doesn't type this yet, but the API accepts it
      if (effort) {
        (createParams as unknown as Record<string, unknown>).output_config = { effort };
      }
      response = await this.client.messages.create(createParams);
    } catch (err: unknown) {
      const latency = Date.now() - startTime;
      const e = err as Record<string, unknown>;
      const nested = e?.error as Record<string, unknown> | undefined;
      const deepNested = nested?.error as Record<string, unknown> | undefined;
      const status = e?.status ?? nested?.status ?? "unknown";
      const errType = deepNested?.type ?? e?.type ?? "unknown";
      const errMsg = deepNested?.message ?? (err instanceof Error ? err.message : String(err));
      const headers = e?.headers as Record<string, string> | undefined;
      const requestId = headers?.["request-id"] ?? "n/a";
      logger.warn(`[anthropic] Failed ${model} after ${latency}ms — HTTP ${status}, type=${errType}, request_id=${requestId}: ${errMsg}`);
      throw err;
    }

    const latency = Date.now() - startTime;
    const textBlocks = response.content.filter((b) => b.type === "text");
    const toolBlocks = response.content.filter((b) => b.type === "tool_use");
    const content = textBlocks.map((b) => b.text).join("\n");
    const toolCalls = toolBlocks.map((b) => ({
      name: b.name,
      arguments: b.input as Record<string, unknown>,
    }));

    logger.info(`[anthropic] Completed ${model} in ${latency}ms — ${response.usage.input_tokens}in/${response.usage.output_tokens}out, stop=${response.stop_reason}`);

    return {
      content,
      model: response.model,
      provider: this.name,
      tokensIn: response.usage.input_tokens,
      tokensOut: response.usage.output_tokens,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      finishReason: response.stop_reason ?? undefined,
    };
  }
}

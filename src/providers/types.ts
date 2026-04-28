export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface FileAttachment {
  name: string;
  mimeType: string;
  base64: string;
  size: number;
}

export const SUPPORTED_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
]);

export const SUPPORTED_AUDIO_TYPES = new Set([
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/m4a",
  "audio/aac",
  "audio/wav",
  "audio/x-wav",
  "audio/ogg",
  "audio/opus",
  "audio/webm",
]);

export const SUPPORTED_DOCUMENT_TYPES = new Set([
  "application/pdf",
  "text/csv",
  "text/plain",
  "text/markdown",
  "text/html",
  "application/json",
]);

export const SUPPORTED_FILE_TYPES = new Set([
  ...SUPPORTED_IMAGE_TYPES,
  ...SUPPORTED_AUDIO_TYPES,
  ...SUPPORTED_DOCUMENT_TYPES,
]);

const SUPPORTED_FILE_EXTENSIONS = new Map<string, string>([
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["png", "image/png"],
  ["gif", "image/gif"],
  ["webp", "image/webp"],
  ["pdf", "application/pdf"],
  ["csv", "text/csv"],
  ["txt", "text/plain"],
  ["md", "text/markdown"],
  ["markdown", "text/markdown"],
  ["html", "text/html"],
  ["htm", "text/html"],
  ["json", "application/json"],
  ["mp3", "audio/mpeg"],
  ["m4a", "audio/mp4"],
  ["aac", "audio/aac"],
  ["wav", "audio/wav"],
  ["ogg", "audio/ogg"],
  ["opus", "audio/opus"],
  ["webm", "audio/webm"],
]);

export function inferSupportedFileType(mimeType?: string | null, fileName?: string | null): string | null {
  const normalizedMime = mimeType?.split(";")[0]?.trim().toLowerCase();
  if (normalizedMime && SUPPORTED_FILE_TYPES.has(normalizedMime)) {
    return normalizedMime;
  }

  const normalizedName = fileName?.trim().toLowerCase();
  if (!normalizedName || !normalizedName.includes(".")) {
    return null;
  }

  const ext = normalizedName.split(".").pop();
  if (!ext) return null;
  return SUPPORTED_FILE_EXTENSIONS.get(ext) ?? null;
}

export function isSupportedFileType(mimeType: string, fileName?: string): boolean {
  return inferSupportedFileType(mimeType, fileName) !== null;
}

export function isTextAttachmentMimeType(mimeType: string): boolean {
  const normalizedMime = mimeType.split(";")[0]?.trim().toLowerCase();
  return normalizedMime !== "application/pdf" && SUPPORTED_DOCUMENT_TYPES.has(normalizedMime);
}

const TRANSCRIBABLE_MIME_TYPES = new Set([
  ...SUPPORTED_AUDIO_TYPES,
  "application/ogg",
  "video/mp4",
  "video/mpeg",
  "video/quicktime",
  "video/webm",
]);

export function isTranscribableMimeType(mimeType: string): boolean {
  const normalizedMime = mimeType.split(";")[0]?.trim().toLowerCase();
  return TRANSCRIBABLE_MIME_TYPES.has(normalizedMime);
}

export const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
export const MAX_FILES_PER_MESSAGE = 5;

// Backward compat aliases
export const MAX_IMAGE_SIZE = MAX_FILE_SIZE;
export const MAX_IMAGES_PER_MESSAGE = MAX_FILES_PER_MESSAGE;

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ProviderResponse {
  content: string;
  model: string;
  provider: string;
  tokensIn: number;
  tokensOut: number;
  toolCalls?: ToolCall[];
  finishReason?: string;
}

export type EffortLevel = "low" | "medium" | "high" | "max";

export interface CompletionParams {
  messages: Message[];
  model?: string;
  maxTokens?: number;
  temperature?: number;
  tools?: ToolDefinition[];
  system?: string;
  files?: FileAttachment[];
  effort?: EffortLevel;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface Provider {
  name: string;
  complete(params: CompletionParams): Promise<ProviderResponse>;
  listModels(): string[];
}

export type ProviderName = "anthropic" | "openrouter" | "openai" | "ollama";

export type TaskType =
  | "trivial"
  | "classification"
  | "simple_qa"
  | "conversation"
  | "analysis"
  | "coding"
  | "code_review"
  | "expert"
  | "research"
  | "summarization"
  | "long_context"
  | "worker_subtask"
  | "orchestrator";

export interface ClassificationResult {
  taskType: TaskType;
  tier: number;
  /** Latency of the classifier call in ms (set when LLM classifier is used) */
  classifierLatencyMs?: number;
  /** Model used for classification (set when LLM classifier is used) */
  classifierModel?: string;
}

export interface RouteDecision {
  provider: ProviderName;
  model: string;
  taskType: TaskType;
  maxTokens: number;
  fallback?: { provider: ProviderName; model: string };
}

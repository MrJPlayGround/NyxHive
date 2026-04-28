import type { BlockedPathReport } from "../types.js";
import { formatError } from "../utils/error.js";
import { logger } from "../utils/logger.js";
import type { FileAttachment } from "./types.js";
import { isTextAttachmentMimeType } from "./types.js";

type BlockedPathRecorder = {
  recordBlockedPath(input: Omit<BlockedPathReport, "id" | "created_at">): BlockedPathReport;
};

export interface ProviderFileBlockerContext {
  runtime: "sdk" | "native_api";
  provider: string;
  model?: string | null;
  files?: FileAttachment[];
  runs?: BlockedPathRecorder;
  runId?: string | null;
  messageId?: string | null;
  traceId?: string | null;
  channel?: string | null;
}

export interface ProviderFileOmission {
  missingPrimitive: string;
  trigger: string;
  inspected: string[];
  impact: string;
}

export function recordProviderFileBlockers(ctx: ProviderFileBlockerContext): BlockedPathReport[] {
  if (!ctx.runs || !ctx.files?.length) return [];

  const reports: BlockedPathReport[] = [];
  for (const file of ctx.files) {
    const omission = classifyProviderFileOmission(ctx.runtime, ctx.provider, file);
    if (!omission) continue;

    try {
      reports.push(ctx.runs.recordBlockedPath({
        run_id: ctx.runId ?? null,
        message_id: ctx.messageId ?? null,
        trace_id: ctx.traceId ?? null,
        channel: ctx.channel ?? null,
        area: "provider",
        failed_path: `${ctx.runtime}.${ctx.provider}.${ctx.model ?? "unknown"}.files[${file.name}]`,
        trigger: omission.trigger,
        inspected: omission.inspected,
        available_artifacts: [
          `file.name:${file.name}`,
          `file.mime:${file.mimeType}`,
          `file.size:${file.size}`,
        ],
        missing_primitive: omission.missingPrimitive,
        impact: omission.impact,
        next_action: "fix",
        requires_approval: false,
      }));
    } catch (error) {
      logger.warn(`[providers] Failed to record provider file blocked path: ${formatError(error)}`);
    }
  }

  return reports;
}

export function classifyProviderFileOmission(
  runtime: ProviderFileBlockerContext["runtime"],
  provider: string,
  file: FileAttachment,
): ProviderFileOmission | null {
  if (runtime === "native_api") {
    return {
      missingPrimitive: "provider.file.native_api_attachment_transport",
      trigger: `Native API invocation received ${file.name} (${file.mimeType}) but does not include attachment content in the OpenAI-compatible request body.`,
      inspected: [
        "agents.invokeNativeAPI.opts.files",
        "agents.invokeNativeAPI.messages",
        "agents.invokeNativeAPI.callAPIStream.body",
      ],
      impact: "The file was accepted by NyxHive but not available to the model during provider execution.",
    };
  }

  const normalizedProvider = provider.toLowerCase();
  if (normalizedProvider === "minimax") {
    return {
      missingPrimitive: "provider.file.multimodal_input",
      trigger: `MiniMax SDK path received ${file.name} (${file.mimeType}) but only sends a text note because the provider path is text-only.`,
      inspected: [
        "providers.minimax.complete.params.files",
        "providers.minimax.messages",
      ],
      impact: "The model can see that a file existed but cannot inspect the file bytes or media content.",
    };
  }

  if (normalizedProvider === "anthropic") {
    if (file.mimeType.startsWith("image/") || file.mimeType === "application/pdf" || isTextAttachmentMimeType(file.mimeType)) {
      return null;
    }
    return binaryOmission(file, "Anthropic", "provider.file.audio_content_block", [
      "providers.anthropic.complete.params.files",
      "providers.anthropic.contentBlocks",
      "providers.types.isTextAttachmentMimeType",
    ]);
  }

  if (normalizedProvider === "openai") {
    if (file.mimeType.startsWith("image/") || isTextAttachmentMimeType(file.mimeType)) {
      return null;
    }
    return binaryOmission(file, "OpenAI", inferBinaryMissingPrimitive(file), [
      "providers.openai.complete.params.files",
      "providers.openai.contentBlocks",
      "providers.types.isTextAttachmentMimeType",
    ]);
  }

  if (normalizedProvider === "openrouter") {
    if (file.mimeType.startsWith("image/") || isTextAttachmentMimeType(file.mimeType)) {
      return null;
    }
    return {
      missingPrimitive: inferBinaryMissingPrimitive(file),
      trigger: `OpenRouter SDK path received ${file.name} (${file.mimeType}) but NyxHive cannot preserve this binary file class in chat-completions content blocks.`,
      inspected: [
        "providers.openrouter.complete.params.files",
        "providers.openrouter.contentBlocks",
        "providers.types.isTextAttachmentMimeType",
      ],
      impact: "The provider request cannot faithfully deliver the original binary file to the model.",
    };
  }

  return null;
}

function binaryOmission(
  file: FileAttachment,
  providerLabel: string,
  missingPrimitive: string,
  inspected: string[],
): ProviderFileOmission {
  return {
    missingPrimitive,
    trigger: `${providerLabel} SDK path omits ${file.name} (${file.mimeType}) and sends only an unsupported-file text marker.`,
    inspected,
    impact: "The model is told that a file was omitted, but the file content itself is not available to the model.",
  };
}

function inferBinaryMissingPrimitive(file: FileAttachment): string {
  if (file.mimeType.startsWith("audio/")) return "provider.file.audio_content_block";
  if (file.mimeType === "application/pdf") return "provider.file.pdf_content_block";
  return "provider.file.binary_content_block";
}

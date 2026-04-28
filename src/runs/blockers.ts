import { randomUUID } from "node:crypto";
import type { BlockedPathArea, BlockedPathNextAction, BlockedPathReport } from "../types.js";
import { formatError } from "../utils/error.js";

export type BlockedPathInput = Omit<BlockedPathReport, "id" | "created_at"> & {
  id?: string;
  created_at?: number;
};

export function normalizeBlockedPathReport(input: BlockedPathInput): BlockedPathReport {
  return {
    id: input.id?.trim() || randomUUID(),
    run_id: input.run_id ?? null,
    message_id: input.message_id ?? null,
    trace_id: input.trace_id ?? null,
    channel: input.channel ?? null,
    area: input.area,
    failed_path: input.failed_path.trim(),
    trigger: input.trigger.trim(),
    inspected: unique(input.inspected),
    available_artifacts: unique(input.available_artifacts),
    missing_primitive: input.missing_primitive.trim(),
    impact: input.impact.trim(),
    next_action: input.next_action,
    requires_approval: input.requires_approval,
    created_at: input.created_at ?? Date.now(),
  };
}

export function buildAttachmentBlockedPathReport(input: {
  error: unknown;
  channel: string;
  failed_path: string;
}): BlockedPathInput {
  const trigger = formatError(input.error);
  return {
    run_id: null,
    message_id: null,
    trace_id: null,
    channel: input.channel,
    area: "attachment",
    failed_path: input.failed_path,
    trigger,
    inspected: [
      "request.images",
      "request.files",
      "security.normalizeInboundAttachments",
      "providers.inferSupportedFileType",
    ],
    available_artifacts: [],
    missing_primitive: inferAttachmentMissingPrimitive(trigger),
    impact: "Attachment request rejected before enqueue; no model run was started.",
    next_action: "fix",
    requires_approval: false,
  };
}

function inferAttachmentMissingPrimitive(trigger: string): string {
  const normalized = trigger.toLowerCase();
  if (normalized.includes("unsupported") && normalized.includes("mime")) {
    return "attachment.mime.supported_handler";
  }
  if (normalized.includes("path separators") || normalized.includes("control characters") || normalized.includes("name")) {
    return "attachment.name.safe_name";
  }
  if (normalized.includes("raw base64") || normalized.includes("valid base64")) {
    return "attachment.data.valid_base64";
  }
  if (normalized.includes("empty")) {
    return "attachment.data.non_empty";
  }
  if (normalized.includes("10mb") || normalized.includes("too large") || normalized.includes("exceeds")) {
    return "attachment.limit.size";
  }
  if (normalized.includes("maximum") && normalized.includes("file attachments")) {
    return "attachment.limit.file_count";
  }
  return "attachment.validation";
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

export type { BlockedPathArea, BlockedPathNextAction, BlockedPathReport };

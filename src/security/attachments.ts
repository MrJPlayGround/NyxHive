import {
  inferSupportedFileType,
  MAX_FILES_PER_MESSAGE,
  MAX_FILE_SIZE,
  type FileAttachment,
} from "../providers/types.js";

export interface InboundAttachment {
  name?: string;
  type: string;
  data: string;
}

export interface NormalizedInboundAttachments {
  images?: Array<{ type: string; data: string }>;
  files?: InboundAttachment[];
}

export const MAX_BASE64_ATTACHMENT_CHARS = Math.ceil(MAX_FILE_SIZE / 3) * 4 + 4;

function sanitizeAttachmentName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed === "." || trimmed === "..") {
    throw new Error("Attachment name is required");
  }
  if (trimmed.length > 255) {
    throw new Error("Attachment name exceeds 255 characters");
  }
  if (/[/\\:]|(^|[.])\.(?:[/\\]|$)/.test(trimmed) || /[\x00-\x1f\x7f]/.test(trimmed)) {
    throw new Error("Attachment name must not include path separators or control characters");
  }
  return trimmed;
}

function decodedBase64Size(data: string): number {
  const normalized = data.trim();
  if (normalized.startsWith("data:")) {
    throw new Error("Attachment data must be raw base64, not a data URL");
  }
  if (!normalized || normalized.length > MAX_BASE64_ATTACHMENT_CHARS) {
    throw new Error("Attachment data exceeds 10MB limit");
  }
  if (normalized.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    throw new Error("Attachment data must be valid base64");
  }
  const padding = normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0;
  const size = (normalized.length / 4) * 3 - padding;
  if (size <= 0) {
    throw new Error("Attachment data is empty");
  }
  if (size > MAX_FILE_SIZE) {
    throw new Error("Attachment data exceeds 10MB limit");
  }
  return size;
}

export function normalizeInboundAttachments(input: NormalizedInboundAttachments): FileAttachment[] {
  const imageAttachments = input.images ?? [];
  const fileAttachments = input.files ?? [];
  const total = imageAttachments.length + fileAttachments.length;
  if (total > MAX_FILES_PER_MESSAGE) {
    throw new Error(`Maximum ${MAX_FILES_PER_MESSAGE} file attachments allowed`);
  }
  if (total === 0) return [];

  const normalized: FileAttachment[] = [];
  for (const image of imageAttachments) {
    const mimeType = inferSupportedFileType(image.type, `image.${image.type.split("/")[1] ?? "bin"}`);
    if (!mimeType || !mimeType.startsWith("image/")) {
      throw new Error(`Unsupported image MIME type: ${image.type}`);
    }
    normalized.push({
      name: `image.${mimeType.split("/")[1] ?? "bin"}`,
      mimeType,
      base64: image.data.trim(),
      size: decodedBase64Size(image.data),
    });
  }

  for (const file of fileAttachments) {
    const name = sanitizeAttachmentName(file.name ?? "");
    const mimeType = inferSupportedFileType(file.type, name);
    if (!mimeType) {
      throw new Error(`Unsupported attachment MIME type: ${file.type || "unknown"}`);
    }
    normalized.push({
      name,
      mimeType,
      base64: file.data.trim(),
      size: decodedBase64Size(file.data),
    });
  }

  return normalized;
}

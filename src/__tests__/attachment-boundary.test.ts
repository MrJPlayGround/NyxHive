import { describe, expect, test } from "bun:test";
import { MAX_FILE_SIZE } from "../providers/types.js";
import { normalizeInboundAttachments } from "../security/attachments.js";

const helloBase64 = Buffer.from("hello").toString("base64");

describe("attachment security boundary", () => {
  test("normalizes supported file attachments", () => {
    const [file] = normalizeInboundAttachments({
      files: [{ name: "notes.md", type: "text/markdown", data: helloBase64 }],
    });

    expect(file).toMatchObject({
      name: "notes.md",
      mimeType: "text/markdown",
      base64: helloBase64,
      size: 5,
    });
  });

  test("rejects unsupported MIME types", () => {
    expect(() => normalizeInboundAttachments({
      files: [{ name: "run.sh", type: "application/x-sh", data: helloBase64 }],
    })).toThrow("Unsupported attachment MIME type");
  });

  test("rejects path-like attachment names", () => {
    expect(() => normalizeInboundAttachments({
      files: [{ name: "../secret.txt", type: "text/plain", data: helloBase64 }],
    })).toThrow("path separators");
  });

  test("rejects data URLs instead of raw base64", () => {
    expect(() => normalizeInboundAttachments({
      images: [{ type: "image/png", data: `data:image/png;base64,${helloBase64}` }],
    })).toThrow("raw base64");
  });

  test("rejects decoded payloads over the size limit", () => {
    const tooLarge = Buffer.alloc(MAX_FILE_SIZE + 1, 1).toString("base64");
    expect(() => normalizeInboundAttachments({
      files: [{ name: "large.txt", type: "text/plain", data: tooLarge }],
    })).toThrow("10MB");
  });
});

import { describe, expect, it } from "bun:test";
import { inferSupportedFileType, isSupportedFileType } from "../providers/types.js";

describe("provider file type support", () => {
  it("accepts supported audio MIME types", () => {
    expect(inferSupportedFileType("audio/ogg", "voice.ogg")).toBe("audio/ogg");
    expect(isSupportedFileType("audio/mpeg", "clip.mp3")).toBe(true);
  });

  it("falls back to file extension when MIME type is generic or missing", () => {
    expect(inferSupportedFileType("application/octet-stream", "notes.md")).toBe("text/markdown");
    expect(inferSupportedFileType(undefined, "recording.m4a")).toBe("audio/mp4");
  });

  it("rejects unsupported file types", () => {
    expect(inferSupportedFileType("video/mp4", "demo.mp4")).toBeNull();
    expect(isSupportedFileType("application/zip", "archive.zip")).toBe(false);
  });
});

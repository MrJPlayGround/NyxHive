import { describe, expect, it } from "bun:test";
import { isSupportedFileType, isTranscribableMimeType } from "../providers/types.js";

describe("provider file type helpers", () => {
  it("accepts supported audio uploads and still rejects unsupported media containers", () => {
    expect(isSupportedFileType("audio/mpeg")).toBe(true);
    expect(isSupportedFileType("video/mp4")).toBe(false);
    expect(isSupportedFileType("application/ogg")).toBe(false);
  });

  it("still recognizes media mime types as transcribable for internal preprocessing", () => {
    expect(isTranscribableMimeType("audio/mpeg")).toBe(true);
    expect(isTranscribableMimeType("video/mp4")).toBe(true);
    expect(isTranscribableMimeType("application/ogg")).toBe(true);
  });
});

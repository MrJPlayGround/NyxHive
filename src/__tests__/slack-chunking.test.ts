import { describe, it, expect } from "bun:test";
import { chunkMessage } from "../channels/slack/chunking.js";

describe("chunkMessage", () => {
  it("returns single chunk for short messages", () => {
    expect(chunkMessage("Hello", 3000)).toEqual(["Hello"]);
  });
  it("splits on paragraph boundaries first", () => {
    const text = "Para 1\n\nPara 2\n\nPara 3";
    const chunks = chunkMessage(text, 15);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0]).not.toContain("Para 2");
  });
  it("hard-splits at limit if no break found", () => {
    const text = "A".repeat(100);
    const chunks = chunkMessage(text, 30);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(30);
  });
  it("splits on newline if no paragraph break fits", () => {
    const text = "Line 1\nLine 2\nLine 3\nLine 4";
    const chunks = chunkMessage(text, 14);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });
});

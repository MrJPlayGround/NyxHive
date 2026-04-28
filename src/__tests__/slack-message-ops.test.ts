import { describe, it, expect } from "bun:test";
import { validateEditParams, validateDeleteParams } from "../channels/slack/message-ops.js";

describe("message-ops validation", () => {
  it("validates edit params", () => {
    expect(validateEditParams("C123", "1234567890.123456", "new text")).toEqual({ ok: true });
    expect(validateEditParams("", "1234567890.123456", "new text").ok).toBe(false);
    expect(validateEditParams("C123", "", "new text").ok).toBe(false);
    expect(validateEditParams("C123", "1234567890.123456", "").ok).toBe(false);
  });
  it("validates delete params", () => {
    expect(validateDeleteParams("C123", "1234567890.123456")).toEqual({ ok: true });
    expect(validateDeleteParams("", "1234567890.123456").ok).toBe(false);
  });
});

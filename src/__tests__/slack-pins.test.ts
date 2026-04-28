import { describe, it, expect } from "bun:test";
import { validatePinParams } from "../channels/slack/pins.js";

describe("validatePinParams", () => {
  it("accepts valid params", () => { expect(validatePinParams("C123", "123")).toEqual({ ok: true }); });
  it("rejects empty channel", () => { expect(validatePinParams("", "123").ok).toBe(false); });
  it("rejects empty ts", () => { expect(validatePinParams("C123", "").ok).toBe(false); });
});

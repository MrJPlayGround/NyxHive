import { describe, it, expect } from "bun:test";
import { validateReactionParams } from "../channels/slack/reactions.js";

describe("validateReactionParams", () => {
  it("accepts valid params", () => {
    expect(validateReactionParams("C123", "123", "thumbsup")).toEqual({ ok: true, emoji: "thumbsup" });
  });
  it("rejects empty channel", () => {
    expect(validateReactionParams("", "123", "thumbsup").ok).toBe(false);
  });
  it("strips colons from emoji name", () => {
    expect(validateReactionParams("C123", "123", ":thumbsup:")).toEqual({ ok: true, emoji: "thumbsup" });
  });
});

import { describe, expect, it } from "bun:test";
import {
  buildTelegramInputChoiceData,
  isTelegramMessageNotModified,
  parseTelegramInputChoiceData,
} from "../channels/telegram.js";
import {
  buildDiscordInputChoiceId,
  parseDiscordInputChoiceId,
} from "../channels/discord.js";

describe("telegram interactive helpers", () => {
  it("round-trips telegram callback payloads", () => {
    const payload = buildTelegramInputChoiceData("msg-1", "Use Bun");
    expect(parseTelegramInputChoiceData(payload)).toEqual({
      messageId: "msg-1",
      choice: "Use Bun",
    });
  });

  it("rejects unrelated telegram callback payloads", () => {
    expect(parseTelegramInputChoiceData("proposal:approve:123")).toBeNull();
  });

  it("detects telegram duplicate-edit no-ops", () => {
    expect(isTelegramMessageNotModified(
      new Error("GrammyError: Bad Request: message is not modified"),
    )).toBe(true);
    expect(isTelegramMessageNotModified({ description: "Bad Request: message is not modified" })).toBe(true);
    expect(isTelegramMessageNotModified(new Error("Bad Request: message to edit not found"))).toBe(false);
  });
});

describe("discord interactive helpers", () => {
  it("round-trips discord button payloads", () => {
    const payload = buildDiscordInputChoiceId("msg-2", "Use Bun");
    expect(parseDiscordInputChoiceId(payload)).toEqual({
      messageId: "msg-2",
      choice: "Use Bun",
    });
  });

  it("rejects unrelated discord button payloads", () => {
    expect(parseDiscordInputChoiceId("proposal:approve:123")).toBeNull();
  });
});

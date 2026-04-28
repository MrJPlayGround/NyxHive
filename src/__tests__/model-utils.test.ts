import { describe, it, expect } from "bun:test";
import { resolveModelAlias, parseProposalCommand, formatRelativeTime } from "../queue/model-utils.js";

describe("resolveModelAlias", () => {
  it("resolves tier aliases from registry", () => {
    expect(resolveModelAlias("sonnet")).toBe("claude-sonnet-4-6");
    expect(resolveModelAlias("opus")).toBe("claude-opus-4-6");
    expect(resolveModelAlias("haiku")).toBe("claude-haiku-4-5-20251001");
  });

  it("resolves provider shortcut aliases", () => {
    expect(resolveModelAlias("flash")).toBe("deepseek/deepseek-v3.2");
    expect(resolveModelAlias("flash-lite")).toBe("deepseek/deepseek-v3.2");
    expect(resolveModelAlias("pro")).toBe("deepseek/deepseek-v3.2");
  });

  it("is case-insensitive", () => {
    expect(resolveModelAlias("SONNET")).toBe("claude-sonnet-4-6");
    expect(resolveModelAlias("Flash")).toBe("deepseek/deepseek-v3.2");
  });

  it("resolves OpenAI model aliases", () => {
    expect(resolveModelAlias("codex")).toBe("gpt-5.5");
    expect(resolveModelAlias("openai")).toBe("gpt-5.5");

    // Short alias — "gpt" defaults to the current Codex-compatible GPT model.
    expect(resolveModelAlias("gpt")).toBe("gpt-5.5");
    expect(resolveModelAlias("GPT")).toBe("gpt-5.5");

    // Spaced, dashed, and concatenated variants
    expect(resolveModelAlias("gpt5")).toBe("gpt-5.5");
    expect(resolveModelAlias("gpt 5")).toBe("gpt-5.5");
    expect(resolveModelAlias("gpt-5")).toBe("gpt-5.5");
    expect(resolveModelAlias("gpt 5.5")).toBe("gpt-5.5");
    expect(resolveModelAlias("gpt-5.5")).toBe("gpt-5.5");
    expect(resolveModelAlias("gpt5.5")).toBe("gpt-5.5");
    expect(resolveModelAlias("gpt 5.4")).toBe("gpt-5.4");
    expect(resolveModelAlias("gpt-5.4")).toBe("gpt-5.4");
    expect(resolveModelAlias("gpt5.4")).toBe("gpt-5.4");

    // Pro variant
    expect(resolveModelAlias("gpt 5.4 pro")).toBe("gpt-5.4-pro");
    expect(resolveModelAlias("gpt-5.4-pro")).toBe("gpt-5.4-pro");

    // Mini and nano
    expect(resolveModelAlias("gpt 5 mini")).toBe("gpt-5-mini");
    expect(resolveModelAlias("gpt 5 nano")).toBe("gpt-5-nano");
  });

  it("resolves Anthropic provider aliases", () => {
    expect(resolveModelAlias("claude")).toBe("claude-sonnet-4-6");
    expect(resolveModelAlias("anthropic")).toBe("claude-sonnet-4-6");
  });

  it("returns input unchanged for unknown aliases", () => {
    expect(resolveModelAlias("some-custom-model")).toBe("some-custom-model");
  });
});

describe("parseProposalCommand", () => {
  it("parses approve command", () => {
    expect(parseProposalCommand("approve abcd1234")).toEqual({
      action: "approve",
      id: "abcd1234",
    });
  });

  it("parses approve with leading/trailing whitespace", () => {
    expect(parseProposalCommand("  approve abcd1234  ")).toEqual({
      action: "approve",
      id: "abcd1234",
    });
  });

  it("parses reject command with reason", () => {
    expect(parseProposalCommand("reject abcd1234 not ready yet")).toEqual({
      action: "reject",
      id: "abcd1234",
      reason: "not ready yet",
    });
  });

  it("is case-insensitive for action keyword", () => {
    expect(parseProposalCommand("APPROVE abcd1234")).toEqual({
      action: "approve",
      id: "abcd1234",
    });
    expect(parseProposalCommand("Reject abcd1234 nope")).toEqual({
      action: "reject",
      id: "abcd1234",
      reason: "nope",
    });
  });

  it("lowercases the proposal id", () => {
    expect(parseProposalCommand("approve ABCD1234")).toEqual({
      action: "approve",
      id: "abcd1234",
    });
  });

  it("returns null for non-matching input", () => {
    expect(parseProposalCommand("hello world")).toBeNull();
    expect(parseProposalCommand("approve")).toBeNull();
    expect(parseProposalCommand("approve xyz")).toBeNull(); // not 8 hex chars
    expect(parseProposalCommand("reject abcd1234")).toBeNull(); // reject needs a reason
  });

  it("rejects ids that are not exactly 8 hex chars", () => {
    expect(parseProposalCommand("approve abcd123")).toBeNull(); // 7 chars
    expect(parseProposalCommand("approve abcd12345")).toBeNull(); // 9 chars
    expect(parseProposalCommand("approve zzzzzzzz")).toBeNull(); // non-hex
  });
});

describe("formatRelativeTime", () => {
  it("returns 'just now' for less than a minute ago", () => {
    expect(formatRelativeTime(Date.now() - 30_000)).toBe("just now");
    expect(formatRelativeTime(Date.now())).toBe("just now");
  });

  it("returns minutes for < 60 minutes", () => {
    expect(formatRelativeTime(Date.now() - 5 * 60_000)).toBe("5min ago");
    expect(formatRelativeTime(Date.now() - 59 * 60_000)).toBe("59min ago");
  });

  it("returns hours for < 24 hours", () => {
    expect(formatRelativeTime(Date.now() - 2 * 3600_000)).toBe("2h ago");
    expect(formatRelativeTime(Date.now() - 23 * 3600_000)).toBe("23h ago");
  });

  it("returns days for >= 24 hours", () => {
    expect(formatRelativeTime(Date.now() - 48 * 3600_000)).toBe("2d ago");
    expect(formatRelativeTime(Date.now() - 7 * 24 * 3600_000)).toBe("7d ago");
  });

  it("returns 1min ago at exactly 60 seconds", () => {
    expect(formatRelativeTime(Date.now() - 60_000)).toBe("1min ago");
  });
});

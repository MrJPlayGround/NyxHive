import { describe, it, expect } from "bun:test";
import { resolveChannelConfig } from "../channels/slack/channel-config.js";

describe("resolveChannelConfig", () => {
  it("returns defaults when no per-channel config", () => {
    const result = resolveChannelConfig("C_UNKNOWN", undefined);
    expect(result.require_mention).toBe(false);
    expect(result.system_prompt).toBeUndefined();
  });
  it("returns per-channel overrides", () => {
    const channels = { C_SUPPORT: { agent: "morph", require_mention: true, system_prompt: "Support agent.", allowed_users: ["U123"] } };
    const result = resolveChannelConfig("C_SUPPORT", channels);
    expect(result.agent).toBe("morph");
    expect(result.require_mention).toBe(true);
    expect(result.system_prompt).toBe("Support agent.");
  });
  it("channels not in config get defaults", () => {
    const result = resolveChannelConfig("C_RANDOM", { C_OTHER: { agent: "nyx" } });
    expect(result.agent).toBeUndefined();
  });
  it("includes history config", () => {
    const channels = { C_HIST: { history_limit: 100, dm_history_limit: 25 } };
    const result = resolveChannelConfig("C_HIST", channels);
    expect(result.history_limit).toBe(100);
    expect(result.dm_history_limit).toBe(25);
  });
});

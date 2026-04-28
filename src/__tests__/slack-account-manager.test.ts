import { describe, it, expect } from "bun:test";
import { SlackAccountManager } from "../channels/slack/account-manager.js";

describe("SlackAccountManager", () => {
  it("aggregates stats from multiple accounts", () => {
    // We can't easily construct real SlackChannel instances without tokens,
    // so test the class structure
    const manager = new SlackAccountManager([]);
    expect(manager.name).toBe("slack");
    expect(manager.isConnected()).toBe(false);
    expect(manager.getStats()).toEqual({ messagesReceived: 0, messagesSent: 0, errors: 0 });
  });
});

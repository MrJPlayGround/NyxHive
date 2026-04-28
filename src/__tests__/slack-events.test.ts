import { describe, it, expect } from "bun:test";
import { formatChannelEvent, formatMemberEvent, formatMessageEvent } from "../channels/slack/events.js";

describe("slack events", () => {
  it("formats channel_created", () => {
    const event = formatChannelEvent("channel_created", { id: "C123", name: "new-channel" });
    expect(event.type).toBe("channel_created");
    expect(event.channel_id).toBe("C123");
    expect(event.channel_name).toBe("new-channel");
  });
  it("formats channel_created with nested channel object", () => {
    const event = formatChannelEvent("channel_created", { channel: { id: "C456", name: "other" } });
    expect(event.channel_id).toBe("C456");
  });
  it("formats member_joined", () => {
    const event = formatMemberEvent("member_joined_channel", { user: "U123", channel: "C456" });
    expect(event.type).toBe("member_joined_channel");
    expect(event.user_id).toBe("U123");
    expect(event.channel_id).toBe("C456");
  });
});

describe("message events", () => {
  it("formats message_changed", () => {
    const event = formatMessageEvent("message_changed", {
      channel: "C123",
      previous_message: { text: "old", user: "U456", ts: "123.456" },
      message: { text: "new", user: "U456", ts: "123.456" },
    });
    expect(event.type).toBe("message_changed");
    expect(event.previous_text).toBe("old");
    expect(event.new_text).toBe("new");
  });
  it("formats message_deleted", () => {
    const event = formatMessageEvent("message_deleted", {
      channel: "C123",
      previous_message: { text: "deleted msg", user: "U456", ts: "123.456" },
    });
    expect(event.type).toBe("message_deleted");
    expect(event.new_text).toBeUndefined();
  });
});

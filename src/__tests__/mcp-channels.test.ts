import { describe, expect, test } from "bun:test";
import { buildChannelToolList, sendChannelToolMessage } from "../mcp/server.js";
import { resolveMcpToolProfile } from "../agents/mcp-tool-profiles.js";
import type { Channel } from "../channels/types.js";

function channel(overrides: Partial<Channel>): Channel {
  return {
    name: "discord",
    start: async () => {},
    stop: async () => {},
    isConnected: () => true,
    getStats: () => ({ messagesReceived: 0, messagesSent: 0, errors: 0 }),
    ...overrides,
  };
}

describe("MCP channel tools", () => {
  test("lists connected outbound-capable channels", () => {
    const result = buildChannelToolList([
      channel({ name: "discord", sendOutbound: async () => {} }),
      channel({ name: "telegram", isConnected: () => false }),
    ]);

    expect(result).toEqual({
      ok: true,
      count: 2,
      channels: [
        { name: "discord", connected: true, supports_outbound: true },
        { name: "telegram", connected: false, supports_outbound: false },
      ],
    });
  });

  test("sends through the selected channel outbound bridge", async () => {
    const sent: Array<{ recipient: string; message: string; agent?: string; replyToId?: string }> = [];
    const result = await sendChannelToolMessage([
      channel({
        name: "discord",
        sendOutbound: async (recipient, message, agent, replyToId) => {
          sent.push({ recipient, message, agent, replyToId });
        },
      }),
    ], {
      channel: "DISCORD",
      recipient: "channel-1",
      message: "hello",
      agent: "vortex",
      reply_to_id: "thread-1",
    });

    expect(result).toEqual({ ok: true, channel: "discord", recipient: "channel-1" });
    expect(sent).toEqual([
      { recipient: "channel-1", message: "hello", agent: "vortex", replyToId: "thread-1" },
    ]);
  });

  test("MCP profiling exposes generic channel tools for Discord/channel requests", () => {
    const decision = resolveMcpToolProfile({
      requestedTools: ["channels_list", "channel_send", "search_knowledge"],
      taskType: "conversation",
      message: "send this to the Discord channel",
    });

    expect(decision.profile).toBe("conversation+channel");
    expect(decision.exposedTools).toEqual(["channels_list", "channel_send"]);
    expect(decision.droppedTools).toEqual(["search_knowledge"]);
  });
});

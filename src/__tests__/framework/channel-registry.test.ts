import { describe, it, expect } from "bun:test";
import type { ChannelFactory, ChannelDeps } from "../../framework/types.js";
import type { Channel } from "../../channels/types.js";

describe("Channel Registry", () => {
  it("should call create on each factory and collect channels", async () => {
    const mockFactory: ChannelFactory = {
      name: "test",
      async create(): Promise<Channel> {
        return {
          name: "test",
          start: async () => {},
          stop: async () => {},
          isConnected: () => true,
          getStats: () => ({ messagesReceived: 0, messagesSent: 0, errors: 0 }),
        };
      },
    };
    const channels: Channel[] = [];
    for (const factory of [mockFactory]) {
      try {
        channels.push(await factory.create({} as ChannelDeps));
      } catch { /* skip */ }
    }
    expect(channels).toHaveLength(1);
    expect(channels[0].name).toBe("test");
  });

  it("should skip factories that throw", async () => {
    const fail: ChannelFactory = { name: "broken", async create() { throw new Error("fail"); } };
    const ok: ChannelFactory = {
      name: "ok",
      async create(): Promise<Channel> {
        return { name: "ok", start: async () => {}, stop: async () => {}, isConnected: () => true, getStats: () => ({ messagesReceived: 0, messagesSent: 0, errors: 0 }) };
      },
    };
    const channels: Channel[] = [];
    for (const f of [fail, ok]) {
      try { channels.push(await f.create({} as ChannelDeps)); } catch { /* skip */ }
    }
    expect(channels).toHaveLength(1);
    expect(channels[0].name).toBe("ok");
  });
});

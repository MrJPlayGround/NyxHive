import { describe, expect, it, mock } from "bun:test";
import { SlackChannel } from "../channels/slack.js";

function makeSlackChannel(slackSurfaces?: any[]) {
  const publicProcessor = {
    enqueue: mock(async () => "msg-1"),
    onEvent: mock(() => () => {}),
    onResponse: mock(() => () => {}),
    getStatus: mock(() => ({ running: true, queueLength: 0, activeProcesses: 0 })),
    getActiveAgents: mock(() => []),
  };
  const processor = {
    processImmediate: mock(async () => ({
      response: "processed reply",
      agent: "nyx",
      tokens_in: 10,
      tokens_out: 5,
      cost: 0,
      duration_ms: 25,
    })),
    cancelTask: mock(() => ({ cancelled: true, agent: "nyx", elapsed: 5 })),
    clearConversation: mock(() => {}),
    forgetMessages: mock(() => ({ removed: 1 })),
    trimConversation: mock(() => ({ removed: 2 })),
    getContextInfo: mock(() => ({ messageCount: 3, hasSummary: true })),
    getActiveTasks: mock(() => []),
    getPublicAPI: mock(() => publicProcessor),
  };
  const queue = {
    getQueueStats: mock(() => ({
      pending: 1,
      processing: 2,
      suspended: 3,
      completed: 3,
      failed: 4,
      dead_letter: 5,
    })),
  };

  const channel = new SlackChannel({
    botToken: "xoxb-test",
    appToken: "xapp-test",
    config: {
      daemon: { name: "TestHive", log_level: "info", data_dir: "/tmp/test" },
      server: { port: 3000 },
      agents: { nyx: { identity: {} } },
      providers: {},
      routing: { classifier_model: "test", classifier_provider: "test", cli_escalation_tasks: [] },
      context: { max_history: 10, summary_threshold: 5 },
    } as any,
    queue: queue as any,
    processor: processor as any,
    slackSurfaces,
  });

  const client = {
    chat: {
      postEphemeral: mock(async () => {}),
      postMessage: mock(async () => ({ ts: "171234.5678" })),
      update: mock(async () => ({})),
      delete: mock(async () => ({})),
    },
    reactions: {
      add: mock(async () => {}),
      remove: mock(async () => {}),
    },
    users: {
      info: mock(async ({ user }: { user: string }) => ({ user: { real_name: `User ${user}`, name: user } })),
    },
  };

  (queue as any).checkSenderRateLimit = mock(() => true);

  return { channel: channel as any, client, processor, publicProcessor, queue };
}

describe("SlackChannel slash commands", () => {
  it("cancels the active thread task when Slack provides thread metadata", async () => {
    const { channel, client, processor } = makeSlackChannel();

    await channel.handleCancelCommand({
      channel_id: "C123",
      user_id: "U123",
      thread_ts: "171234.5678",
    }, client);

    expect(processor.cancelTask).toHaveBeenCalledWith("slack", "thread:171234.5678");
    expect(client.chat.postEphemeral).toHaveBeenCalledWith({
      channel: "C123",
      user: "U123",
      text: "Cancelled nyx task (was running 5s).",
    });
  });

  it("scopes reset to the current Slack conversation when thread metadata is present", async () => {
    const { channel, client, processor } = makeSlackChannel();

    await channel.handleResetCommand({
      channel_id: "C123",
      user_id: "U123",
      thread_ts: "171234.5678",
    }, client);

    expect(processor.clearConversation).toHaveBeenCalledWith("slack", "thread:171234.5678");
    expect(client.chat.postEphemeral).toHaveBeenCalledWith({
      channel: "C123",
      user: "U123",
      text: "Conversation context cleared.",
    });
  });

  it("reports Slack queue stats via /usage", async () => {
    const { channel, client } = makeSlackChannel();

    await channel.handleUsageCommand({
      channel_id: "C123",
      user_id: "U123",
    }, client);

    expect(client.chat.postEphemeral).toHaveBeenCalledWith({
      channel: "C123",
      user: "U123",
      text: "Queue stats:\nPending: 1\nProcessing: 2\nSuspended: 3\nCompleted: 3\nFailed: 4\nDead letters: 5",
    });
  });

  it("dispatches registered Slack slash command surfaces without touching core handlers", async () => {
    const handler = mock(async () => ({ handled: true, text: "Morph snapshot ready", ephemeral: true }));
    const { channel, client, publicProcessor, queue } = makeSlackChannel([
      {
        owner: "morph",
        commands: [{ command: "snapshot", description: "Run Morph snapshot", handler }],
      },
    ]);

    await channel.handleRegisteredSlackCommand({
      command: "snapshot",
      description: "Run Morph snapshot",
      handler,
    }, {
      channel_id: "C123",
      user_id: "U123",
      user_name: "Morph",
      text: "latest",
    }, client);

    expect(handler).toHaveBeenCalled();
    const commandCtx = (handler as any).mock.calls[0][0];
    expect(commandCtx).toMatchObject({
      command: "snapshot",
      text: "latest",
      args: ["latest"],
      processor: publicProcessor,
      queue,
      userId: "U123",
      userName: "Morph",
    });
    expect(client.chat.postEphemeral).toHaveBeenCalledWith({
      channel: "C123",
      user: "U123",
      text: "Morph snapshot ready",
    });
  });

  it("dispatches registered message surfaces before the normal LLM flow", async () => {
    const handler = mock(async () => ({ handled: true, text: "live snapshot output" }));
    const { channel, client, publicProcessor, queue } = makeSlackChannel([
      {
        owner: "morph",
        messages: [{ name: "live-snapshot", description: "Run live snapshot", pattern: /^live snapshot$/i, handler }],
      },
    ]);

    const handled = await channel.dispatchMessageSurfaces({
      text: "live snapshot",
      channelId: "D123",
      userId: "U123",
      userName: "Morph",
      messageTs: "171234.5678",
      isDM: true,
      role: "operator",
      client,
      mentioned: false,
    });

    expect(handled).toBe(true);
    expect(handler).toHaveBeenCalled();
    const messageCtx = (handler as any).mock.calls[0][0];
    expect(messageCtx).toMatchObject({
      text: "live snapshot",
      args: [],
      processor: publicProcessor,
      queue,
      channelId: "D123",
      isDM: true,
    });
    expect(client.chat.postMessage).toHaveBeenCalledWith({
      channel: "D123",
      text: "live snapshot output",
      thread_ts: "171234.5678",
    });
  });

  it("turns interactive input choices into a real follow-up turn", async () => {
    const { channel, client, processor } = makeSlackChannel();

    await channel.handleInteractiveReply("D123", "U123", "171234.1111", "Use Bun", client);

    expect(client.chat.postMessage).toHaveBeenCalledWith({
      channel: "D123",
      text: "Use Bun",
      thread_ts: "171234.1111",
    });
    expect(processor.processImmediate).toHaveBeenCalledWith(expect.objectContaining({
      channel: "slack",
      sender_id: "U123",
      message: expect.stringContaining("Use Bun"),
    }));
  });
});

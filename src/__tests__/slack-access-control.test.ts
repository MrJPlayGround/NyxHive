import { describe, expect, it, mock } from "bun:test";
import { SlackChannel } from "../channels/slack.js";

function makeSlackChannel(opts?: {
  autoApproveRole?: "operator" | "engineer" | "support" | "viewer";
  userRoles?: Record<string, "operator" | "engineer" | "support" | "viewer">;
  pairingRole?: "operator" | "engineer" | "support" | "viewer" | null;
  hasAnyApproved?: boolean;
}) {
  const pairing = {
    getRole: mock(() => opts?.pairingRole ?? null),
    hasAnyApproved: mock(() => opts?.hasAnyApproved ?? true),
    generateCode: mock(() => "ABC12345"),
    approve: mock(() => ({ channel: "slack", sender_id: "U_NEW", sender: "New User" })),
    setRole: mock(() => true),
  };

  const queue = {
    getQueueStats: mock(() => ({
      pending: 1,
      processing: 2,
      completed: 3,
      failed: 4,
      dead_letter: 5,
    })),
  };

  const processor = {
    cancelTask: mock(() => ({ cancelled: false })),
    clearConversation: mock(() => {}),
    forgetMessages: mock(() => ({ removed: 0 })),
    trimConversation: mock(() => ({ removed: 0 })),
    getContextInfo: mock(() => ({ messageCount: 0, hasSummary: false })),
  };

  const channel = new SlackChannel({
    botToken: "xoxb-test",
    appToken: "xapp-test",
    config: {
      daemon: { name: "TestHive", log_level: "info", data_dir: "/tmp/test" },
      server: { port: 3000 },
      agents: {},
      providers: {},
      routing: { classifier_model: "test", classifier_provider: "test", cli_escalation_tasks: [] },
      context: { max_history: 10, summary_threshold: 5 },
      slack: {
        bot_token_env: "BOT",
        app_token_env: "APP",
        ...(opts?.autoApproveRole ? { auto_approve_role: opts.autoApproveRole } : {}),
        ...(opts?.userRoles ? { user_roles: opts.userRoles } : {}),
      },
    } as any,
    queue: queue as any,
    processor: processor as any,
    pairing: pairing as any,
  });

  const client = {
    chat: {
      postEphemeral: mock(async () => {}),
      postMessage: mock(async () => {}),
    },
    users: {
      info: mock(async () => ({ user: { real_name: "New User", name: "new.user" } })),
    },
  };

  return { channel: channel as any, client, pairing, queue };
}

describe("Slack access control", () => {
  it("auto-approves Slack users to the configured default role", async () => {
    const { channel, client, pairing } = makeSlackChannel({ autoApproveRole: "viewer", pairingRole: null });

    const role = await channel.ensureSlackUserApproved("U_NEW", "C123", client, "171234.5");

    expect(role).toBe("viewer");
    expect(pairing.generateCode).toHaveBeenCalledWith("slack", "U_NEW", "New User");
    expect(pairing.approve).toHaveBeenCalledWith("ABC12345", undefined, "viewer");
  });

  it("auto-approves configured Slack users to their mapped role", async () => {
    const { channel, client, pairing } = makeSlackChannel({
      autoApproveRole: "viewer",
      userRoles: { U_TEAM: "engineer" },
      pairingRole: null,
    });

    const role = await channel.ensureSlackUserApproved("U_TEAM", "C123", client, "171234.5");

    expect(role).toBe("engineer");
    expect(pairing.approve).toHaveBeenCalledWith("ABC12345", undefined, "engineer");
  });

  it("syncs an approved user to the configured role", async () => {
    const { channel, client, pairing } = makeSlackChannel({
      userRoles: { U_TEAM: "engineer" },
      pairingRole: "viewer",
    });

    const role = await channel.ensureSlackUserApproved("U_TEAM", "C123", client, "171234.5");

    expect(role).toBe("engineer");
    expect(pairing.setRole).toHaveBeenCalledWith("slack", "U_TEAM", "engineer");
    expect(pairing.approve).not.toHaveBeenCalled();
  });

  it("does not bootstrap an unknown first user to operator when explicit roles are configured", async () => {
    const { channel, client, pairing } = makeSlackChannel({
      autoApproveRole: "viewer",
      userRoles: { U_JAY: "operator" },
      pairingRole: null,
      hasAnyApproved: false,
    });

    const role = await channel.ensureSlackUserApproved("U_OTHER", "C123", client, "171234.5");

    expect(role).toBe("viewer");
    expect(pairing.approve).toHaveBeenCalledWith("ABC12345", undefined, "viewer");
  });

  it("blocks queue stats for non-operators", async () => {
    const { channel, client, queue } = makeSlackChannel({ pairingRole: "viewer" });

    await channel.handleUsageCommand({
      channel_id: "C123",
      user_id: "U123",
      user_name: "Viewer User",
      command: "/usage",
    }, client);

    expect(queue.getQueueStats).not.toHaveBeenCalled();
    expect(client.chat.postEphemeral).toHaveBeenCalledWith({
      channel: "C123",
      user: "U123",
      text: "Only operators can view queue stats.",
    });
  });

  it("restricts /pair to operators", async () => {
    const { channel, client, pairing } = makeSlackChannel({ pairingRole: "viewer" });

    await channel.handlePairCommand({
      channel_id: "C123",
      user_id: "U123",
      user_name: "Viewer User",
      command: "/pair",
      text: "ABC12345",
    }, client);

    expect(pairing.approve).not.toHaveBeenCalled();
    expect(client.chat.postEphemeral).toHaveBeenCalledWith({
      channel: "C123",
      user: "U123",
      text: "Only operators can approve new Slack users.",
    });
  });
});

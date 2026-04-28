import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { iOSChannel } from "../channels/ios.js";
import type { NyxHiveConfig } from "../types.js";

function makeConfig(agents: Record<string, { name: string }>, teams?: Record<string, { name: string; agents: string[] }>): NyxHiveConfig {
  const agentConfigs: Record<string, any> = {};
  for (const [key, val] of Object.entries(agents)) {
    agentConfigs[key] = { name: val.name, provider: "test", model: "test", working_directory: "/tmp" };
  }
  return {
    daemon: { name: "test", log_level: "error", data_dir: "/tmp" },
    server: { port: 3000 },
    agents: agentConfigs,
    teams: teams as any,
    providers: {},
    routing: { classifier_model: "test", classifier_provider: "test", cli_escalation_tasks: [] },
    context: { max_history: 10, summary_threshold: 5 },
  } as NyxHiveConfig;
}

describe("iOSChannel", () => {
  let tmpDir: string;
  let channel: iOSChannel;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nyxhive-ios-test-"));
    const config = makeConfig(
      { nyx: { name: "Nyx" }, forge: { name: "Forge" }, tester: { name: "Tester" } },
      { dev: { name: "Dev Team", agents: ["forge", "tester"] } },
    );
    channel = new iOSChannel({ config, dataDir: tmpDir });
  });

  afterEach(() => {
    channel.stop();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("construction", () => {
    test("initializes with pull-based connection", () => {
      expect(channel.name).toBe("ios");
      expect(channel.isConnected()).toBe(true);
    });

    test("stats start at zero", () => {
      const stats = channel.getStats();
      expect(stats.messagesReceived).toBe(0);
      expect(stats.messagesSent).toBe(0);
      expect(stats.errors).toBe(0);
    });
  });

  describe("getChannels", () => {
    test("derives channels from agent config", () => {
      const channels = channel.getChannels();
      const agentChannels = channels.filter(c => c.type === "agent");
      expect(agentChannels).toHaveLength(3);
      expect(agentChannels.map(c => c.id)).toContain("ios:nyx");
      expect(agentChannels.map(c => c.id)).toContain("ios:forge");
      expect(agentChannels.map(c => c.id)).toContain("ios:tester");
    });

    test("includes team channels", () => {
      const channels = channel.getChannels();
      const teamChannels = channels.filter(c => c.type === "team");
      expect(teamChannels).toHaveLength(1);
      expect(teamChannels[0].id).toBe("ios:dev");
      expect(teamChannels[0].teamKey).toBe("dev");
    });

    test("always includes system channel", () => {
      const channels = channel.getChannels();
      const system = channels.find(c => c.type === "system");
      expect(system).toBeDefined();
      expect(system!.id).toBe("ios:system");
      expect(system!.name).toBe("System");
    });
  });

  describe("sendOutbound", () => {
    test("stores message and increments stats", async () => {
      await channel.sendOutbound("ios:forge", "Build complete", "forge");
      const stats = channel.getStats();
      expect(stats.messagesSent).toBe(1);
    });

    test("message is retrievable", async () => {
      await channel.sendOutbound("ios:forge", "Build complete", "forge");
      const messages = channel.getOutboundMessages("ios:forge");
      expect(messages).toHaveLength(1);
      expect(messages[0].message).toBe("Build complete");
      expect(messages[0].agent).toBe("forge");
      expect(messages[0].channel).toBe("ios:forge");
    });

    test("agent defaults to null when not provided", async () => {
      await channel.sendOutbound("ios:system", "System alert");
      const messages = channel.getOutboundMessages("ios:system");
      expect(messages).toHaveLength(1);
      expect(messages[0].agent).toBeNull();
    });
  });

  describe("getOutboundMessages", () => {
    test("filters by channel", async () => {
      await channel.sendOutbound("ios:forge", "msg1", "forge");
      await channel.sendOutbound("ios:nyx", "msg2", "nyx");
      await channel.sendOutbound("ios:forge", "msg3", "forge");

      const forgeMessages = channel.getOutboundMessages("ios:forge");
      expect(forgeMessages).toHaveLength(2);
      for (const m of forgeMessages) {
        expect(m.channel).toBe("ios:forge");
      }
    });

    test("since filter returns only newer messages", async () => {
      await channel.sendOutbound("ios:forge", "old message", "forge");
      const cutoff = Date.now();
      // Small delay to ensure timestamp difference
      await new Promise(r => setTimeout(r, 10));
      await channel.sendOutbound("ios:forge", "new message", "forge");

      const messages = channel.getOutboundMessages("ios:forge", cutoff);
      expect(messages).toHaveLength(1);
      expect(messages[0].message).toBe("new message");
    });

    test("respects limit", async () => {
      for (let i = 0; i < 10; i++) {
        await channel.sendOutbound("ios:forge", `msg ${i}`, "forge");
      }
      const messages = channel.getOutboundMessages("ios:forge", undefined, 3);
      expect(messages).toHaveLength(3);
    });
  });

  describe("markRead", () => {
    test("marks messages as read", async () => {
      await channel.sendOutbound("ios:forge", "msg1", "forge");
      const messages = channel.getOutboundMessages("ios:forge");
      const id = messages[0].id;

      channel.markRead([id]);

      // Verify by checking the DB directly
      const db = channel.getDb();
      const row = db.prepare("SELECT read_at FROM outbound_messages WHERE id = ?").get(id) as any;
      expect(row.read_at).toBeTruthy();
    });

    test("handles multiple message IDs", async () => {
      await channel.sendOutbound("ios:forge", "msg1", "forge");
      await channel.sendOutbound("ios:forge", "msg2", "forge");
      const messages = channel.getOutboundMessages("ios:forge");
      const ids = messages.map(m => m.id);

      channel.markRead(ids);

      const db = channel.getDb();
      for (const id of ids) {
        const row = db.prepare("SELECT read_at FROM outbound_messages WHERE id = ?").get(id) as any;
        expect(row.read_at).toBeTruthy();
      }
    });
  });
});

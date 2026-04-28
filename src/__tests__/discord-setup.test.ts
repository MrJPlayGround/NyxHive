import { describe, expect, test } from "bun:test";
import { buildDefaultDiscordConfig } from "../setup/discord.js";

describe("Discord setup defaults", () => {
  test("creates a mention-only Discord config without implicit privileged users", () => {
    expect(buildDefaultDiscordConfig()).toEqual({
      bot_token_env: "DISCORD_BOT_TOKEN",
      require_mention: true,
      privileged_user_ids: [],
    });
  });

  test("preserves configured privileged Discord users when provided", () => {
    expect(buildDefaultDiscordConfig("DISCORD_BOT_TOKEN", ["000000000000000000"])).toEqual({
      bot_token_env: "DISCORD_BOT_TOKEN",
      require_mention: true,
      privileged_user_ids: ["000000000000000000"],
    });
  });
});

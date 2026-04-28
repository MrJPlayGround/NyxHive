import { readFileSync, writeFileSync, appendFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { logger } from "../utils/logger.js";
import { formatError } from "../utils/error.js";
import { DiscordChannel } from "../channels/discord.js";
import type { NyxHiveConfig } from "../types.js";
import type { QueueDB } from "../queue/db.js";
import type { QueueProcessor } from "../queue/processor.js";
import type { PairingStore } from "../pairing/pairing.js";
import type { Channel } from "../channels/types.js";
import type { DelegationRunStore } from "../runs/store.js";

const DEFAULT_DISCORD_BOT_TOKEN_ENV = "DISCORD_BOT_TOKEN";

/**
 * Runtime context shared between the daemon, server, and channels.
 * Allows dynamic channel attachment without restarting.
 */
export interface DaemonRuntime {
  config: NyxHiveConfig;
  configPath: string;
  queue: QueueDB;
  processor: QueueProcessor;
  pairing?: PairingStore;
  runs?: DelegationRunStore;
  channels: Channel[];
}

interface TokenValidation {
  valid: boolean;
  tag?: string;
  id?: string;
  error?: string;
}

/**
 * Validate a Discord bot token against the Discord API.
 * Returns the bot's tag and application ID on success.
 */
export async function validateDiscordToken(token: string): Promise<TokenValidation> {
  try {
    const res = await fetch("https://discord.com/api/v10/users/@me", {
      headers: { Authorization: `Bot ${token}` },
    });

    if (!res.ok) {
      const status = res.status;
      const hint =
        status === 401
          ? " — token is invalid or revoked"
          : "";
      return { valid: false, error: `Discord API returned ${status}${hint}` };
    }

    const data = (await res.json()) as {
      id: string;
      username: string;
      discriminator: string;
    };

    const tag =
      data.discriminator === "0"
        ? data.username
        : `${data.username}#${data.discriminator}`;

    return { valid: true, tag, id: data.id };
  } catch (err) {
    return { valid: false, error: String(err) };
  }
}

/**
 * Generate a Discord bot invite URL with the required permissions.
 */
export function discordInviteUrl(clientId: string): string {
  // 274877910016 = Send Messages + Read Message History + Use Slash Commands
  return `https://discord.com/oauth2/authorize?client_id=${clientId}&scope=bot+applications.commands&permissions=274877910016`;
}

export function buildDefaultDiscordConfig(
  botTokenEnv = DEFAULT_DISCORD_BOT_TOKEN_ENV,
  privilegedUserIds: string[] = [],
): NonNullable<NyxHiveConfig["discord"]> {
  return {
    bot_token_env: botTokenEnv,
    require_mention: true,
    privileged_user_ids: privilegedUserIds.map((id) => id.trim()).filter(Boolean),
  };
}

function hasTomlKey(section: string, key: string): boolean {
  return new RegExp(`^\\s*${key}\\s*=`, "m").test(section);
}

function upsertDiscordConfigSection(configContent: string, discordConfig: NonNullable<NyxHiveConfig["discord"]>): string {
  const renderedSection = [
    "[discord]",
    `bot_token_env = "${discordConfig.bot_token_env}"`,
    `require_mention = ${discordConfig.require_mention === true ? "true" : "false"}`,
    `privileged_user_ids = [${discordConfig.privileged_user_ids?.map((id) => `"${id}"`).join(", ") ?? ""}]`,
  ].join("\n");

  const headerMatch = configContent.match(/^\[discord\]\s*$/m);
  if (headerMatch?.index === undefined) {
    return `${configContent.trimEnd()}\n\n${renderedSection}\n`;
  }

  const sectionStart = headerMatch.index;
  const sectionBodyStart = sectionStart + headerMatch[0].length;
  const nextSectionMatch = configContent.slice(sectionBodyStart).match(/\n\[[^\]]+\]\s*$/m);
  const sectionEnd = nextSectionMatch?.index === undefined
    ? configContent.length
    : sectionBodyStart + nextSectionMatch.index;
  const section = configContent.slice(sectionStart, sectionEnd);
  const additions: string[] = [];
  if (!hasTomlKey(section, "require_mention")) {
    additions.push(`require_mention = ${discordConfig.require_mention === true ? "true" : "false"}`);
  }
  if (!hasTomlKey(section, "privileged_user_ids") && !hasTomlKey(section, "privileged_user_id_env")) {
    additions.push(`privileged_user_ids = [${discordConfig.privileged_user_ids?.map((id) => `"${id}"`).join(", ") ?? ""}]`);
  }
  if (additions.length === 0) return configContent;

  const updatedSection = `${section.trimEnd()}\n${additions.join("\n")}\n`;
  return `${configContent.slice(0, sectionStart)}${updatedSection}${configContent.slice(sectionEnd).replace(/^\n?/, "\n")}`;
}

/**
 * Validate token, persist config, and start the Discord channel — all in one.
 */
export async function attachDiscord(
  runtime: DaemonRuntime,
  botToken: string,
): Promise<{ success: boolean; tag?: string; inviteUrl?: string; error?: string }> {
  // Already running?
  if (runtime.channels.some((c) => c.name === "discord")) {
    return { success: false, error: "Discord channel is already active" };
  }

  // Validate
  const v = await validateDiscordToken(botToken);
  if (!v.valid) {
    return { success: false, error: v.error };
  }

  // Persist token to env file
  const envPath = resolve(dirname(runtime.configPath), "env");
  const envContent = existsSync(envPath) ? readFileSync(envPath, "utf-8") : "";

  if (envContent.includes("DISCORD_BOT_TOKEN=")) {
    writeFileSync(
      envPath,
      envContent.replace(/DISCORD_BOT_TOKEN=.*/, `DISCORD_BOT_TOKEN=${botToken}`),
    );
  } else {
    appendFileSync(envPath, `DISCORD_BOT_TOKEN=${botToken}\n`);
  }
  process.env.DISCORD_BOT_TOKEN = botToken;

  const discordConfig = buildDefaultDiscordConfig(DEFAULT_DISCORD_BOT_TOKEN_ENV, runtime.config.discord?.privileged_user_ids ?? []);

  // Persist [discord] section in config.toml
  const configContent = readFileSync(runtime.configPath, "utf-8");
  writeFileSync(runtime.configPath, upsertDiscordConfigSection(configContent, discordConfig));

  // Update in-memory config
  runtime.config.discord = {
    ...runtime.config.discord,
    ...discordConfig,
  };

  // Start the channel
  const discord = new DiscordChannel({
    botToken,
    config: runtime.config,
    queue: runtime.queue,
    processor: runtime.processor,
    pairing: runtime.pairing,
    crawlService: undefined,
    crawlSources: undefined,
    crawlIngest: undefined,
    runs: runtime.runs,
  });

  try {
    await discord.start();
  } catch (err) {
    const msg = formatError(err);
    return { success: false, error: `Bot validated but failed to start: ${msg}` };
  }

  runtime.channels.push(discord);

  const inviteUrl = v.id ? discordInviteUrl(v.id) : undefined;
  logger.info(`[setup] Discord attached as ${v.tag}`);

  return { success: true, tag: v.tag, inviteUrl };
}

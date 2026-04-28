import { createInterface } from "node:readline/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import TOML from "@iarna/toml";
import { getPresetCatalog, normalizePresetName } from "../presets.js";
import { validateDiscordToken } from "../setup/discord.js";

export type SetupMode = "simple" | "advanced";
export type ProviderName = "anthropic" | "openai" | "openrouter" | "ollama";
export type ChannelName = "telegram" | "discord" | "slack" | "imessage";

export interface WizardIO {
  question(prompt: string): Promise<string>;
  print(message: string): void;
  close(): void;
}

export interface ValidatedSecret {
  envName: string;
  value: string;
}

export interface SimpleWizardAnswers {
  name: string;
  preset: string;
  provider: {
    name: ProviderName;
    apiKey?: ValidatedSecret;
    model: string;
    url?: string;
  };
  channels: Partial<Record<ChannelName, Record<string, string>>>;
}

const PURPOSE_PRESET_MAP = {
  coding: "coder",
  companion: "companion",
  ops: "ops",
  research: "researcher",
  custom: "custom",
} as const;

const PROVIDER_DEFAULTS: Record<ProviderName, { model: string; envName?: string; url?: string }> = {
  anthropic: { model: "claude-sonnet-4-6", envName: "ANTHROPIC_API_KEY" },
  openai: { model: "gpt-5-mini", envName: "OPENAI_API_KEY" },
  openrouter: { model: "google/gemini-2.5-flash", envName: "OPENROUTER_API_KEY" },
  ollama: { model: "llama3.2:3b", url: "http://localhost:11434" },
};

async function ask(io: WizardIO, prompt: string, fallback?: string): Promise<string> {
  const answer = (await io.question(prompt)).trim();
  return answer || fallback || "";
}

async function askChoice<T extends string>(
  io: WizardIO,
  prompt: string,
  options: Array<{ key: T; label: string }>,
  fallback: T,
): Promise<T> {
  const lines = options.map((option, index) => `  ${index + 1}. ${option.label}`).join("\n");
  while (true) {
    const answer = (await io.question(`${prompt}\n${lines}\n> `)).trim();
    if (!answer) return fallback;
    const idx = Number.parseInt(answer, 10);
    if (Number.isInteger(idx) && idx >= 1 && idx <= options.length) {
      return options[idx - 1]!.key;
    }
    const matched = options.find((option) => option.key === answer.toLowerCase());
    if (matched) return matched.key;
  }
}

async function askChannelSelection(io: WizardIO): Promise<ChannelName[]> {
  const options: Array<{ key: ChannelName; label: string }> = [
    { key: "telegram", label: "Telegram" },
    { key: "discord", label: "Discord" },
    { key: "slack", label: "Slack" },
    { key: "imessage", label: "iMessage" },
  ];
  const lines = options.map((option, index) => `  ${index + 1}. ${option.label}`).join("\n");
  const answer = (await io.question(`Which channels should be configured? (comma-separated, blank for none)\n${lines}\n> `)).trim();
  if (!answer) return [];

  const selected = new Set<ChannelName>();
  for (const token of answer.split(/[,\s]+/).filter(Boolean)) {
    const idx = Number.parseInt(token, 10);
    if (Number.isInteger(idx) && idx >= 1 && idx <= options.length) {
      selected.add(options[idx - 1]!.key);
      continue;
    }
    const matched = options.find((option) => option.key === token.toLowerCase());
    if (matched) selected.add(matched.key);
  }
  return [...selected];
}

export function buildSimpleConfigToml(input: {
  name: string;
  port: number;
  preset: string;
  provider: {
    name: ProviderName;
    apiKeyEnv?: string;
    model: string;
    url?: string;
  };
  channels?: Partial<Record<ChannelName, Record<string, string>>>;
}): string {
  const clean = (values?: Record<string, string>): Record<string, string> | undefined => {
    if (!values) return undefined;
    return Object.fromEntries(Object.entries(values).filter(([key]) => !key.startsWith("__")));
  };
  const config = {
    name: input.name,
    port: input.port,
    preset: normalizePresetName(input.preset) ?? input.preset,
    provider: {
      name: input.provider.name,
      ...(input.provider.apiKeyEnv ? { api_key_env: input.provider.apiKeyEnv } : {}),
      model: input.provider.model,
      ...(input.provider.url ? { url: input.provider.url } : {}),
    },
  } as Record<string, unknown>;

  if (input.channels?.telegram) config.telegram = clean(input.channels.telegram);
  if (input.channels?.discord) config.discord = clean(input.channels.discord);
  if (input.channels?.slack) config.slack = clean(input.channels.slack);
  if (input.channels?.imessage) config.imessage = clean(input.channels.imessage);

  return `${TOML.stringify(config as any).trim()}\n`;
}

export async function validateProviderInput(provider: ProviderName, value?: string): Promise<{ ok: boolean; detail?: string }> {
  try {
    switch (provider) {
      case "anthropic": {
        const res = await fetch("https://api.anthropic.com/v1/models", {
          headers: {
            "x-api-key": value ?? "",
            "anthropic-version": "2023-06-01",
          },
        });
        if (!res.ok) return { ok: false, detail: `Anthropic returned ${res.status}` };
        return { ok: true, detail: "Anthropic key validated" };
      }
      case "openai": {
        const res = await fetch("https://api.openai.com/v1/models", {
          headers: { Authorization: `Bearer ${value}` },
        });
        if (!res.ok) return { ok: false, detail: `OpenAI returned ${res.status}` };
        return { ok: true, detail: "OpenAI key validated" };
      }
      case "openrouter": {
        const res = await fetch("https://openrouter.ai/api/v1/models", {
          headers: { Authorization: `Bearer ${value}` },
        });
        if (!res.ok) return { ok: false, detail: `OpenRouter returned ${res.status}` };
        return { ok: true, detail: "OpenRouter key validated" };
      }
      case "ollama": {
        const url = value || PROVIDER_DEFAULTS.ollama.url!;
        const res = await fetch(`${url}/api/tags`);
        if (!res.ok) return { ok: false, detail: `Ollama returned ${res.status}` };
        return { ok: true, detail: `Ollama reachable at ${url}` };
      }
    }
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

export async function validateChannelInput(
  channel: ChannelName,
  creds: Record<string, string>,
): Promise<{ ok: boolean; detail?: string }> {
  try {
    switch (channel) {
      case "telegram": {
        const res = await fetch(`https://api.telegram.org/bot${creds.bot_token}/getMe`);
        const body = await res.json().catch(() => null) as { ok?: boolean; result?: { username?: string } } | null;
        if (!res.ok || !body?.ok) return { ok: false, detail: "Telegram bot token rejected" };
        return { ok: true, detail: `Telegram connected: @${body.result?.username ?? "unknown"}` };
      }
      case "discord": {
        const validated = await validateDiscordToken(creds.bot_token);
        return validated.valid
          ? { ok: true, detail: `Discord connected: ${validated.tag}` }
          : { ok: false, detail: validated.error };
      }
      case "slack": {
        const botRes = await fetch("https://slack.com/api/auth.test", {
          headers: { Authorization: `Bearer ${creds.bot_token}` },
        });
        const botBody = await botRes.json().catch(() => null) as { ok?: boolean; user?: string; error?: string } | null;
        if (!botBody?.ok) return { ok: false, detail: `Slack bot token rejected${botBody?.error ? `: ${botBody.error}` : ""}` };

        const appRes = await fetch("https://slack.com/api/apps.connections.open", {
          method: "POST",
          headers: { Authorization: `Bearer ${creds.app_token}` },
        });
        const appBody = await appRes.json().catch(() => null) as { ok?: boolean; error?: string } | null;
        if (!appBody?.ok) return { ok: false, detail: `Slack app token rejected${appBody?.error ? `: ${appBody.error}` : ""}` };
        return { ok: true, detail: `Slack connected: ${botBody.user ?? "bot"}` };
      }
      case "imessage": {
        const dbPath = creds.db_path || join(homedir(), "Library/Messages/chat.db");
        return existsSync(dbPath)
          ? { ok: true, detail: `iMessage DB found at ${dbPath}` }
          : { ok: false, detail: `No Messages DB at ${dbPath}` };
      }
    }
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

async function promptValidatedSecret(
  io: WizardIO,
  prompt: string,
  validator: (value: string) => Promise<{ ok: boolean; detail?: string }>,
  envName: string,
): Promise<ValidatedSecret> {
  while (true) {
    const value = await ask(io, prompt);
    const validated = await validator(value);
    if (validated.ok) {
      if (validated.detail) io.print(`  ${validated.detail}`);
      return { envName, value };
    }
    io.print(`  Validation failed${validated.detail ? `: ${validated.detail}` : ""}`);
  }
}

async function promptProvider(io: WizardIO): Promise<SimpleWizardAnswers["provider"]> {
  const provider = await askChoice<ProviderName>(io, "Which LLM provider?", [
    { key: "anthropic", label: "Anthropic (Claude)" },
    { key: "openai", label: "OpenAI (GPT/Codex)" },
    { key: "openrouter", label: "OpenRouter" },
    { key: "ollama", label: "Ollama (local)" },
  ], "anthropic");
  const defaults = PROVIDER_DEFAULTS[provider];

  if (provider === "ollama") {
    while (true) {
      const url = await ask(io, `  Ollama URL [${defaults.url}]: `, defaults.url);
      const validated = await validateProviderInput("ollama", url);
      if (validated.ok) {
        if (validated.detail) io.print(`  ${validated.detail}`);
        return { name: provider, model: defaults.model, url };
      }
      io.print(`  Validation failed${validated.detail ? `: ${validated.detail}` : ""}`);
    }
  }

  const apiKey = await promptValidatedSecret(
    io,
    `  Enter your ${defaults.envName}: `,
    (value) => validateProviderInput(provider, value),
    defaults.envName!,
  );
  return { name: provider, apiKey, model: defaults.model };
}

async function promptChannels(io: WizardIO): Promise<SimpleWizardAnswers["channels"]> {
  const selected = await askChannelSelection(io);
  const channels: SimpleWizardAnswers["channels"] = {};

  for (const channel of selected) {
    if (channel === "telegram") {
      const botToken = await promptValidatedSecret(
        io,
        "  Telegram bot token: ",
        (value) => validateChannelInput("telegram", { bot_token: value }),
        "TELEGRAM_BOT_TOKEN",
      );
      channels.telegram = { bot_token_env: botToken.envName };
      (channels.telegram as Record<string, string>).__value = botToken.value;
      continue;
    }

    if (channel === "discord") {
      const botToken = await promptValidatedSecret(
        io,
        "  Discord bot token: ",
        (value) => validateChannelInput("discord", { bot_token: value }),
        "DISCORD_BOT_TOKEN",
      );
      channels.discord = { bot_token_env: botToken.envName };
      (channels.discord as Record<string, string>).__value = botToken.value;
      continue;
    }

    if (channel === "slack") {
      while (true) {
        const botToken = await ask(io, "  Slack bot token: ");
        const appToken = await ask(io, "  Slack app token: ");
        const validated = await validateChannelInput("slack", { bot_token: botToken, app_token: appToken });
        if (!validated.ok) {
          io.print(`  Validation failed${validated.detail ? `: ${validated.detail}` : ""}`);
          continue;
        }
        if (validated.detail) io.print(`  ${validated.detail}`);
        channels.slack = {
          bot_token_env: "SLACK_BOT_TOKEN",
          app_token_env: "SLACK_APP_TOKEN",
          __bot_value: botToken,
          __app_value: appToken,
        };
        break;
      }
      continue;
    }

    if (channel === "imessage") {
      const dbPath = await ask(io, `  iMessage database [${join(homedir(), "Library/Messages/chat.db")}]: `, join(homedir(), "Library/Messages/chat.db"));
      const validated = await validateChannelInput("imessage", { db_path: dbPath });
      if (validated.ok) {
        if (validated.detail) io.print(`  ${validated.detail}`);
        channels.imessage = { db_path: dbPath };
      } else {
        io.print(`  Validation failed${validated.detail ? `: ${validated.detail}` : ""}`);
      }
    }
  }

  return channels;
}

export async function promptSetupMode(io: WizardIO): Promise<SetupMode> {
  return askChoice<SetupMode>(io, "Which setup mode?", [
    { key: "simple", label: "Simple" },
    { key: "advanced", label: "Advanced (template-based)" },
  ], "simple");
}

export async function runSimpleInitWizard(io: WizardIO, defaultName: string): Promise<SimpleWizardAnswers> {
  const name = await ask(io, `What should this instance be called? [${defaultName}]: `, defaultName);
  const purpose = await askChoice<keyof typeof PURPOSE_PRESET_MAP>(io, "What's its purpose?", [
    { key: "coding", label: "Engineering lead" },
    { key: "companion", label: "AI companion (Legacy)" },
    { key: "ops", label: "Trading / ops (Legacy)" },
    { key: "research", label: "Research workspace" },
    { key: "custom", label: "Custom" },
  ], "coding");
  const suggestedPreset = PURPOSE_PRESET_MAP[purpose];
  const presetNames = getPresetCatalog().map((preset) => preset.name).join("/");
  const preset = normalizePresetName(await ask(io, `Soul preset [${suggestedPreset}] (${presetNames}): `, suggestedPreset)) ?? suggestedPreset;
  const provider = await promptProvider(io);
  const channels = await promptChannels(io);

  return { name, preset, provider, channels };
}

export function extractEnvLinesFromAnswers(answers: SimpleWizardAnswers): string[] {
  const lines: string[] = [];
  if (answers.provider.apiKey) {
    lines.push(`${answers.provider.apiKey.envName}=${answers.provider.apiKey.value}`);
  }
  if (answers.channels.telegram && "__value" in answers.channels.telegram) {
    lines.push(`TELEGRAM_BOT_TOKEN=${String((answers.channels.telegram as Record<string, string>).__value)}`);
  }
  if (answers.channels.discord && "__value" in answers.channels.discord) {
    lines.push(`DISCORD_BOT_TOKEN=${String((answers.channels.discord as Record<string, string>).__value)}`);
  }
  if (answers.channels.slack) {
    const raw = answers.channels.slack as Record<string, string>;
    if (raw.__bot_value) lines.push(`SLACK_BOT_TOKEN=${raw.__bot_value}`);
    if (raw.__app_value) lines.push(`SLACK_APP_TOKEN=${raw.__app_value}`);
  }
  return lines;
}

export function createWizardIO(): WizardIO {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return {
    question(prompt: string) {
      return rl.question(prompt);
    },
    print(message: string) {
      process.stdout.write(`${message}\n`);
    },
    close() {
      rl.close();
    },
  };
}

import { describe, test, expect } from "bun:test";
import { CredentialVault, sanitizeEnv } from "../security/vault.js";

describe("CredentialVault", () => {
  test("stores and retrieves credentials by name", () => {
    const vault = new CredentialVault({
      GITHUB_TOKEN: "ghp_abc123",
      ANTHROPIC_API_KEY: "fake-anthropic-key",
    });
    expect(vault.get("GITHUB_TOKEN")).toBe("ghp_abc123");
    expect(vault.get("ANTHROPIC_API_KEY")).toBe("fake-anthropic-key");
    expect(vault.get("NONEXISTENT")).toBeUndefined();
  });

  test("has() checks existence without revealing value", () => {
    const vault = new CredentialVault({ SECRET: "value" });
    expect(vault.has("SECRET")).toBe(true);
    expect(vault.has("NOPE")).toBe(false);
  });

  test("getForAgent returns only declared credentials", () => {
    const vault = new CredentialVault({
      GITHUB_TOKEN: "ghp_abc",
      ANTHROPIC_API_KEY: "fake-anthropic-key",
      DISCORD_BOT_TOKEN: "bot_token",
    });
    const env = vault.getForAgent(["GITHUB_TOKEN"]);
    expect(env.GITHUB_TOKEN).toBe("ghp_abc");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.DISCORD_BOT_TOKEN).toBeUndefined();
  });

  test("getForAgent returns empty object for empty declarations", () => {
    const vault = new CredentialVault({ SECRET: "value" });
    expect(vault.getForAgent([])).toEqual({});
  });

  test("getForAgent skips missing credentials without throwing", () => {
    const vault = new CredentialVault({ A: "1" });
    const env = vault.getForAgent(["A", "MISSING"]);
    expect(env.A).toBe("1");
    expect(env.MISSING).toBeUndefined();
  });
});

describe("sanitizeEnv", () => {
  test("keeps safe environment variables", () => {
    const input = {
      PATH: "/usr/bin",
      HOME: "/home/user",
      LANG: "en_US.UTF-8",
      TERM: "xterm-256color",
      SHELL: "/bin/zsh",
      USER: "jay",
      TMPDIR: "/tmp",
      NODE_ENV: "development",
      BUN_INSTALL: "/home/user/.bun",
    };
    const result = sanitizeEnv(input);
    expect(result).toEqual(input);
  });

  test("strips known sensitive env vars", () => {
    const input = {
      PATH: "/usr/bin",
      HOME: "/home/user",
      ANTHROPIC_API_KEY: "fake-anthropic-key",
      OPENROUTER_API_KEY: "or-secret",
      MINIMAX_API_KEY: "mm-secret",
      DISCORD_BOT_TOKEN: "discord-secret",
      NYX_TELEGRAM_TOKEN: "tg-secret",
      SOME_SECRET_KEY: "also-secret",
    };
    const result = sanitizeEnv(input);
    expect(result.PATH).toBe("/usr/bin");
    expect(result.HOME).toBe("/home/user");
    expect(result.ANTHROPIC_API_KEY).toBeUndefined();
    expect(result.OPENROUTER_API_KEY).toBeUndefined();
    expect(result.MINIMAX_API_KEY).toBeUndefined();
    expect(result.DISCORD_BOT_TOKEN).toBeUndefined();
    expect(result.NYX_TELEGRAM_TOKEN).toBeUndefined();
  });

  test("strips any env var matching sensitive patterns", () => {
    const input = {
      PATH: "/usr/bin",
      MY_API_KEY: "secret1",
      DATABASE_PASSWORD: "secret2",
      AWS_SECRET_ACCESS_KEY: "secret3",
      PRIVATE_TOKEN: "secret4",
      AUTH_TOKEN: "secret5",
    };
    const result = sanitizeEnv(input);
    expect(result.PATH).toBe("/usr/bin");
    expect(result.MY_API_KEY).toBeUndefined();
    expect(result.DATABASE_PASSWORD).toBeUndefined();
    expect(result.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(result.PRIVATE_TOKEN).toBeUndefined();
    expect(result.AUTH_TOKEN).toBeUndefined();
  });
});

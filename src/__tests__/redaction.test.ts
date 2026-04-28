import { describe, it, expect } from "bun:test";
import { redactSecrets, redactForGroup } from "../utils/redaction.js";

const anthropicKey = ["sk", "ant", "abcdefghij1234567890xx"].join("-");
const openAiKey = ["sk", "abcdefghijklmnopqrstuvwxyz123456"].join("-");

describe("redactSecrets", () => {
  it("redacts Anthropic API keys", () => {
    const input = `key is ${anthropicKey}`;
    expect(redactSecrets(input)).toBe("key is [REDACTED_KEY]");
  });

  it("redacts OpenAI-style keys", () => {
    const input = `key is ${openAiKey}`;
    expect(redactSecrets(input)).toBe("key is [REDACTED_KEY]");
  });

  it("redacts AWS access keys", () => {
    const input = "aws key: AKIAIOSFODNN7EXAMPLE";
    expect(redactSecrets(input)).toBe("aws key: [REDACTED_KEY]");
  });

  it("redacts Bearer tokens", () => {
    const input = "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVC.abc123";
    const result = redactSecrets(input);
    expect(result).not.toContain("eyJ");
  });

  it("redacts JWT tokens", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc123def456ghi789";
    expect(redactSecrets(`token: ${jwt}`)).toBe("token: [REDACTED_JWT]");
  });

  it("redacts generic credential assignments", () => {
    const input = "api_key=sk_live_abcdefghij1234567890";
    const result = redactSecrets(input);
    expect(result).toBe("[REDACTED_CREDENTIAL]");
  });

  it("redacts Telegram bot tokens", () => {
    const input = "bot token: 123456789:ABCDEFghijklmnopqrstuvwxyz1234567890a";
    expect(redactSecrets(input)).toContain("[REDACTED_BOT_TOKEN]");
  });

  it("redacts GitHub PATs", () => {
    const input = "token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij12";
    expect(redactSecrets(input)).toContain("[REDACTED_GITHUB_PAT]");
  });

  it("redacts database connection strings", () => {
    const input = "db: postgresql://user:pass@host:5432/mydb";
    expect(redactSecrets(input)).toBe("db: [REDACTED_DB_URL]");
  });

  it("redacts mongodb+srv connection strings", () => {
    const input = "uri: mongodb+srv://user:pass@cluster.mongodb.net/db";
    expect(redactSecrets(input)).toBe("uri: [REDACTED_DB_URL]");
  });

  it("redacts Authorization headers in text", () => {
    const input = "Authorization: Bearer abcdefghijklmnopqrstuvwxyz1234";
    const result = redactSecrets(input);
    expect(result).not.toContain("abcdefghijklmnop");
  });

  it("handles multiple secrets in one string", () => {
    const input = `keys: ${anthropicKey} and AKIAIOSFODNN7EXAMPLE`;
    const result = redactSecrets(input);
    expect(result).not.toContain("sk-ant-");
    expect(result).not.toContain("AKIA");
  });

  it("leaves clean text unchanged", () => {
    const input = "Hello, this is a normal message with no secrets.";
    expect(redactSecrets(input)).toBe(input);
  });

  it("is safe to call multiple times (regex lastIndex reset)", () => {
    const input = `key: ${anthropicKey}`;
    expect(redactSecrets(input)).toBe("key: [REDACTED_KEY]");
    expect(redactSecrets(input)).toBe("key: [REDACTED_KEY]");
  });

  it("redacts exact secret values loaded from environment variables", () => {
    process.env.TEST_DYNAMIC_API_KEY = "dynsecretvalue1234567890";
    try {
      const input = "instances = {'nyxai': {'token': 'dynsecretvalue1234567890'}}";
      const result = redactSecrets(input);
      expect(result).toContain("[REDACTED_ENV_SECRET]");
      expect(result).not.toContain("dynsecretvalue1234567890");
    } finally {
      delete process.env.TEST_DYNAMIC_API_KEY;
    }
  });
});

describe("redactForGroup", () => {
  it("redacts secrets (same as redactSecrets)", () => {
    const input = anthropicKey;
    expect(redactForGroup(input)).toBe("[REDACTED_KEY]");
  });

  it("redacts /Users/ paths", () => {
    const input = "file at /home/user/dev/nyxhive/src/index.ts";
    expect(redactForGroup(input)).toBe("file at [internal-path]");
  });

  it("redacts /home/ paths", () => {
    const input = "config at /home/deploy/.config/app.json";
    expect(redactForGroup(input)).toBe("config at [internal-path]");
  });

  it("does NOT redact paths with redactSecrets alone", () => {
    const input = "path: /home/user/dev/file.ts";
    expect(redactSecrets(input)).toBe(input); // paths not stripped by redactSecrets
  });

  it("handles both secrets and paths together", () => {
    const input = `key ${anthropicKey} at /home/user/.env`;
    const result = redactForGroup(input);
    expect(result).not.toContain("sk-ant-");
    expect(result).not.toContain("/home/user");
  });

  it("is safe to call multiple times", () => {
    const input = "path: /home/user/file.ts";
    expect(redactForGroup(input)).toBe("path: [internal-path]");
    expect(redactForGroup(input)).toBe("path: [internal-path]");
  });
});

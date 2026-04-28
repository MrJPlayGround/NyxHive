import { afterEach, describe, expect, test } from "bun:test";
import { formatApiError, resolveServerApiKey } from "../cli/api-client.js";

const ORIGINAL_ENV = { ...process.env };

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL_ENV)) {
      delete process.env[key];
    }
  }

  for (const [key, value] of Object.entries(ORIGINAL_ENV)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe("resolveServerApiKey", () => {
  test("returns inline api key when configured directly", () => {
    expect(resolveServerApiKey({
      server: { port: 3777, api_key: "direct-key" },
    } as any)).toBe("direct-key");
  });

  test("resolves api key from configured env var", () => {
    process.env.TEST_SERVER_API_KEY = "env-key";
    expect(resolveServerApiKey({
      server: { port: 3777, api_key_env: "TEST_SERVER_API_KEY" },
    } as any)).toBe("env-key");
  });

  test("throws a clear error when api_key_env is configured but missing", () => {
    delete process.env.TEST_SERVER_API_KEY;
    expect(() => resolveServerApiKey({
      server: { port: 3777, api_key_env: "TEST_SERVER_API_KEY" },
    } as any)).toThrow("TEST_SERVER_API_KEY is not set");
  });
});

describe("formatApiError", () => {
  test("preserves structured api errors", () => {
    expect(formatApiError(403, "Forbidden", JSON.stringify({
      error: "No authentication configured. Set server.api_key in config.toml, enable auth, or set NYXHIVE_INSECURE=true.",
    }))).toBe(
      "API error: 403 No authentication configured. Set server.api_key in config.toml, enable auth, or set NYXHIVE_INSECURE=true.",
    );
  });

  test("falls back to status text when the response body is empty", () => {
    expect(formatApiError(401, "Unauthorized", "")).toBe("API error: 401 Unauthorized");
  });
});

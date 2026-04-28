import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pickDefaultInstance, resolveLocalServerApiKey, type InstanceConfig } from "./config.js";

function inst(name: string, port: number): InstanceConfig {
  return { name, port, apiKey: "" };
}

describe("pickDefaultInstance", () => {
  test("prefers nyx/nyxai over legacy aliases", () => {
    const result = pickDefaultInstance([
      inst("Onyx", 3777),
      inst("NyxAI", 3778),
    ]);

    expect(result?.name).toBe("NyxAI");
  });

  test("prefers first direct repo instance over gateway and legacy aliases", () => {
    const result = pickDefaultInstance([
      inst("gateway", 3777),
      inst("Strider", 3778),
      inst("NyxLabs", 3779),
    ], inst("gateway", 3777));

    expect(result?.name).toBe("NyxLabs");
  });

  test("falls back to gateway or first instance when only legacy entries remain", () => {
    expect(pickDefaultInstance([
      inst("Onyx", 3777),
    ])?.name).toBe("Onyx");

    expect(pickDefaultInstance([
      inst("gateway", 3777),
      inst("Strider", 3778),
    ], inst("gateway", 3777))?.name).toBe("gateway");
  });
});

describe("resolveLocalServerApiKey", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  function tempInstanceDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "nyx-config-test-"));
    tempDirs.push(dir);
    return dir;
  }

  test("prefers direct api_key when configured", async () => {
    const dir = tempInstanceDir();

    await expect(resolveLocalServerApiKey({
      api_key: "direct-key",
      api_key_env: "LOCAL_KEY",
    }, dir, { LOCAL_KEY: "env-key" })).resolves.toBe("direct-key");
  });

  test("resolves api_key_env from process env", async () => {
    const dir = tempInstanceDir();

    await expect(resolveLocalServerApiKey({
      api_key_env: "LOCAL_KEY",
    }, dir, { LOCAL_KEY: "env-key" })).resolves.toBe("env-key");
  });

  test("resolves api_key_env from instance env files", async () => {
    const dir = tempInstanceDir();
    writeFileSync(join(dir, ".env"), "LOCAL_KEY=dotenv-key\n");

    await expect(resolveLocalServerApiKey({
      api_key_env: "LOCAL_KEY",
    }, dir, {})).resolves.toBe("dotenv-key");
  });

  test("uses .env before env for instance env files", async () => {
    const dir = tempInstanceDir();
    writeFileSync(join(dir, ".env"), "LOCAL_KEY=dotenv-key\n");
    writeFileSync(join(dir, "env"), "LOCAL_KEY=env-file-key\n");

    await expect(resolveLocalServerApiKey({
      api_key_env: "LOCAL_KEY",
    }, dir, {})).resolves.toBe("dotenv-key");
  });
});

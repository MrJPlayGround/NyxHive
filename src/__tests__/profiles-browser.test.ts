import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getActiveProfileName,
  listProfiles,
  readProfile,
} from "../nyx-workspace/src/server/profiles-browser";

describe("profiles browser", () => {
  let tempDir: string;
  let originalHome: string | undefined;
  let originalNyxHiveHome: string | undefined;
  let originalWorkspaceApiUrl: string | undefined;
  let originalApiUrl: string | undefined;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "profiles-browser-"));
    originalHome = process.env.HOME;
    originalNyxHiveHome = process.env.NYXHIVE_HOME;
    originalWorkspaceApiUrl = process.env.NYX_WORKSPACE_API_URL;
    originalApiUrl = process.env.NYX_API_URL;

    process.env.HOME = join(tempDir, "home");
    process.env.NYXHIVE_HOME = join(tempDir, "legacy-home");
    process.env.NYX_WORKSPACE_API_URL = "http://localhost:3779";
    delete process.env.NYX_API_URL;

    mkdirSync(join(process.env.HOME, ".nyxhive"), { recursive: true });
    mkdirSync(process.env.NYXHIVE_HOME, { recursive: true });
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;

    if (originalNyxHiveHome === undefined) delete process.env.NYXHIVE_HOME;
    else process.env.NYXHIVE_HOME = originalNyxHiveHome;

    if (originalWorkspaceApiUrl === undefined)
      delete process.env.NYX_WORKSPACE_API_URL;
    else process.env.NYX_WORKSPACE_API_URL = originalWorkspaceApiUrl;

    if (originalApiUrl === undefined) delete process.env.NYX_API_URL;
    else process.env.NYX_API_URL = originalApiUrl;

    rmSync(tempDir, { recursive: true, force: true });
  });

  test("lists bookmarked workspace instances and infers the active profile by port", () => {
    const instancePath = join(tempDir, "workspace", ".nyxhive");
    mkdirSync(join(instancePath, "data"), { recursive: true });
    writeFileSync(
      join(instancePath, "config.toml"),
      [
        "[daemon]",
        'name = "NyxAI"',
        'data_dir = "data"',
        "",
        "[server]",
        "port = 3779",
        "",
        "[agents.nyx]",
        'name = "Nyx"',
        'role = "lead"',
        'provider = "openai"',
        'model = "gpt-5.2"',
      ].join("\n"),
    );
    writeFileSync(
      join(process.env.HOME!, ".nyxhive", "bookmarks.json"),
      `${JSON.stringify({
        bookmarks: [{ name: "NyxAI", path: instancePath, port: 3779 }],
      })}\n`,
    );

    const profiles = listProfiles();
    const profile = profiles.find((candidate) => candidate.instanceName === "NyxAI");

    expect(getActiveProfileName()).toBe("Nyx");
    expect(profile).toMatchObject({
      name: "Nyx",
      path: instancePath,
      active: true,
      exists: true,
      source: "instance",
      instanceName: "NyxAI",
      provider: "openai",
      model: "gpt-5.2",
      agentCount: 1,
      hasEnv: false,
    });
    expect(readProfile("NyxAI")).toMatchObject({
      name: "Nyx",
      path: instancePath,
      active: true,
      hasEnv: false,
    });
  });

  test("lists registered agent workspaces as instance profiles", () => {
    const workspaceRoot = join(tempDir, "astra-trading");
    const workspaceHome = join(workspaceRoot, ".nyxhive");
    mkdirSync(join(workspaceHome, "data"), { recursive: true });
    writeFileSync(
      join(process.env.HOME!, ".nyxhive", "workspaces.toml"),
      [
        "[[workspaces]]",
        'id = "astra-trading"',
        `path = "${workspaceRoot}"`,
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(workspaceHome, "workspace.toml"),
      [
        'id = "astra-trading"',
        'kind = "agent"',
        'display_name = "Astra Trading"',
        'aliases = ["astra", "trading"]',
        "",
        "[runtime]",
        'instance_id = "astra-trading"',
        'data_namespace = "astra-trading"',
        'config = ".nyxhive/config.toml"',
        'api_url = "http://127.0.0.1:3782"',
        'api_key_env = "ASTRA_TRADING_API_KEY"',
        "app_port = 3783",
        'app_host = "127.0.0.1"',
        'agent_name = "Astra"',
        'agents = ["astra"]',
      ].join("\n"),
    );
    writeFileSync(
      join(workspaceHome, "config.toml"),
      [
        "[daemon]",
        'name = "Astra Trading"',
        'data_dir = "./data"',
        "",
        "[server]",
        "port = 3782",
        "",
        "[agents.astra]",
        'name = "Astra"',
        'role = "lead"',
        'provider = "openai"',
        'model = "gpt-5.5"',
      ].join("\n"),
    );

    process.env.NYX_WORKSPACE_API_URL = "http://127.0.0.1:3782";

    const profiles = listProfiles();
    const profile = profiles.find(
      (candidate) => candidate.instanceName === "Astra Trading",
    );

    expect(getActiveProfileName()).toBe("Astra");
    expect(profile).toMatchObject({
      name: "Astra",
      path: workspaceHome,
      active: true,
      exists: true,
      source: "instance",
      instanceName: "Astra Trading",
      provider: "openai",
      model: "gpt-5.5",
      agentCount: 1,
      hasEnv: false,
    });
    expect(readProfile("astra")).toMatchObject({
      name: "Astra",
      path: workspaceHome,
      active: true,
      hasEnv: false,
    });
  });
});

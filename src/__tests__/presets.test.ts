import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compileSoulV2 } from "../soul/compiler-v2.js";
import { loadStandaloneSoulV2Directory } from "../soul/loader-v2.js";
import { validateComposedSoul } from "../soul/validator.js";
import {
  applyPresetToInstance,
  ejectPresetForInstance,
  getPresetCatalog,
  handlePresets,
} from "../cli/presets.js";
import { getPresetSoulDir } from "../presets.js";
import { logger } from "../utils/logger.js";

const TEST_ROOT = join(tmpdir(), `nyxhive-presets-${Date.now()}`);

function writeConfig(instanceDir: string, body: string): string {
  const configPath = join(instanceDir, "config.toml");
  writeFileSync(configPath, body, "utf-8");
  return configPath;
}

describe("soul presets", () => {
  beforeEach(() => {
    mkdirSync(TEST_ROOT, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_ROOT, { recursive: true, force: true });
    mock.restore();
  });

  test("all built-in presets compile through the soul compiler", () => {
    for (const preset of getPresetCatalog()) {
      const loaded = loadStandaloneSoulV2Directory(getPresetSoulDir(preset.name));
      const soul = compileSoulV2(loaded);
      const validation = validateComposedSoul(soul);

      expect(validation.valid).toBe(true);
      expect(soul.identity.name.length).toBeGreaterThan(0);
      expect(existsSync(join(getPresetSoulDir(preset.name), "identity.md"))).toBe(true);
    }
  });

  test("preset list shows all presets with descriptions", async () => {
    const infoSpy = spyOn(logger, "info").mockImplementation(() => {});

    await handlePresets(["list"]);

    const output = infoSpy.mock.calls.map((call) => String(call[0])).join("\n");
    for (const preset of getPresetCatalog()) {
      expect(output).toContain(preset.name);
      expect(output).toContain(preset.description);
    }
  });

  test("applyPresetToInstance copies preset files into the instance souls directory", () => {
    const instanceDir = join(TEST_ROOT, "instance-apply");
    mkdirSync(join(instanceDir, "souls"), { recursive: true });

    const state = applyPresetToInstance({
      presetName: "coder",
      instanceDir,
      agentKey: "assistant",
    });

    expect(state.name).toBe("coder");
    expect(state.agent).toBe("assistant");
    expect(existsSync(join(instanceDir, "souls", "presets", "coder", "identity.md"))).toBe(true);
    expect(existsSync(join(instanceDir, "souls", "presets", "coder", "personality.md"))).toBe(true);

    const stateRaw = JSON.parse(readFileSync(join(instanceDir, "souls", "preset.json"), "utf-8")) as {
      name: string;
      agent: string;
    };
    expect(stateRaw.name).toBe("coder");
    expect(stateRaw.agent).toBe("assistant");
  });

  test("preset apply command resolves an instance and copies the requested preset", async () => {
    const instanceDir = join(TEST_ROOT, "instance-cli-apply");
    mkdirSync(join(instanceDir, "souls"), { recursive: true });
    const configPath = writeConfig(instanceDir, `
[daemon]
name = "Preset Test"

[server]
port = 3810

[agents.assistant]
name = "Assistant"
provider = "anthropic"
model = "claude-sonnet-4-6"
working_directory = "./workspace"

[providers.anthropic]
api_key_env = "ANTHROPIC_API_KEY"

[routing]
classifier_model = "claude-haiku"
classifier_provider = "anthropic"
cli_escalation_tasks = ["coding"]

[context]
max_history = 10
summary_threshold = 8
history_budget_ratio = 0.5
`);

    spyOn(logger, "info").mockImplementation(() => {});

    await handlePresets(["apply", "coder", "--config", configPath]);

    expect(existsSync(join(instanceDir, "souls", "presets", "coder", "identity.md"))).toBe(true);
  });

  test("preset eject copies the active preset into an editable custom directory", () => {
    const instanceDir = join(TEST_ROOT, "instance-eject");
    mkdirSync(join(instanceDir, "souls"), { recursive: true });
    applyPresetToInstance({
      presetName: "ops",
      instanceDir,
      agentKey: "sentinel",
    });

    const result = ejectPresetForInstance({ instanceDir });

    expect(result.state.name).toBe("ops");
    expect(existsSync(join(instanceDir, "souls", "custom", "identity.md"))).toBe(true);
    expect(readFileSync(join(instanceDir, "souls", "custom", "identity.md"), "utf-8")).toContain("Ops");
  });
});

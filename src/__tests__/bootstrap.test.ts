import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { bootstrapLocal, buildBootstrapPlan } from "../cli/bootstrap.js";

describe("bootstrapLocal", () => {
  let tmpDir: string;
  let sourceRepo: string;
  let targetDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nyxhive-bootstrap-"));
    sourceRepo = join(tmpDir, "source");
    targetDir = join(tmpDir, "target");

    mkdirSync(join(sourceRepo, ".nyxhive"), { recursive: true });
    mkdirSync(join(sourceRepo, "src"), { recursive: true });
    writeFileSync(join(sourceRepo, "package.json"), JSON.stringify({ name: "nyxhive-test" }, null, 2));
    writeFileSync(join(sourceRepo, "bun.lock"), "");
    writeFileSync(join(sourceRepo, "src", "index.ts"), "console.log('hi');\n");
    writeFileSync(join(sourceRepo, ".env"), "NYX_API_KEY=test\n");
    writeFileSync(join(sourceRepo, ".nyxhive", "config.toml"), `
[daemon]
name = "NyxAI"
log_level = "info"
data_dir = "./data"

[server]
port = 3777

[routing]
classifier_model = "test"
classifier_provider = "test"
cli_escalation_tasks = []

[context]
max_history = 20
summary_threshold = 10

[providers.test]
default_model = "test"

[agents.nyx]
name = "Nyx"
provider = "test"
model = "test"
working_directory = "./workspace/nyx"
`);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("builds a portable bootstrap plan from repo-local config", () => {
    const plan = buildBootstrapPlan({
      repoSource: sourceRepo,
      configPath: join(sourceRepo, ".nyxhive", "config.toml"),
      targetDir,
    });

    expect(plan.instanceName).toBe("NyxAI");
    expect(plan.targetConfigPath).toBe(join(targetDir, ".nyxhive", "config.toml"));
    expect(plan.targetEnvPath).toBe(join(targetDir, ".env"));
    expect(plan.steps).toContain("repo");
    expect(plan.steps).toContain("config");
    expect(plan.steps).toContain("dependencies");
  });

  test("dry run does not modify the target directory", async () => {
    const result = await bootstrapLocal({
      repoSource: sourceRepo,
      configPath: join(sourceRepo, ".nyxhive", "config.toml"),
      targetDir,
      dryRun: true,
    });

    expect(result.success).toBe(true);
    expect(existsSync(targetDir)).toBe(false);
    expect(result.steps).toEqual(result.plan.steps);
  });
});

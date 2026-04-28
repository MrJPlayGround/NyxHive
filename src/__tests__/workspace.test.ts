import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { ensureWorkspace } from "../agents/workspace.js";
import type { AgentConfig, NyxHiveConfig } from "../types.js";

function makeConfig(tmpDir: string): { config: NyxHiveConfig; agent: AgentConfig } {
  const workingDir = join(tmpDir, "workspace/testbot");
  const agent: AgentConfig = {
    name: "TestBot",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    working_directory: workingDir,
    system_prompt: "You are TestBot.",
  } as AgentConfig;
  const config = {
    daemon: { name: "TestHive", log_level: "error" as const, data_dir: tmpDir },
    server: { port: 3777 },
    agents: { testbot: agent },
    providers: {},
    routing: { classifier_model: "test", classifier_provider: "test", cli_escalation_tasks: [] },
    context: { max_history: 100, summary_threshold: 20 },
  } as NyxHiveConfig;
  return { config, agent };
}

describe("ensureWorkspace", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nyxhive-workspace-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("generates PLATFORM.md", () => {
    const { config, agent } = makeConfig(tmpDir);
    ensureWorkspace(agent, tmpDir, config, "testbot");

    const platformFile = join(agent.working_directory, "PLATFORM.md");
    expect(existsSync(platformFile)).toBe(true);
    const content = readFileSync(platformFile, "utf-8");
    expect(content).toContain("TestHive Platform");
    expect(content).toContain("TestBot");
  });

  test("appends RUNBOOK.md content to PLATFORM.md when it exists", () => {
    const { config, agent } = makeConfig(tmpDir);

    // First call creates the workspace
    ensureWorkspace(agent, tmpDir, config, "testbot");

    // Create a RUNBOOK.md in the workspace
    const runbookFile = join(agent.working_directory, "RUNBOOK.md");
    writeFileSync(runbookFile, "\n## Custom Runbook\n\nThis is persistent agent documentation.\n");

    // Second call should append RUNBOOK.md content
    ensureWorkspace(agent, tmpDir, config, "testbot");

    const platformFile = join(agent.working_directory, "PLATFORM.md");
    const content = readFileSync(platformFile, "utf-8");
    expect(content).toContain("TestHive Platform");
    expect(content).toContain("## Custom Runbook");
    expect(content).toContain("persistent agent documentation");
  });

  test("PLATFORM.md works without RUNBOOK.md", () => {
    const { config, agent } = makeConfig(tmpDir);
    ensureWorkspace(agent, tmpDir, config, "testbot");

    const platformFile = join(agent.working_directory, "PLATFORM.md");
    const content = readFileSync(platformFile, "utf-8");
    expect(content).toContain("TestHive Platform");
    expect(content).not.toContain("Runbook");
  });

  test("resolves relative working_directory at runtime", () => {
    const { config, agent } = makeConfig(tmpDir);
    agent.working_directory = "./workspace/testbot";
    config.agents.testbot = agent;

    ensureWorkspace(agent, tmpDir, config, "testbot");

    const platformFile = join(tmpDir, "workspace/testbot", "PLATFORM.md");
    expect(existsSync(platformFile)).toBe(true);
  });

  test("generates Claude Stop hook with repo typecheck script", () => {
    const { config, agent } = makeConfig(tmpDir);
    agent.capabilities = ["tool_use"];
    agent.cli_fallback = "claude";
    config.agents.testbot = agent;

    ensureWorkspace(agent, tmpDir, config, "testbot");

    const settingsFile = join(agent.working_directory, ".claude/settings.json");
    const settings = readFileSync(settingsFile, "utf-8");
    expect(settings).toContain("bun run typecheck");
    expect(settings).not.toContain("bun tsc --noEmit");
  });

  test("writes strict agentic contract to AGENTS.md for strict agents", () => {
    const { config, agent } = makeConfig(tmpDir);
    agent.agentic_mode = "strict";
    config.agents.testbot = agent;

    ensureWorkspace(agent, tmpDir, config, "testbot");

    const agentsFile = join(agent.working_directory, "AGENTS.md");
    const content = readFileSync(agentsFile, "utf-8");
    expect(content).toContain("[Strict agentic mode]");
    expect(content).toContain("Use the Codex CLI/harness path");
  });

  test("writes self-restart guidance for non-interactive harness agents", () => {
    const { config, agent } = makeConfig(tmpDir);
    config.agents.testbot = agent;

    ensureWorkspace(agent, tmpDir, config, "testbot");

    const agentsFile = join(agent.working_directory, "AGENTS.md");
    const content = readFileSync(agentsFile, "utf-8");
    expect(content).toContain("If asked to restart the current NyxHive instance itself");
    expect(content).toContain("./scripts/restart-instance.sh --self");
    expect(content).toContain("Do not run an inline restart command that would kill your own active turn");
  });
});

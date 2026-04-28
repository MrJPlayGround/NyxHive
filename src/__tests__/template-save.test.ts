import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { saveInstanceAsTemplate, findNextAvailablePort } from "../cli/template-save.js";
import { loadTemplate, resolveTemplatePath, listTemplates } from "../templates/loader.js";
import TOML from "@iarna/toml";

// --- Built-in template validation ---

describe("Built-in Templates", () => {
  test("default template loads and validates", () => {
    const path = resolveTemplatePath("default");
    expect(path).not.toBeNull();
    const template = loadTemplate("default");
    expect(template.id).toBe("default");
    expect(template.config.agents).toHaveLength(1);
    const roles = template.config.agents.map(a => a.role);
    expect(roles).toContain("lead");
  });

  test("full template loads and validates", () => {
    const path = resolveTemplatePath("full");
    expect(path).not.toBeNull();
    const template = loadTemplate("full");
    expect(template.id).toBe("full");
    expect(template.config.agents.length).toBeGreaterThanOrEqual(4);
    const roles = template.config.agents.map(a => a.role);
    expect(roles).toContain("lead");
    expect(roles).toContain("reviewer");
    expect(roles).toContain("expert");
    expect(roles).toContain("heartbeat");
  });

  test("full template has routing overrides", () => {
    const template = loadTemplate("full");
    expect(template.config.routing).toBeDefined();
    expect(template.config.routing!.coding).toBeDefined();
  });

  test("full template has budget", () => {
    const template = loadTemplate("full");
    expect(template.config.budget).toBeDefined();
    expect(template.config.budget!.monthly_limit).toBe(100);
  });

  test("full template has scheduler", () => {
    const template = loadTemplate("full");
    expect(template.config.scheduler).toBeDefined();
    expect(template.config.scheduler!.length).toBeGreaterThan(0);
  });

  test("retired orchestrator template is no longer exposed", () => {
    const path = resolveTemplatePath("orchestrator");
    expect(path).toBeNull();
    expect(() => loadTemplate("orchestrator")).toThrow("Template not found");
  });

  test("listTemplates includes default and full", () => {
    const templates = listTemplates();
    const ids = templates.map(t => t.id);
    expect(ids).toContain("default");
    expect(ids).toContain("full");
    expect(ids).toContain("acme-engineering");
  });
});

// --- Template save ---

describe("saveInstanceAsTemplate", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nyxhive-tpl-save-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function createMockInstance(instDir: string, config: Record<string, unknown>, theme?: Record<string, unknown>) {
    mkdirSync(instDir, { recursive: true });
    mkdirSync(join(instDir, "config"), { recursive: true });
    writeFileSync(join(instDir, "config.toml"), TOML.stringify(JSON.parse(JSON.stringify(config))));
    if (theme) {
      writeFileSync(join(instDir, "config", "theme.json"), JSON.stringify(theme));
    }
  }

  test("saves minimal instance as template", () => {
    const instDir = join(tmpDir, "my-instance");
    const outputDir = join(tmpDir, "output");
    createMockInstance(instDir, {
      daemon: { name: "TestApp", log_level: "info", data_dir: "./data" },
      server: { port: 3777 },
      agents: {
        nyx: {
          name: "Nyx",
          role: "orchestrator",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          working_directory: "./workspace",
          system_prompt: "You are an orchestrator agent.",
        },
      },
      providers: { anthropic: { api_key_env: "ANTHROPIC_API_KEY" } },
      routing: { classifier_model: "test", classifier_provider: "anthropic", cli_escalation_tasks: ["coding"] },
      context: { max_history: 10, summary_threshold: 20 },
    });

    const { templateDir, template } = saveInstanceAsTemplate({
      name: "test-save",
      instanceDir: instDir,
      outputDir,
    });

    expect(template.id).toBe("test-save");
    expect(template.name).toBe("TestApp");
    expect(template.config.agents).toHaveLength(1);
    expect(template.config.agents[0].key).toBe("nyx");
    expect(template.config.agents[0].role).toBe("orchestrator");
    expect(existsSync(join(templateDir, "template.json"))).toBe(true);

    // Verify it can be loaded back
    const loaded = loadTemplate(templateDir);
    expect(loaded.id).toBe("test-save");
  });

  test("saves instance with theme", () => {
    const instDir = join(tmpDir, "themed-instance");
    const outputDir = join(tmpDir, "output");
    createMockInstance(
      instDir,
      {
        daemon: { name: "Themed", log_level: "info", data_dir: "./data" },
        server: { port: 3778 },
        agents: {
          bot: {
            name: "Bot",
            role: "worker",
            provider: "openrouter",
            model: "test-model",
            working_directory: "./workspace",
            system_prompt: "You are a worker bot.",
          },
        },
        providers: { openrouter: { api_key_env: "OPENROUTER_API_KEY" } },
        routing: { classifier_model: "test", classifier_provider: "openrouter", cli_escalation_tasks: [] },
        context: { max_history: 10, summary_threshold: 20 },
      },
      {
        accentColor: "#FF5722",
        appearanceMode: "dark",
        appName: "ThemeTest",
        tagline: "Custom theme",
        tabs: { chat: true, agents: false, dashboard: false, settings: true },
        chatPlaceholder: "Ask me...",
        emptyStateMessage: "Hello!",
      },
    );

    const { template } = saveInstanceAsTemplate({
      name: "themed-tpl",
      instanceDir: instDir,
      outputDir,
    });

    expect(template.theme.accentColor).toBe("#FF5722");
    expect(template.theme.appearanceMode).toBe("dark");
    expect(template.theme.appName).toBe("ThemeTest");
    expect(template.theme.tabs.agents).toBe(false);
    expect(template.theme.tabs.dashboard).toBe(false);
  });

  test("saves instance with budget and routing", () => {
    const instDir = join(tmpDir, "full-instance");
    const outputDir = join(tmpDir, "output");
    createMockInstance(instDir, {
      daemon: { name: "Full", log_level: "info", data_dir: "./data" },
      server: { port: 3779 },
      agents: {
        nyx: {
          name: "Nyx",
          role: "orchestrator",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          working_directory: "./workspace",
          system_prompt: "You are the orchestrator.",
          always_cli: true,
        },
        forge: {
          name: "Forge",
          role: "coder",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          working_directory: "./workspace",
          system_prompt: "You are the coder agent.",
          capabilities: ["code_execution"],
        },
      },
      providers: { anthropic: { api_key_env: "ANTHROPIC_API_KEY" } },
      routing: {
        classifier_model: "test",
        classifier_provider: "anthropic",
        cli_escalation_tasks: ["coding"],
        overrides: {
          coding: { provider: "anthropic", model: "claude-sonnet-4-6" },
        },
      },
      budget: { monthly_limit: 75, warning_threshold: 0.9 },
      context: { max_history: 10, summary_threshold: 20 },
    });

    const { template } = saveInstanceAsTemplate({
      name: "full-save",
      instanceDir: instDir,
      outputDir,
    });

    expect(template.config.agents).toHaveLength(2);
    expect(template.config.agents[0].always_cli).toBe(true);
    expect(template.config.agents[1].capabilities).toContain("code_execution");
    expect(template.config.routing).toBeDefined();
    expect(template.config.routing!.coding).toBeDefined();
    expect(template.config.budget!.monthly_limit).toBe(75);
    expect(template.config.budget!.warning_threshold).toBe(0.9);
    expect(template.category).toBe("development");
  });

  test("saves instance with scheduler", () => {
    const instDir = join(tmpDir, "sched-instance");
    const outputDir = join(tmpDir, "output");
    createMockInstance(instDir, {
      daemon: { name: "Sched", log_level: "info", data_dir: "./data" },
      server: { port: 3780 },
      agents: {
        nyx: {
          name: "Nyx",
          role: "orchestrator",
          provider: "anthropic",
          model: "test",
          working_directory: "./workspace",
          system_prompt: "You are the orchestrator.",
        },
      },
      providers: { anthropic: { api_key_env: "KEY" } },
      routing: { classifier_model: "test", classifier_provider: "anthropic", cli_escalation_tasks: [] },
      context: { max_history: 10, summary_threshold: 20 },
      scheduler: {
        enabled: true,
        tasks: [
          { name: "daily-check", cron: "0 8 * * *", agent: "nyx", prompt: "Run health check", channel: "api" },
        ],
      },
    });

    const { template } = saveInstanceAsTemplate({
      name: "sched-tpl",
      instanceDir: instDir,
      outputDir,
    });

    expect(template.config.scheduler).toBeDefined();
    expect(template.config.scheduler!).toHaveLength(1);
    expect(template.config.scheduler![0].name).toBe("daily-check");
    expect(template.config.scheduler![0].schedule).toBe("0 8 * * *");
  });

  test("saves instance with vault/knowledge", () => {
    const instDir = join(tmpDir, "vault-instance");
    const outputDir = join(tmpDir, "output");
    createMockInstance(instDir, {
      daemon: { name: "VaultApp", log_level: "info", data_dir: "./data" },
      server: { port: 3781 },
      agents: {
        bot: {
          name: "Bot",
          role: "worker",
          provider: "anthropic",
          model: "test",
          working_directory: "./workspace",
          system_prompt: "You are a worker bot.",
        },
      },
      providers: { anthropic: { api_key_env: "KEY" } },
      routing: { classifier_model: "test", classifier_provider: "anthropic", cli_escalation_tasks: [] },
      context: { max_history: 10, summary_threshold: 20 },
      vault: { path: "/some/vault/path", skip_dirs: ["Archive/**"] },
    });

    const { template } = saveInstanceAsTemplate({
      name: "vault-tpl",
      instanceDir: instDir,
      outputDir,
    });

    expect(template.knowledge).toBeDefined();
    expect(template.knowledge!.vault_path).toBe("/some/vault/path");
    expect(template.knowledge!.exclude).toContain("Archive/**");
  });

  test("rejects invalid template name", () => {
    const instDir = join(tmpDir, "inst");
    createMockInstance(instDir, {
      daemon: { name: "Test", log_level: "info", data_dir: "./data" },
      server: { port: 3777 },
      agents: {
        nyx: {
          name: "Nyx",
          role: "orchestrator",
          provider: "anthropic",
          model: "test",
          working_directory: "./workspace",
          system_prompt: "You are the orchestrator.",
        },
      },
      providers: { anthropic: { api_key_env: "KEY" } },
      routing: { classifier_model: "test", classifier_provider: "anthropic", cli_escalation_tasks: [] },
      context: { max_history: 10, summary_threshold: 20 },
    });

    expect(() => saveInstanceAsTemplate({
      name: "Invalid Name",
      instanceDir: instDir,
      outputDir: join(tmpDir, "out"),
    })).toThrow("Invalid template name");
  });

  test("throws if config.toml missing", () => {
    const instDir = join(tmpDir, "empty-dir");
    mkdirSync(instDir, { recursive: true });

    expect(() => saveInstanceAsTemplate({
      name: "no-config",
      instanceDir: instDir,
      outputDir: join(tmpDir, "out"),
    })).toThrow("Config not found");
  });

  test("throws if instance has no agents", () => {
    const instDir = join(tmpDir, "no-agents");
    createMockInstance(instDir, {
      daemon: { name: "Empty", log_level: "info", data_dir: "./data" },
      server: { port: 3777 },
      agents: {},
      providers: { anthropic: { api_key_env: "KEY" } },
      routing: { classifier_model: "test", classifier_provider: "anthropic", cli_escalation_tasks: [] },
      context: { max_history: 10, summary_threshold: 20 },
    });

    expect(() => saveInstanceAsTemplate({
      name: "no-agents",
      instanceDir: instDir,
      outputDir: join(tmpDir, "out"),
    })).toThrow("no agents");
  });
});

// --- Auto port allocation ---

describe("findNextAvailablePort", () => {
  test("returns base port when no ports are used", () => {
    expect(findNextAvailablePort([])).toBe(3777);
  });

  test("returns base port when used ports don't conflict", () => {
    expect(findNextAvailablePort([8080, 9090])).toBe(3777);
  });

  test("skips used port", () => {
    expect(findNextAvailablePort([3777])).toBe(3778);
  });

  test("skips multiple consecutive used ports", () => {
    expect(findNextAvailablePort([3777, 3778, 3779])).toBe(3780);
  });

  test("handles gaps in used ports", () => {
    expect(findNextAvailablePort([3777, 3779])).toBe(3778);
  });

  test("respects custom base port", () => {
    expect(findNextAvailablePort([], 4000)).toBe(4000);
    expect(findNextAvailablePort([4000, 4001], 4000)).toBe(4002);
  });
});

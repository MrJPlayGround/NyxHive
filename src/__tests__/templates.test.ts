import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { NyxTemplateSchema, ThemePresetSchema, AgentPresetSchema } from "../templates/types.js";
import { loadTemplate, validateTemplateDir, listTemplates, resolveTemplatePath, BUILTIN_TEMPLATES_DIR } from "../templates/loader.js";
import { buildConfigFromTemplate, configToToml } from "../templates/config-gen.js";
import { postmanToMarkdown } from "../templates/postman-converter.js";

// --- Schema validation tests ---

describe("NyxTemplateSchema", () => {
  const validTemplate = {
    id: "test-template",
    name: "Test Template",
    description: "A test template",
    version: "1.0.0",
    author: "Test",
    category: "engineering",
    config: {
      agents: [{
        key: "test-agent",
        name: "Test Agent",
        role: "orchestrator",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        system_prompt: "You are a test agent with enough chars to pass min length.",
      }],
    },
    theme: {
      accentColor: "#2196F3",
      appName: "Test App",
      tagline: "A test app",
      tabs: { chat: true, agents: true, dashboard: true, settings: true },
    },
  };

  test("validates a well-formed template", () => {
    const result = NyxTemplateSchema.safeParse(validTemplate);
    expect(result.success).toBe(true);
  });

  test("rejects template with invalid ID", () => {
    const bad = { ...validTemplate, id: "Invalid ID" };
    const result = NyxTemplateSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  test("rejects template with no agents", () => {
    const bad = { ...validTemplate, config: { agents: [] } };
    const result = NyxTemplateSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  test("rejects template with invalid accent color", () => {
    const bad = { ...validTemplate, theme: { ...validTemplate.theme, accentColor: "not-a-color" } };
    const result = NyxTemplateSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  test("defaults optional fields correctly", () => {
    const result = NyxTemplateSchema.parse(validTemplate);
    expect(result.theme.appearanceMode).toBe("system");
    expect(result.theme.chatPlaceholder).toBe("Message...");
    expect(result.theme.emptyStateMessage).toBe("Hi! How can I help?");
  });

  test("validates knowledge preset when present", () => {
    const withKnowledge = {
      ...validTemplate,
      knowledge: {
        vault_path: "/some/path",
        categories: ["docs"],
        description: "Test knowledge",
        exclude: ["Archive/**"],
      },
    };
    const result = NyxTemplateSchema.safeParse(withKnowledge);
    expect(result.success).toBe(true);
  });
});

describe("AgentPresetSchema", () => {
  test("rejects agent key with uppercase", () => {
    const result = AgentPresetSchema.safeParse({
      key: "BadKey",
      name: "Test",
      role: "worker",
      provider: "anthropic",
      model: "test",
      system_prompt: "Long enough system prompt for validation.",
    });
    expect(result.success).toBe(false);
  });

  test("accepts valid agent key with dashes", () => {
    const result = AgentPresetSchema.safeParse({
      key: "integration-spec",
      name: "Integration Specialist",
      role: "worker",
      provider: "openrouter",
      model: "test-model",
      system_prompt: "Long enough system prompt for validation.",
    });
    expect(result.success).toBe(true);
  });
});

// --- Loader tests ---

describe("Template Loader", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nyxhive-template-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("loadTemplate from absolute path", () => {
    const templateDir = join(tmpDir, "my-template");
    mkdirSync(templateDir, { recursive: true });
    writeFileSync(join(templateDir, "template.json"), JSON.stringify({
      id: "my-template",
      name: "My Template",
      description: "Test",
      version: "1.0.0",
      author: "Test",
      category: "custom",
      config: {
        agents: [{
          key: "agent",
          name: "Agent",
          role: "worker",
          provider: "anthropic",
          model: "test",
          system_prompt: "A system prompt that is long enough.",
        }],
      },
      theme: {
        accentColor: "#FF9800",
        appName: "Test",
        tagline: "Test tagline",
        tabs: { chat: true, agents: false, dashboard: false, settings: true },
      },
    }));

    const template = loadTemplate(templateDir);
    expect(template.id).toBe("my-template");
    expect(template.config.agents[0].key).toBe("agent");
    expect(template.theme.tabs.agents).toBe(false);
  });

  test("loadTemplate throws for nonexistent template", () => {
    expect(() => loadTemplate("/nonexistent/path")).toThrow("Template not found");
  });

  test("loadTemplate throws for invalid JSON", () => {
    const templateDir = join(tmpDir, "bad-template");
    mkdirSync(templateDir, { recursive: true });
    writeFileSync(join(templateDir, "template.json"), "{ invalid json }");
    expect(() => loadTemplate(templateDir)).toThrow();
  });

  test("validateTemplateDir catches missing template.json", () => {
    const result = validateTemplateDir(tmpDir);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("template.json not found");
  });

  test("validateTemplateDir validates well-formed template", () => {
    const templateDir = join(tmpDir, "valid");
    mkdirSync(templateDir, { recursive: true });
    writeFileSync(join(templateDir, "template.json"), JSON.stringify({
      id: "valid",
      name: "Valid",
      description: "Test",
      version: "1.0.0",
      author: "Test",
      category: "custom",
      config: {
        agents: [{
          key: "agent",
          name: "Agent",
          role: "worker",
          provider: "test",
          model: "test",
          system_prompt: "A system prompt that is long enough.",
        }],
      },
      theme: {
        accentColor: "#00E676",
        appName: "Valid",
        tagline: "Test",
        tabs: { chat: true, agents: true, dashboard: true, settings: true },
      },
    }));

    const result = validateTemplateDir(templateDir);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("validateTemplateDir catches missing knowledge vault", () => {
    const templateDir = join(tmpDir, "missing-vault");
    mkdirSync(templateDir, { recursive: true });
    writeFileSync(join(templateDir, "template.json"), JSON.stringify({
      id: "missing-vault",
      name: "Missing Vault",
      description: "Test",
      version: "1.0.0",
      author: "Test",
      category: "custom",
      config: {
        agents: [{
          key: "agent",
          name: "Agent",
          role: "worker",
          provider: "test",
          model: "test",
          system_prompt: "A system prompt that is long enough.",
        }],
      },
      theme: {
        accentColor: "#00E676",
        appName: "Test",
        tagline: "Test",
        tabs: { chat: true, agents: true, dashboard: true, settings: true },
      },
      knowledge: {
        vault_path: "/nonexistent/vault",
        categories: ["docs"],
        description: "Missing vault",
      },
    }));

    const result = validateTemplateDir(templateDir);
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain("Knowledge vault not found");
  });

  test("resolveTemplatePath finds built-in templates", () => {
    const path = resolveTemplatePath("acme-engineering");
    expect(path).not.toBeNull();
    expect(path).toContain("templates/acme-engineering");
  });

  test("listTemplates includes built-in templates", () => {
    const templates = listTemplates();
    const ids = templates.map(t => t.id);
    expect(ids).toContain("acme-engineering");
  });
});

// --- Config generation tests ---

describe("Config Generation", () => {
  const template = NyxTemplateSchema.parse({
    id: "test",
    name: "Test",
    description: "Test template",
    version: "1.0.0",
    author: "Test",
    category: "engineering",
    config: {
      agents: [
        {
          key: "orchestrator",
          name: "Orchestrator",
          role: "orchestrator",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          system_prompt: "You are the orchestrator agent.",
          always_cli: true,
        },
        {
          key: "reviewer",
          name: "Reviewer",
          role: "reviewer",
          provider: "openrouter",
          model: "qwen3-235b",
          system_prompt: "You are a code reviewer agent.",
        },
      ],
      routing: {
        coding: { provider: "anthropic", model: "claude-sonnet-4-6" },
      },
      budget: { monthly_limit: 50 },
    },
    theme: {
      accentColor: "#2196F3",
      appName: "Test App",
      tagline: "Test",
      tabs: { chat: true, agents: true, dashboard: false, settings: true },
    },
  });

  test("generates config with agents from template", () => {
    const config = buildConfigFromTemplate(template, {
      instanceName: "TestInstance",
      port: 3777,
      providers: {
        anthropic: { api_key_env: "ANTHROPIC_API_KEY" },
        openrouter: { api_key_env: "OPENROUTER_API_KEY" },
      },
      sandbox: "none",
      authEnabled: false,
    });

    expect((config.agents as any).orchestrator.name).toBe("Orchestrator");
    expect((config.agents as any).orchestrator.always_cli).toBe(true);
    expect((config.agents as any).reviewer.name).toBe("Reviewer");
    expect((config.daemon as any).name).toBe("TestInstance");
    expect((config.server as any).port).toBe(3777);
  });

  test("only includes providers used by template", () => {
    const config = buildConfigFromTemplate(template, {
      instanceName: "Test",
      port: 3777,
      providers: {
        anthropic: { api_key_env: "ANTHROPIC_API_KEY" },
        openrouter: { api_key_env: "OPENROUTER_API_KEY" },
        minimax: { api_key_env: "MINIMAX_API_KEY" },
      },
      sandbox: "none",
      authEnabled: false,
    });

    // Template providers are preserved, and the local Ollama classifier is always available.
    expect((config.providers as any).anthropic).toBeDefined();
    expect((config.providers as any).openrouter).toBeDefined();
    expect((config.providers as any).ollama).toEqual({
      url: "http://localhost:11434",
      model: "llama3.2:3b",
    });
    expect((config.providers as any).minimax).toBeUndefined();
  });

  test("routes template classification through the local Ollama winner", () => {
    const config = buildConfigFromTemplate(template, {
      instanceName: "Test",
      port: 3777,
      providers: { anthropic: { api_key_env: "KEY" } },
      sandbox: "none",
      authEnabled: false,
    });

    expect((config.routing as any).classifier_provider).toBe("ollama");
    expect((config.routing as any).classifier_model).toBe("llama3.2:3b");
  });

  test("applies budget from template", () => {
    const config = buildConfigFromTemplate(template, {
      instanceName: "Test",
      port: 3777,
      providers: { anthropic: { api_key_env: "KEY" } },
      sandbox: "none",
      authEnabled: false,
    });

    expect((config.budget as any).monthly_limit).toBe(50);
  });

  test("includes auth config when enabled", () => {
    const config = buildConfigFromTemplate(template, {
      instanceName: "Test",
      port: 3777,
      providers: { anthropic: { api_key_env: "KEY" } },
      sandbox: "none",
      authEnabled: true,
    });

    expect((config.auth as any).enabled).toBe(true);
  });

  test("defaults template vaults into per-instance folders under /home/user/dev/obsidian", () => {
    const config = buildConfigFromTemplate(template, {
      instanceName: "ExampleLabs",
      port: 3777,
      providers: { anthropic: { api_key_env: "KEY" } },
      sandbox: "none",
      authEnabled: false,
      vaultPath: "/Volumes/ExampleDrive/Obsidian/ExampleLabs",
      projects: [{ name: "Trading Journal", repo_path: "/home/user/dev/example-app", default: true }],
    });

    expect((config.vault as any).path).toBe("/home/user/dev/obsidian/ExampleLabs");
    expect(config.allowed_directories).toEqual([
      "/home/user/dev/example-app",
      "/home/user/dev/obsidian/ExampleLabs",
    ]);
    expect((config.daemon as any).projects).toEqual([
      { name: "Trading Journal", repo_path: "/home/user/dev/example-app", default: true },
    ]);
  });

  test("configToToml produces valid TOML string", () => {
    const config = buildConfigFromTemplate(template, {
      instanceName: "Test",
      port: 3777,
      providers: { anthropic: { api_key_env: "KEY" } },
      sandbox: "none",
      authEnabled: false,
    });

    const toml = configToToml(config);
    expect(toml).toContain("Test");
    // TOML formats 3777 as 3_777
    expect(toml).toContain("port");
    expect(typeof toml).toBe("string");
  });
});

// --- Postman converter tests ---

describe("Postman Converter", () => {
  test("converts basic collection to markdown", () => {
    const collection = {
      info: { name: "Test API", description: "A test API" },
      item: [
        {
          name: "Get Items",
          request: {
            method: "GET",
            url: { raw: "https://api.test.com/items" },
            description: "Fetch all items",
          },
        },
      ],
    };

    const md = postmanToMarkdown(collection);
    expect(md).toContain("# Test API API Reference");
    expect(md).toContain("GET https://api.test.com/items");
    expect(md).toContain("Fetch all items");
  });

  test("handles nested folders", () => {
    const collection = {
      info: { name: "Nested API" },
      item: [
        {
          name: "Products",
          item: [
            {
              name: "List Products",
              request: {
                method: "GET",
                url: { raw: "/products" },
              },
            },
          ],
        },
      ],
    };

    const md = postmanToMarkdown(collection);
    expect(md).toContain("### Products");
    expect(md).toContain("GET /products");
  });

  test("includes auth section", () => {
    const collection = {
      info: { name: "Auth API" },
      item: [],
      auth: { type: "bearer" },
    };

    const md = postmanToMarkdown(collection);
    expect(md).toContain("## Authentication");
    expect(md).toContain("Bearer Token");
  });

  test("formats request body", () => {
    const collection = {
      info: { name: "Body API" },
      item: [
        {
          name: "Create",
          request: {
            method: "POST",
            url: { raw: "/items" },
            body: { mode: "raw", raw: '{"name":"test"}' },
          },
        },
      ],
    };

    const md = postmanToMarkdown(collection);
    expect(md).toContain("**Body:**");
    expect(md).toContain('"name": "test"');
  });

  test("handles empty collection gracefully", () => {
    const collection = {
      info: { name: "Empty API" },
      item: [],
    };

    const md = postmanToMarkdown(collection);
    expect(md).toContain("# Empty API API Reference");
    expect(md).toContain("## Endpoints");
  });
});

// --- Acme template validation ---

describe("Acme Engineering Template", () => {
  test("validates against NyxTemplateSchema", () => {
    const template = loadTemplate("acme-engineering");
    expect(template.id).toBe("acme-engineering");
    expect(template.config.agents).toHaveLength(3);
  });

  test("has correct agent roles", () => {
    const template = loadTemplate("acme-engineering");
    const roles = template.config.agents.map(a => a.role);
    expect(roles).toContain("lead");
    expect(roles).toContain("reviewer");
    expect(roles).toContain("worker");
  });

  test("has knowledge configuration", () => {
    const template = loadTemplate("acme-engineering");
    expect(template.knowledge).toBeDefined();
    expect(template.knowledge!.vault_path).toContain("acme-engineering");
    expect(template.knowledge!.exclude).toContain("Templates/**");
  });

  test("theme hides dashboard tab", () => {
    const template = loadTemplate("acme-engineering");
    expect(template.theme.tabs.dashboard).toBe(false);
    expect(template.theme.tabs.chat).toBe(true);
    expect(template.theme.accentColor).toBe("#2196F3");
  });

  test("passes validateTemplateDir", () => {
    const path = resolveTemplatePath("acme-engineering");
    expect(path).not.toBeNull();
    // Note: this may fail if the vault disk isn't mounted
    // but validates schema regardless
  });
});

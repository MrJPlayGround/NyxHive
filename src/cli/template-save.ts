import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, } from "node:path";
import TOML from "@iarna/toml";
import { NyxTemplateSchema, type NyxTemplate } from "../templates/types.js";
import { LOCAL_TEMPLATES_DIR } from "../templates/loader.js";
import { logger } from "../utils/logger.js";
import { normalizeObsidianPath } from "../utils/obsidian-paths.js";

interface SaveOptions {
  name: string;
  instanceDir: string;
  outputDir?: string;
}

/**
 * Reverse-engineer a running instance's config into a reusable template.
 * Reads config.toml and theme.json, maps them back to NyxTemplate format.
 */
export function saveInstanceAsTemplate(options: SaveOptions): { templateDir: string; template: NyxTemplate } {
  const { name, instanceDir } = options;
  const outputDir = options.outputDir ?? LOCAL_TEMPLATES_DIR;

  // Validate template name (lowercase, alphanumeric + hyphens)
  if (!/^[a-z][a-z0-9-]*$/.test(name)) {
    throw new Error(`Invalid template name "${name}". Must be lowercase, start with a letter, and contain only letters, numbers, and hyphens.`);
  }

  // Read instance config
  const configPath = join(instanceDir, "config.toml");
  if (!existsSync(configPath)) {
    throw new Error(`Config not found: ${configPath}`);
  }

  const rawToml = readFileSync(configPath, "utf-8");
  const config = JSON.parse(JSON.stringify(TOML.parse(rawToml)));

  // Read theme.json if present
  const themePath = join(instanceDir, "config", "theme.json");
  let themeData: Record<string, unknown> | undefined;
  if (existsSync(themePath)) {
    themeData = JSON.parse(readFileSync(themePath, "utf-8"));
  }

  // Build agents array from config
  const agents: NyxTemplate["config"]["agents"] = [];
  const agentEntries = config.agents ?? {};
  for (const [key, agent] of Object.entries(agentEntries)) {
    const a = agent as Record<string, unknown>;
    agents.push({
      key,
      name: (a.name as string) ?? key,
      role: (a.role as "orchestrator" | "lead" | "coder" | "reviewer" | "expert" | "worker" | "heartbeat") ?? "worker",
      provider: a.provider as string,
      model: a.model as string,
      system_prompt: (a.system_prompt as string) ?? `You are ${a.name ?? key}.`,
      ...(a.always_cli ? { always_cli: true } : {}),
      ...(a.agentic_mode ? { agentic_mode: a.agentic_mode as "standard" | "strict" } : {}),
      ...(a.min_model ? { min_model: a.min_model as string } : {}),
      ...(a.capabilities ? { capabilities: a.capabilities as string[] } : {}),
    });
  }

  if (agents.length === 0) {
    throw new Error("Instance has no agents configured");
  }

  // Build routing overrides
  const routingOverrides = config.routing?.overrides as Record<string, { provider: string; model: string }> | undefined;

  // Build budget
  const budget = config.budget ? {
    monthly_limit: (config.budget as Record<string, unknown>).monthly_limit as number,
    warning_threshold: ((config.budget as Record<string, unknown>).warning_threshold as number) ?? 0.8,
  } : undefined;

  // Build scheduler tasks
  const schedulerTasks = (config.scheduler as Record<string, unknown>)?.tasks as Array<Record<string, unknown>> | undefined;
  const scheduler = schedulerTasks?.map(t => ({
    name: t.name as string,
    schedule: (t.cron as string) ?? "",
    task: t.prompt as string,
    ...(t.model ? { model: t.model as string } : {}),
  }));

  // Build theme from theme.json or defaults
  const theme = {
    accentColor: (themeData?.accentColor as string) ?? "#7C4DFF",
    appearanceMode: ((themeData?.appearanceMode as string) ?? "system") as "dark" | "light" | "system",
    appName: ((themeData?.appName as string) ?? config.daemon?.name ?? name).slice(0, 30),
    tagline: (themeData?.tagline as string) ?? "",
    tabs: {
      chat: true as const,
      agents: (themeData?.tabs as Record<string, boolean>)?.agents ?? true,
      dashboard: (themeData?.tabs as Record<string, boolean>)?.dashboard ?? true,
      settings: true as const,
    },
    chatPlaceholder: (themeData?.chatPlaceholder as string) ?? "Message...",
    emptyStateMessage: (themeData?.emptyStateMessage as string) ?? "Hi! How can I help?",
  };

  // Build knowledge preset if vault configured
  let knowledge: NyxTemplate["knowledge"];
  if (config.vault) {
    const vault = config.vault as Record<string, unknown>;
    knowledge = {
      vault_path: normalizeObsidianPath(vault.path as string) ?? (vault.path as string),
      categories: ["general"],
      description: `Knowledge vault for ${config.daemon?.name ?? name}`,
      ...(vault.skip_dirs ? { exclude: vault.skip_dirs as string[] } : {}),
    };
  }

  // Determine category from agents
  const roles = new Set(agents.map(a => a.role));
  let category: NyxTemplate["category"] = "custom";
  if (roles.has("coder") || roles.has("reviewer")) category = "development";

  const templateData: NyxTemplate = NyxTemplateSchema.parse({
    id: name,
    name: config.daemon?.name ?? name,
    description: `Template saved from ${config.daemon?.name ?? name} instance`,
    version: "1.0.0",
    author: "NyxAI",
    category,
    config: {
      agents,
      ...(routingOverrides && Object.keys(routingOverrides).length > 0 ? { routing: routingOverrides } : {}),
      ...(budget ? { budget } : {}),
      ...(scheduler?.length ? { scheduler } : {}),
    },
    theme,
    ...(knowledge ? { knowledge } : {}),
  });

  // Write to output directory
  const templateDir = join(outputDir, name);
  mkdirSync(templateDir, { recursive: true });
  writeFileSync(join(templateDir, "template.json"), `${JSON.stringify(templateData, null, 2)}\n`);

  return { templateDir, template: templateData };
}

/**
 * Find the next available port by scanning existing instances.
 * Starts from basePort (default 3777) and increments until finding an unused one.
 */
export function findNextAvailablePort(usedPorts: number[], basePort = 3777): number {
  const portSet = new Set(usedPorts);
  let port = basePort;
  while (portSet.has(port)) {
    port++;
  }
  return port;
}

// CLI entry point
if (process.argv[2] === "template-save") {
  const args = process.argv.slice(3);
  let name: string | undefined;
  let instanceName: string | undefined;
  let configPath: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--name" && i + 1 < args.length) {
      name = args[++i];
    } else if (args[i] === "--instance" && i + 1 < args.length) {
      instanceName = args[++i];
    } else if (args[i] === "--config" && i + 1 < args.length) {
      configPath = args[++i];
    }
  }

  if (!name) {
    logger.error("  Error: --name is required. Usage: nyxhive template-save --name <template-name> [--instance <name>]");
    process.exit(1);
  }

  // Resolve instance directory
  const { resolveInstance } = await import("./resolve.js");
  const resolved = resolveInstance(instanceName, undefined, configPath);

  try {
    const { templateDir, template } = saveInstanceAsTemplate({
      name,
      instanceDir: resolved.instanceDir,
    });

    logger.info(`
  Template saved: ${name}
  ──────────────────────
  Location: ${templateDir}
  Agents:   ${template.config.agents.map(a => `${a.name} (${a.role})`).join(", ")}
  Theme:    ${template.theme.appName} (${template.theme.accentColor})

  Use it:
    nyxhive init <dir> --template ${name}
`);
  } catch (err) {
    logger.error(`  Error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

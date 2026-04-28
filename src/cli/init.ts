import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  buildSimpleConfigToml,
  createWizardIO,
  extractEnvLinesFromAnswers,
  promptSetupMode,
  runSimpleInitWizard,
  type WizardIO,
} from "./init-wizard.js";
import { loadBookmarks, addBookmark } from "./instance-registry.js";
import { logger } from "../utils/logger.js";
import { applyPresetToInstance, getPresetCatalog } from "./presets.js";
import { getPresetSoulDir } from "../presets.js";
import { findNextAvailablePort } from "./template-save.js";
import { listTemplates, loadTemplate, resolveTemplatePath } from "../templates/loader.js";
import { buildConfigFromTemplate, configToToml } from "../templates/config-gen.js";
import { createVaultStructure, generateVaultSkeleton } from "../templates/vault-skeleton.js";

function defaultInstanceName(absDir: string): string {
  const dirName = basename(absDir) || "assistant";
  return dirName.charAt(0).toUpperCase() + dirName.slice(1);
}

function findGitRepoRoot(startDir: string): string | undefined {
  let current = resolve(startDir);
  while (true) {
    if (existsSync(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function titleCaseRepoName(repoPath: string): string {
  return basename(repoPath)
    .split(/[-_]/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

async function askPort(io: WizardIO): Promise<number> {
  const usedPorts = loadBookmarks().bookmarks
    .map((bookmark) => bookmark.port)
    .filter((port): port is number => port !== undefined);
  const defaultPort = findNextAvailablePort(usedPorts);
  while (true) {
    const raw = (await io.question(`Port [${defaultPort}]: `)).trim();
    const port = Number.parseInt(raw || String(defaultPort), 10);
    if (Number.isInteger(port) && port > 0) return port;
    io.print("  Enter a valid port number.");
  }
}

async function promptTemplate(io: WizardIO): Promise<string> {
  const templates = listTemplates();
  if (templates.length === 0) {
    throw new Error("No templates are available.");
  }

  const lines = templates.map((entry, index) => `  ${index + 1}. ${entry.id} - ${entry.template.description}`);
  while (true) {
    const answer = (await io.question(`Which full template?\n${lines.join("\n")}\n> `)).trim();
    if (!answer) return templates[0]!.id;
    const index = Number.parseInt(answer, 10);
    if (Number.isInteger(index) && index >= 1 && index <= templates.length) {
      return templates[index - 1]!.id;
    }
    const matched = templates.find((entry) => entry.id === answer);
    if (matched) return matched.id;
    io.print("  Choose a template number or id.");
  }
}

function buildEnvFile(lines: string[]): string {
  const seen = new Set<string>();
  const ordered = ["NYX_API_KEY", ...lines.map((line) => line.split("=")[0] ?? "").filter(Boolean)];
  const result: string[] = [];

  for (const key of ordered) {
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const line = lines.find((entry) => entry.startsWith(`${key}=`));
    if (line) result.push(line);
  }

  for (const line of lines) {
    const key = line.split("=")[0] ?? "";
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(line);
  }

  return `${result.join("\n")}\n`;
}

function writeInstanceSoul(instanceDir: string, instanceName: string): void {
  const soulStub = `# ${instanceName} instance soul
# Add identity, context, and relationships specific to this instance.

context:
  instance_notes: |
    ${instanceName} instance.
`;
  writeFileSync(join(instanceDir, "souls", "instance.yaml"), soulStub, "utf-8");
}

function installPresetSoul(instanceDir: string, presetName: string): void {
  const targetDir = join(instanceDir, "souls", "assistant");
  mkdirSync(join(instanceDir, "souls"), { recursive: true });
  cpSync(getPresetSoulDir(presetName), targetDir, { recursive: true, force: true });
  applyPresetToInstance({
    presetName,
    instanceDir,
    agentKey: "assistant",
  });
}

async function initSimple(absDir: string): Promise<void> {
  const io = createWizardIO();
  try {
    logger.info(`
  NyxHive Setup
  ─────────────
  Simple mode writes a minimal config and a preset-backed default agent.
`);

    const answers = await runSimpleInitWizard(io, defaultInstanceName(absDir));
    const port = await askPort(io);

    mkdirSync(join(absDir, "data"), { recursive: true });
    mkdirSync(join(absDir, "workspace"), { recursive: true });
    mkdirSync(join(absDir, "souls"), { recursive: true });

    const configToml = buildSimpleConfigToml({
      name: answers.name,
      port,
      preset: answers.preset,
      provider: {
        name: answers.provider.name,
        apiKeyEnv: answers.provider.apiKey?.envName,
        model: answers.provider.model,
        url: answers.provider.url,
      },
      channels: answers.channels,
    });
    writeFileSync(join(absDir, "config.toml"), configToml, "utf-8");

    installPresetSoul(absDir, answers.preset);
    writeInstanceSoul(absDir, answers.name);

    const apiKey = `nyx_${randomBytes(32).toString("hex")}`;
    const envBody = buildEnvFile([`NYX_API_KEY=${apiKey}`, ...extractEnvLinesFromAnswers(answers)]);
    writeFileSync(join(absDir, ".env"), envBody, "utf-8");

    addBookmark({ name: answers.name, path: absDir, port });

    const presetDescription = getPresetCatalog().find((preset) => preset.name === answers.preset)?.description ?? answers.preset;
    logger.info(`
  Instance created at ${absDir}
  Preset: ${answers.preset} - ${presetDescription}
  Provider: ${answers.provider.name}/${answers.provider.model}
  Port: ${port}

  Start your instance:
    cd ${absDir} && nyxhive start
`);
  } finally {
    io.close();
  }
}

async function initAdvanced(absDir: string, forcedTemplateId?: string): Promise<void> {
  const io = createWizardIO();
  try {
    logger.info(`
  NyxHive Setup
  ─────────────
  Advanced mode uses the existing full-template flow.
`);
    const templateId = forcedTemplateId ?? await promptTemplate(io);

    const templatePath = resolveTemplatePath(templateId);
    if (!templatePath) {
      throw new Error(`Template not found: ${templateId}`);
    }
    const template = loadTemplate(templatePath);
    const name = (await io.question(`Instance name [${template.theme.appName}]: `)).trim() || template.theme.appName;
    const port = await askPort(io);

    const neededProviders = new Set(template.config.agents.map((agent) => agent.provider));
    if (template.config.routing) {
      for (const route of Object.values(template.config.routing)) {
        neededProviders.add(route.provider);
      }
    }

    const providers: Record<string, { api_key_env: string }> = {};
    for (const provider of neededProviders) {
      if (provider === "ollama") continue;
      const defaultEnv = provider === "anthropic"
        ? "ANTHROPIC_API_KEY"
        : provider === "openrouter"
          ? "OPENROUTER_API_KEY"
          : "OPENAI_API_KEY";
      const envName = (await io.question(`  ${provider} env var [${defaultEnv}]: `)).trim() || defaultEnv;
      providers[provider] = { api_key_env: envName };
    }

    const sandboxInput = (await io.question("  Sandbox [none/docker/macos]: ")).trim() || "none";
    const sandbox = ["docker", "macos", "none"].includes(sandboxInput) ? sandboxInput : "none";

    const repoRoot = findGitRepoRoot(absDir);
    const configObj = buildConfigFromTemplate(template, {
      instanceName: name,
      port,
      providers,
      sandbox,
      authEnabled: false,
      ...(repoRoot
        ? {
            projects: [{
              name: titleCaseRepoName(repoRoot),
              repo_path: repoRoot,
              default: true,
            }],
          }
        : {}),
    });

    mkdirSync(join(absDir, "data"), { recursive: true });
    mkdirSync(join(absDir, "workspace"), { recursive: true });
    mkdirSync(join(absDir, "souls"), { recursive: true });

    writeFileSync(join(absDir, "config.toml"), configToToml(configObj), "utf-8");
    writeInstanceSoul(absDir, name);

    const apiKey = `nyx_${randomBytes(32).toString("hex")}`;
    const envLines = [`NYX_API_KEY=${apiKey}`];
    for (const { api_key_env } of Object.values(providers)) {
      if (!process.env[api_key_env]) {
        envLines.push(`${api_key_env}=your-key-here`);
      }
    }
    writeFileSync(join(absDir, ".env"), buildEnvFile(envLines), "utf-8");

    const skeleton = generateVaultSkeleton(name, template);
    if (configObj.vault && typeof configObj.vault === "object" && "path" in configObj.vault && typeof configObj.vault.path === "string") {
      createVaultStructure(configObj.vault.path, skeleton);
    }

    addBookmark({ name, path: absDir, port });

    logger.info(`
  Instance created at ${absDir}
  Template: ${template.name} (${template.id})
  Port: ${port}

  Start your instance:
    cd ${absDir} && nyxhive start
`);
  } finally {
    io.close();
  }
}

async function main(): Promise<void> {
  const rawArgs = process.argv.slice(3);
  let seedName: string | undefined;
  let targetDir = ".";
  let templateId: string | undefined;

  for (let i = 0; i < rawArgs.length; i++) {
    if (rawArgs[i] === "--template" && rawArgs[i + 1]) {
      templateId = rawArgs[++i];
    } else if (!rawArgs[i]!.startsWith("--")) {
      targetDir = rawArgs[i]!;
    }
  }

  const absDir = resolve(targetDir);
  if (templateId) {
    await initAdvanced(absDir, templateId);
    return;
  }

  const io = createWizardIO();
  let mode: "simple" | "advanced";
  try {
    mode = await promptSetupMode(io);
  } finally {
    io.close();
  }

  if (mode === "advanced") {
    await initAdvanced(absDir);
    return;
  }

  await initSimple(absDir);
}

main().catch((error) => {
  logger.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

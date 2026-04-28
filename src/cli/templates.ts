import { listTemplates, validateTemplateDir, resolveTemplatePath, loadTemplate } from "../templates/loader.js";
import { logger } from "../utils/logger.js";

export async function handleTemplates(args: string[]) {
  const subcommand = args[0];

  switch (subcommand) {
    case "list":
      listCmd();
      break;
    case "validate":
      validateCmd(args[1]);
      break;
    case "save":
      await saveCmd(args.slice(1));
      break;
    default:
      logger.info(`
  Usage: nyxhive templates <command>

  Commands:
    list                List available templates
    validate <id>       Validate a template
    save --name <name>  Save instance as template
`);
      if (subcommand) process.exit(1);
  }
}

function listCmd() {
  const templates = listTemplates();

  if (templates.length === 0) {
    logger.info("\n  No templates found.\n");
    return;
  }

  // Table formatting
  const idWidth = Math.max(4, ...templates.map(t => t.id.length)) + 2;
  const catWidth = Math.max(10, ...templates.map(t => t.template.category.length)) + 2;
  const verWidth = 9;
  const descWidth = 40;

  const header = [
    "ID".padEnd(idWidth),
    "Category".padEnd(catWidth),
    "Version".padEnd(verWidth),
    "Description",
  ].join("  ");

  logger.info("\n  Available Templates:\n");
  logger.info(`  ${header}`);
  logger.info(`  ${"─".repeat(idWidth + catWidth + verWidth + descWidth + 6)}`);

  for (const { template } of templates) {
    const row = [
      template.id.padEnd(idWidth),
      template.category.padEnd(catWidth),
      template.version.padEnd(verWidth),
      template.description.slice(0, descWidth),
    ].join("  ");
    logger.info(`  ${row}`);
  }
  logger.info("");
}

function validateCmd(id: string | undefined) {
  if (!id) {
    logger.error("  Error: Template ID required. Usage: nyxhive templates validate <id>");
    process.exit(1);
  }

  const templatePath = resolveTemplatePath(id);
  if (!templatePath) {
    logger.error(`  Error: Template not found: ${id}`);
    process.exit(1);
  }

  logger.info(`\n  Validating template: ${id}`);
  logger.info(`  ${"─".repeat(36)}\n`);

  const { valid, errors } = validateTemplateDir(templatePath);

  if (valid) {
    const template = loadTemplate(templatePath);
    const agentNames = template.config.agents.map(a => `${a.name} (${a.role})`).join(", ");
    logger.info("  + template.json valid");
    logger.info(`  + ${template.config.agents.length} agents configured: ${agentNames}`);
    if (template.knowledge) {
      logger.info(`  + Knowledge vault: ${template.knowledge.vault_path}`);
    }
    logger.info(`  + Theme: ${template.theme.appName} (${template.theme.accentColor})`);
    logger.info("\n  Template is valid.\n");
  } else {
    for (const err of errors) {
      logger.error(`  x ${err}`);
    }
    logger.error("\n  Template validation failed.\n");
    process.exit(1);
  }
}

async function saveCmd(args: string[]) {
  const { saveInstanceAsTemplate } = await import("./template-save.js");
  const { resolveInstance } = await import("./resolve.js");

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
    logger.error("  Error: --name is required. Usage: nyxhive templates save --name <template-name> [--instance <name>]");
    process.exit(1);
  }

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
  Agents:   ${template.config.agents.map((a: { name: string; role: string }) => `${a.name} (${a.role})`).join(", ")}
  Theme:    ${template.theme.appName} (${template.theme.accentColor})

  Use it:
    nyxhive init <dir> --template ${name}
`);
  } catch (err) {
    logger.error(`  Error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}

// Auto-run when imported as CLI
const command = process.argv[2];
if (command === "templates") {
  handleTemplates(process.argv.slice(3));
}

import { resolve, join } from "node:path";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { loadConfig, resolveEnvKey } from "../config.js";
import { resolveInstance, loadInstanceEnv } from "./resolve.js";
import { logger } from "../utils/logger.js";
import { OpenRouterEmbedding } from "../memory/embeddings.js";
import { KnowledgeStore } from "../memory/knowledge.js";
import { ingestVault, ingestTemplateKnowledge } from "../memory/ingest.js";
import { loadTemplate, resolveTemplatePath } from "../templates/loader.js";

async function main() {
  // Parse CLI args — handle --config <path>, --template <id>, instance name
  const rawArgs = process.argv.slice(2);
  const positionalArgs: string[] = [];
  let configPath: string | undefined;
  let templateId: string | undefined;
  let instanceName: string | undefined;

  for (let i = 0; i < rawArgs.length; i++) {
    if (rawArgs[i] === "ingest") continue;
    if (rawArgs[i] === "--config" && i + 1 < rawArgs.length) {
      configPath = rawArgs[++i];
    } else if (rawArgs[i] === "--template" && i + 1 < rawArgs.length) {
      templateId = rawArgs[++i];
    } else if (rawArgs[i] === "--instance" && i + 1 < rawArgs.length) {
      instanceName = rawArgs[++i];
    } else if (rawArgs[i] === "--status") {
      // ignore flags
    } else if (!rawArgs[i].startsWith("--")) {
      positionalArgs.push(rawArgs[i]);
    }
  }

  // If first positional contains a slash, it's a vault path; otherwise instance name
  let vaultArg: string | undefined;
  if (positionalArgs.length > 0) {
    if (positionalArgs[0].includes("/")) {
      vaultArg = positionalArgs[0];
    } else {
      instanceName = instanceName ?? positionalArgs[0];
    }
  }

  const { configPath: resolvedConfig, instanceDir } = resolveInstance(
    instanceName,
    undefined,
    configPath,
  );
  loadInstanceEnv(instanceDir);

  const config = loadConfig(resolvedConfig);
  const name = config.daemon.name;
  const nameLower = name.toLowerCase();

  logger.setLevel(config.daemon.log_level);
  const dataDir = resolve(config.daemon.data_dir);
  mkdirSync(dataDir, { recursive: true });
  logger.setLogFile(dataDir, nameLower);
  logger.setPrefix(nameLower);

  // Priority: CLI arg > config knowledge.vault_path > config vault.path > data_dir/vault
  const vaultPath = vaultArg
    ? resolve(vaultArg)
    : (config as any).knowledge?.vault_path
      ? resolve((config as any).knowledge.vault_path)
      : config.vault?.path
        ? resolve(config.vault.path)
        : resolve(dataDir, "vault");

  logger.info(`Ingesting vault: ${vaultPath}`);

  const openrouterConfig = config.providers.openrouter;
  if (!openrouterConfig) {
    throw new Error("OpenRouter provider config required for embeddings");
  }

  if (!openrouterConfig.api_key_env) {
    throw new Error("OpenRouter provider config requires api_key_env for embeddings");
  }
  const apiKey = resolveEnvKey(openrouterConfig.api_key_env);
  const embedder = new OpenRouterEmbedding(apiKey);
  const store = new KnowledgeStore(dataDir, nameLower);

  try {
    if (templateId) {
      // Template-aware ingestion
      const template = loadTemplate(templateId);
      if (!template.knowledge) {
        logger.error(`Template ${templateId} has no knowledge configuration.`);
        process.exit(1);
      }

      // Load priority rules from ingestion-config.json if it exists
      const templatePath = resolveTemplatePath(templateId)!;
      const ingestionConfigPath = join(templatePath, "ingestion-config.json");
      let priorityRules: Array<{ pattern: string; priority: number }> | undefined;
      if (existsSync(ingestionConfigPath)) {
        try {
          const ingestionConfig = JSON.parse(readFileSync(ingestionConfigPath, "utf-8"));
          priorityRules = ingestionConfig.priorityRules;
        } catch {
          logger.warn(`[ingest] Failed to parse ingestion-config.json at ${ingestionConfigPath}, ignoring priority rules`);
        }
      }

      logger.info(`Ingesting knowledge for template: ${template.name}`);
      logger.info(`Vault: ${template.knowledge.vault_path}`);
      if (template.knowledge.exclude?.length) {
        logger.info(`Excluding: ${template.knowledge.exclude.join(", ")}`);
      }

      const result = await ingestTemplateKnowledge(store, embedder, {
        vaultPath: template.knowledge.vault_path,
        scope: template.id,
        exclude: template.knowledge.exclude,
        priorityRules,
      });

      logger.info("Ingestion complete:");
      logger.info(`  Files:   ${result.totalFiles}`);
      logger.info(`  Chunks:  ${result.totalChunks}`);
      logger.info(`  New:     ${result.newChunks}`);
      logger.info(`  Updated: ${result.updatedChunks}`);
      logger.info(`  Skipped: ${result.skippedChunks}`);
      logger.info(`  Priority: ${result.priorityCounts.core} core, ${result.priorityCounts.high} high, ${result.priorityCounts.normal} normal`);
    } else {
      // Standard vault ingestion
      const result = await ingestVault(
        { path: vaultPath },
        store,
        embedder,
      );

      logger.info("Ingestion complete:");
      logger.info(`  Files:   ${result.totalFiles}`);
      logger.info(`  Chunks:  ${result.totalChunks}`);
      logger.info(`  New:     ${result.newChunks}`);
      logger.info(`  Updated: ${result.updatedChunks}`);
      logger.info(`  Skipped: ${result.skippedChunks}`);
      logger.info(`  Deleted: ${result.deletedFiles} files cleaned up`);
    }

    const stats = store.getStats();
    logger.info(`Knowledge base: ${stats.totalChunks} chunks from ${stats.totalFiles} files`);
    for (const [cat, count] of Object.entries(stats.categories)) {
      logger.info(`  ${cat}: ${count}`);
    }
  } finally {
    store.close();
  }
}

main().catch((err) => {
  logger.error(`Ingestion failed: ${err}`);
  process.exit(1);
});

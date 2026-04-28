import { loadConfig } from "../config.js";
import { resolveInstance, loadInstanceEnv } from "./resolve.js";
import { logger } from "../utils/logger.js";

function parseArgs() {
  const args = process.argv.slice(3);
  let configPath: string | undefined;
  let instanceName: string | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--config" && i + 1 < args.length) {
      configPath = args[++i];
    } else if (!args[i].startsWith("--")) {
      instanceName = args[i];
    }
  }

  return { configPath, instanceName };
}

export async function showConfig() {
  const { configPath, instanceName } = parseArgs();
  const { configPath: resolved, instanceDir } = resolveInstance(
    instanceName,
    undefined,
    configPath,
  );
  loadInstanceEnv(instanceDir);

  logger.info(`Config: ${resolved}`);
  const config = loadConfig(resolved);

  // Redact sensitive values
  const safe = JSON.parse(JSON.stringify(config));
  if (safe.server?.api_key) safe.server.api_key = "***";
  for (const [, p] of Object.entries(safe.providers ?? {})) {
    if ((p as any).api_key_env)
      (p as any).api_key_env = `${(p as any).api_key_env} (env ref)`;
  }

  logger.info(JSON.stringify(safe, null, 2));
}

// Auto-execute when run directly (not imported from index.ts)
if (import.meta.main) {
  showConfig().catch((err) => {
    logger.error(`Error: ${err}`);
    process.exit(1);
  });
}

import { resolve, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { loadConfig } from "../config.js";
import { resolveInstance, loadInstanceEnv } from "./resolve.js";
import { logger } from "../utils/logger.js";

function parseArgs() {
  const args = process.argv.slice(3);
  let configPath: string | undefined;
  let instanceName: string | undefined;
  let follow = false;
  let limit = 50;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--config" && i + 1 < args.length) {
      configPath = args[++i];
    } else if (args[i] === "-f" || args[i] === "--follow") {
      follow = true;
    } else if (args[i] === "-n" && i + 1 < args.length) {
      limit = Number.parseInt(args[++i], 10);
    } else if (!args[i].startsWith("--")) {
      instanceName = args[i];
    }
  }

  return { configPath, instanceName, follow, limit };
}

async function main() {
  const { configPath, instanceName, follow, limit } = parseArgs();
  const { configPath: resolved, instanceDir } = resolveInstance(
    instanceName,
    undefined,
    configPath,
  );
  loadInstanceEnv(instanceDir);

  const config = loadConfig(resolved);
  const dataDir = resolve(config.daemon.data_dir);
  const nameLower = config.daemon.name.toLowerCase();
  const logFile = join(dataDir, `${nameLower}.log`);

  if (!existsSync(logFile)) {
    logger.error(`Log file not found: ${logFile}`);
    process.exit(1);
  }

  // Print last N lines
  const content = readFileSync(logFile, "utf-8");
  const lines = content.split("\n").filter(Boolean);
  const tail = lines.slice(-limit);
  for (const line of tail) {
    logger.info(line);
  }

  if (follow) {
    let lastLineCount = lines.length;

    setInterval(() => {
      const current = readFileSync(logFile, "utf-8");
      const currentLines = current.split("\n").filter(Boolean);
      if (currentLines.length > lastLineCount) {
        for (const line of currentLines.slice(lastLineCount)) {
          logger.info(line);
        }
        lastLineCount = currentLines.length;
      }
    }, 500);

    // Keep alive
    await new Promise(() => {});
  }
}

main().catch((err) => {
  logger.error(`Error: ${err}`);
  process.exit(1);
});

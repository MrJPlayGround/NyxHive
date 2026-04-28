import { createHive } from "./framework/create-hive.js";
import { allBuiltinChannels } from "./framework/channels/index.js";
import { resolveConfigPath } from "./config.js";
import { logger } from "./utils/logger.js";

function argValue(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

async function main() {
  const hive = await createHive({
    config: resolveConfigPath(),
    channels: allBuiltinChannels(),
    mainBrain: argValue("--brain"),
  });

  await hive.start();
}

// Global safety nets — prevent silent crashes from unhandled errors
process.on("uncaughtException", (err) => {
  logger.error(`Uncaught exception: ${err.stack ?? err}`);
});

process.on("unhandledRejection", (reason) => {
  logger.error(`Unhandled rejection: ${reason instanceof Error ? reason.stack ?? reason : reason}`);
});

main().catch((err) => {
  logger.error(`Fatal error: ${err}`);
  process.exit(1);
});

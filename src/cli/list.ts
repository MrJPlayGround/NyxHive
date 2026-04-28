import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { listInstances } from "./resolve.js";
import { logger } from "../utils/logger.js";
import { isPidRunning } from "./pid-status.js";

async function main() {
  const instances = listInstances();

  if (instances.length === 0) {
    logger.info("\n  No instances found in ~/.nyxhive/instances/\n");
    logger.info("  Create one with: nyxhive init\n");
    return;
  }

  logger.info("\n  Instances:\n");

  for (const inst of instances) {
    // Check if running via PID file
    const pidFile = resolve(inst.dataDir, "nyxhive.pid");
    let status = "stopped";

    if (existsSync(pidFile)) {
      const pid = Number.parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
      if (isPidRunning(pid)) {
        status = `running (PID ${pid})`;
      }
    }

    const padding = Math.max(0, 16 - inst.name.length);
    logger.info(
      `    ${inst.name}${" ".repeat(padding)}port ${inst.port}   ${status}`,
    );
  }

  logger.info("");
}

main().catch((err) => {
  logger.error(`Error: ${err}`);
  process.exit(1);
});

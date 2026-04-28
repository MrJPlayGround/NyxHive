import { resolve } from "node:path";
import { existsSync, readFileSync, unlinkSync, mkdirSync } from "node:fs";
import { loadConfig } from "../config.js";
import { resolveInstance, loadInstanceEnv } from "./resolve.js";
import { logger } from "../utils/logger.js";

const args = process.argv.slice(3);
const instanceName = args.find(a => !a.startsWith("--"));

const { configPath: resolved, instanceDir } = resolveInstance(instanceName);
loadInstanceEnv(instanceDir);
const config = loadConfig(resolved);
const dataDir = resolve(config.daemon.data_dir);
const pidFile = resolve(dataDir, "nyxhive.pid");

// Stop
if (existsSync(pidFile)) {
  const pid = Number.parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
  try {
    process.kill(pid, 0);
    process.kill(pid, "SIGTERM");
    logger.info(`${config.daemon.name} stopped (PID ${pid})`);
  } catch {
    logger.warn(`Process ${pid} not found.`);
  }
  unlinkSync(pidFile);
}

// Brief pause for cleanup
await Bun.sleep(1000);

// Start (foreground by default, daemon with -d)
const daemon = args.includes("--daemon") || args.includes("-d");
if (daemon) {
  mkdirSync(dataDir, { recursive: true });
  const child = Bun.spawn(
    ["bun", "run", resolve(import.meta.dir, "../index.ts"), "--config", resolved],
    {
      detached: true,
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
      env: {
        ...process.env,
      },
    },
  );
  const { writeFileSync } = await import("node:fs");
  writeFileSync(pidFile, String(child.pid));
  child.unref();
  logger.info(`${config.daemon.name} restarted (PID ${child.pid})`);
} else {
  process.argv = ["bun", "nyxhive", "--config", resolved];
  await import("../index.js");
}

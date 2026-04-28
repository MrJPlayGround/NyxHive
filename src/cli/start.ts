import { resolve } from "node:path";
import { writeFileSync, existsSync, unlinkSync, mkdirSync, readFileSync } from "node:fs";
import { loadConfig } from "../config.js";
import { resolveInstance, loadInstanceEnv } from "./resolve.js";
import { logger } from "../utils/logger.js";
import { parseStartArgs } from "./start-args.js";
import { isPidRunning, type SignalProcess } from "./pid-status.js";

export function readRunningPid(pidFile: string, signalProcess: SignalProcess = process.kill): number | null {
  if (!existsSync(pidFile)) return null;

  const existingPid = Number.parseInt(readFileSync(pidFile, "utf-8"), 10);
  if (isPidRunning(existingPid, signalProcess)) {
    return existingPid;
  }

  unlinkSync(pidFile);
  return null;
}

export async function runStart(argv = process.argv.slice(3)) {
  const { configPath, daemon, instanceName, brain } = parseStartArgs(argv);
  const { configPath: resolved, instanceDir } = resolveInstance(
    instanceName,
    undefined,
    configPath,
  );

  // Auto-load env vars from instance directory
  const envLoaded = loadInstanceEnv(instanceDir);
  if (envLoaded > 0) {
    logger.info(`  Loaded ${envLoaded} env vars from ${instanceDir} env files`);
  }

  const config = loadConfig(resolved);
  const dataDir = resolve(config.daemon.data_dir);
  // CLI --brain flag takes precedence over config.daemon.main_brain
  const effectiveBrain = brain ?? config.daemon.main_brain;
  if (effectiveBrain) {
    process.env.NYXHIVE_MAIN_BRAIN = effectiveBrain;
  }

  mkdirSync(dataDir, { recursive: true });
  const pidFile = resolve(dataDir, "nyxhive.pid");

  const existingPid = readRunningPid(pidFile);
  if (existingPid !== null) {
    logger.error(
      `Instance already running (PID ${existingPid}). Stop it first with: nyxhive stop`,
    );
    process.exit(1);
  }

  if (daemon) {
    const child = Bun.spawn(
      [
        "bun",
        "run",
        resolve(import.meta.dir, "../index.ts"),
        "--config",
        resolved,
      ],
      {
        detached: true,
        stdout: "ignore",
        stderr: "ignore",
        stdin: "ignore",
        env: {
          ...process.env,
          ...(effectiveBrain ? { NYXHIVE_MAIN_BRAIN: effectiveBrain } : {}),
        },
      },
    );

    writeFileSync(pidFile, String(child.pid));
    child.unref();
    logger.info(`${config.daemon.name} started (PID ${child.pid})`);
  } else {
    // Foreground mode: set argv so resolveConfigPath picks up the config,
    // then import and run the main module
    process.argv = [
      "bun", "nyxhive", "--config", resolved,
      ...(effectiveBrain ? ["--brain", effectiveBrain] : []),
    ];
    await import("../index.js");
  }
}

if (import.meta.main) {
  runStart().catch((err) => {
    logger.error(`Error: ${err}`);
    process.exit(1);
  });
}

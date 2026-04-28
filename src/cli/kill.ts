import { resolve } from "node:path";
import { existsSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { resolveInstance, loadInstanceEnv } from "./resolve.js";
import { loadConfig } from "../config.js";
import { logger } from "../utils/logger.js";

const NYXHIVE_HOME = process.env.NYXHIVE_HOME ?? resolve(process.env.HOME!, ".nyxhive");

function killProcess(pid: number): boolean {
  try {
    process.kill(pid, 0); // check alive
    process.kill(pid, "SIGKILL");
    return true;
  } catch {
    return false;
  }
}

function killAll() {
  logger.info("EMERGENCY KILL — all NyxHive processes\n");
  let killed = 0;

  const instancesDir = resolve(NYXHIVE_HOME, "instances");
  if (existsSync(instancesDir)) {
    for (const name of readdirSync(instancesDir)) {
      const pidFile = resolve(instancesDir, name, "data", "nyxhive.pid");
      if (!existsSync(pidFile)) continue;

      const pid = Number.parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
      if (killProcess(pid)) {
        logger.info(`  Killed ${name} (PID ${pid})`);
        killed++;
      }
      unlinkSync(pidFile);
      try {
        const workspace = resolve(instancesDir, name, "workspace");
        const result = Bun.spawnSync(["pgrep", "-f", `claude.*${workspace}`]);
        const pids = new TextDecoder().decode(result.stdout).trim().split("\n").filter(Boolean);
        for (const pidStr of pids) {
          const pid = Number.parseInt(pidStr, 10);
          if (killProcess(pid)) {
            logger.info(`  Killed ${name} workspace claude (PID ${pid})`);
            killed++;
          }
        }
      } catch {
        // pgrep not found or no matches
      }
    }
  }

  if (killed === 0) {
    logger.info("  No running processes found");
  }
}

function killInstance(instanceName: string) {
  const { configPath: resolved, instanceDir } = resolveInstance(instanceName);
  loadInstanceEnv(instanceDir);
  const config = loadConfig(resolved);
  const dataDir = resolve(config.daemon.data_dir);
  const pidFile = resolve(dataDir, "nyxhive.pid");
  const port = config.server.port;

  logger.info(`EMERGENCY KILL — ${instanceName}\n`);
  let killed = false;

  // Kill by PID file
  if (existsSync(pidFile)) {
    const pid = Number.parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
    if (killProcess(pid)) {
      logger.info(`  Killed main process (PID ${pid})`);
      killed = true;

      // Hunt child processes
      try {
        const result = Bun.spawnSync(["pgrep", "-P", String(pid)]);
        const children = new TextDecoder().decode(result.stdout).trim().split("\n").filter(Boolean);
        for (const cpid of children) {
          killProcess(Number.parseInt(cpid, 10));
          logger.info(`  Killed child process (PID ${cpid})`);
        }
      } catch {
        // no children
      }
    }
    unlinkSync(pidFile);
  }

  // Fallback: kill by port
  if (!killed) {
    try {
      const result = Bun.spawnSync(["lsof", "-t", `-i:${port}`]);
      const portPid = new TextDecoder().decode(result.stdout).trim().split("\n")[0];
      if (portPid) {
        killProcess(Number.parseInt(portPid, 10));
        logger.info(`  Killed orphaned process (PID ${portPid}) on port ${port}`);
        killed = true;
      }
    } catch {
      // lsof failed
    }
  }

  // Kill claude processes in this instance's workspace
  try {
    const workspace = resolve(instanceDir, "workspace");
    const result = Bun.spawnSync(["pgrep", "-f", `claude.*${workspace}`]);
    const pids = new TextDecoder().decode(result.stdout).trim().split("\n").filter(Boolean);
    for (const pidStr of pids) {
      killProcess(Number.parseInt(pidStr, 10));
      logger.info(`  Killed workspace claude (PID ${pidStr})`);
    }
  } catch {
    // no matches
  }

  if (!killed) {
    logger.info("  No running process found");
  }
}

const instanceName = process.argv[3];
if (!instanceName) {
  killAll();
} else {
  killInstance(instanceName);
}

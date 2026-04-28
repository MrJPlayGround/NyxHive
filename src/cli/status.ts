import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { loadConfig } from "../config.js";
import { resolveInstance, loadInstanceEnv } from "./resolve.js";
import { logger } from "../utils/logger.js";
import { describeServerContract } from "../server/urls.js";
import {
  formatHealthSummary,
  formatHealthUnreachableSummary,
  formatQueueDeadLetterSample,
  formatQueueDeadLetterSummary,
  formatQueueSummary,
} from "./status-format.js";
import { isPidRunning } from "./pid-status.js";

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

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

async function main() {
  const { configPath, instanceName } = parseArgs();
  const { configPath: resolved, instanceDir } = resolveInstance(
    instanceName,
    undefined,
    configPath,
  );
  loadInstanceEnv(instanceDir);

  const config = loadConfig(resolved);
  const dataDir = resolve(config.daemon.data_dir);
  const pidFile = resolve(dataDir, "nyxhive.pid");
  const port = config.server.port;
  const serverContract = describeServerContract(config);

  // Check PID file
  let pid: number | null = null;
  let running = false;

  if (existsSync(pidFile)) {
    pid = Number.parseInt(readFileSync(pidFile, "utf-8").trim(), 10);
    if (isPidRunning(pid)) {
      running = true;
    }
  }

  // If PID file says stopped, check if port is actually in use
  if (!running) {
    try {
      const res = await fetch(`http://localhost:${port}/health`, {
        signal: AbortSignal.timeout(1000),
      });
      if (res.ok || res.status) {
        running = true;
        pid = null;
      }
    } catch {
      // Port is not responding
    }
  }

  logger.info(`
  Instance:  ${config.daemon.name}
  Status:    ${running ? `running${pid ? ` (PID ${pid})` : " (orphaned)"}` : "stopped"}
  Port:      ${port}
  Public:    ${serverContract.base_url ?? "unavailable"}
  MCP:       ${serverContract.mcp_url ?? "unavailable"}
  Config:    ${resolved}
  Data:      ${dataDir}
`);

  if (serverContract.warnings.length > 0) {
    for (const warning of serverContract.warnings) {
      logger.warn(`  Warning:   ${warning}`);
    }
  }

  if (!running) {
    process.exit(0);
  }

  // Get detailed health from the API
  try {
    const res = await fetch(`http://localhost:${port}/health`, {
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const data = await res.json() as Record<string, any>;
      logger.info(`  Health:    ${formatHealthSummary(data)}`);

      if (data.uptime_seconds != null) {
        logger.info(`  Uptime:    ${formatUptime(data.uptime_seconds)}`);
      }
      if (data.queue) {
        logger.info(`  Queue:     ${formatQueueSummary(data.queue)}`);
        const deadLetterSummary = formatQueueDeadLetterSummary(data.queue);
        if (deadLetterSummary) {
          logger.warn(`  Dead:      ${deadLetterSummary}`);
        }
        const deadLetterSample = formatQueueDeadLetterSample(data.queue);
        if (deadLetterSample) {
          logger.warn(`  Latest:    ${deadLetterSample}`);
        }
      }
      if (data.memory) {
        logger.info(`  Memory:    ${data.memory.rss_mb} MB RSS`);
      }
    } else {
      logger.info(`  Health:    ${res.status}`);
    }
  } catch (error) {
    logger.info(`  Health:    ${formatHealthUnreachableSummary({ pid, error })}`);
  }

  // Agent summary
  const agents = Object.entries(config.agents);
  if (agents.length > 0) {
    logger.info(`  Agents:    ${agents.length} configured`);
    for (const [key, a] of agents) {
      logger.info(`    ${a.name} (${key}): ${a.provider}/${a.model}`);
    }
  }

  // Channels
  const channels: string[] = ["HTTP API"];
  if (config.telegram) channels.push("Telegram");
  if (config.discord) channels.push("Discord");
  if (config.slack) channels.push("Slack");
  if (config.imessage) channels.push("iMessage");
  logger.info(`  Channels:  ${channels.join(", ")}`);
  logger.info("");
}

main().catch((err) => {
  logger.error(`Error: ${err}`);
  process.exit(1);
});

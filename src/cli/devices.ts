import { resolveInstance, loadInstanceEnv } from "./resolve.js";
import { loadConfig } from "../config.js";
import { apiFetch, resolveServerApiKey } from "./api-client.js";
import { logger } from "../utils/logger.js";

const KNOWN_SUBCOMMANDS = new Set(["list", "approve", "revoke"]);

function parseArgs() {
  const args = process.argv.slice(3);
  let subcommand: string | undefined;
  let deviceId: string | undefined;
  let instanceName: string | undefined;
  let configPath: string | undefined;
  const positionals: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--instance" && i + 1 < args.length) {
      instanceName = args[++i];
    } else if (args[i] === "--config" && i + 1 < args.length) {
      configPath = args[++i];
    } else if (!args[i].startsWith("--")) {
      positionals.push(args[i]);
    }
  }

  // Detect instance name: if first positional isn't a known subcommand, it's the instance
  // e.g. "nyxhive devices NyxAI list" or "nyxhive devices NyxAI"
  if (positionals.length > 0 && !KNOWN_SUBCOMMANDS.has(positionals[0])) {
    instanceName = positionals.shift();
  }

  subcommand = positionals[0];
  deviceId = positionals[1];

  return { subcommand, deviceId, instanceName, configPath };
}

async function main() {
  const { subcommand, deviceId: rawDeviceId, instanceName, configPath } = parseArgs();
  const { configPath: resolved, instanceDir } = resolveInstance(
    instanceName,
    undefined,
    configPath,
  );
  loadInstanceEnv(instanceDir);
  const config = loadConfig(resolved);
  const port = config.server.port;
  const base = `http://localhost:${port}`;
  const apiKey = resolveServerApiKey(config);
  let deviceId = rawDeviceId;

  switch (subcommand) {
    case "list":
    case undefined: {
      const res = await apiFetch(base, "/api/devices", apiKey);
      const data = res as {
        devices: Array<{
          id: string;
          name: string;
          approved: boolean;
          lastSeen: number | null;
          createdAt: number;
        }>;
      };
      if (data.devices.length === 0) {
        logger.info("No devices registered.");
        return;
      }
      const pending = data.devices.filter((d) => !d.approved);
      const approved = data.devices.filter((d) => d.approved);
      if (pending.length > 0) {
        logger.info(`\n  Pending (${pending.length}):`);
        for (const d of pending) {
          logger.info(
            `    ${d.name}  ${d.id.slice(0, 12)}...  (${timeAgo(d.createdAt)})`,
          );
        }
      }
      if (approved.length > 0) {
        logger.info(`\n  Approved (${approved.length}):`);
        for (const d of approved) {
          logger.info(
            `    ${d.name}  ${d.id.slice(0, 12)}...  last seen ${d.lastSeen ? timeAgo(d.lastSeen) : "never"}`,
          );
        }
      }
      logger.info("");
      break;
    }
    case "approve": {
      if (!deviceId) {
        const data = await apiFetch(base, "/api/devices/pending", apiKey) as {
          devices: Array<{ id: string; name: string; createdAt: number }>;
        };
        if (data.devices.length === 0) {
          logger.info("No pending devices.");
          return;
        }
        if (data.devices.length === 1) {
          deviceId = data.devices[0].id;
          logger.info(
            `Approving '${data.devices[0].name}' (${deviceId.slice(0, 12)}...)...`,
          );
        } else {
          logger.info("Multiple pending devices. Specify ID:");
          for (const d of data.devices) {
            logger.info(
              `  nyxhive devices approve ${d.id.slice(0, 12)}   # ${d.name}`,
            );
          }
          return;
        }
      }
      const allData = await apiFetch(base, "/api/devices", apiKey) as {
        devices: Array<{ id: string; name: string }>;
      };
      const match = allData.devices.find((d) => d.id.startsWith(deviceId!));
      if (!match) {
        logger.error(`No device matching '${deviceId}'`);
        process.exit(1);
      }
      const result = await apiFetch(base, `/api/devices/${match.id}/approve`, apiKey, { method: "POST" }) as { approved: boolean };
      if (result.approved) {
        logger.info(`Approved '${match.name}'`);
      } else {
        logger.error(`Failed to approve device '${deviceId}'`);
      }
      break;
    }
    case "revoke": {
      if (!deviceId) {
        logger.error("Usage: nyxhive devices revoke <device-id>");
        process.exit(1);
      }
      const allData = await apiFetch(base, "/api/devices", apiKey) as {
        devices: Array<{ id: string; name: string }>;
      };
      const match = allData.devices.find((d) => d.id.startsWith(deviceId!));
      if (!match) {
        logger.error(`No device matching '${deviceId}'`);
        process.exit(1);
      }
      const result = await apiFetch(base, `/api/devices/${match.id}/revoke`, apiKey, { method: "POST" }) as { revoked: boolean };
      if (result.revoked) {
        logger.info(`Revoked '${match.name}'`);
      } else {
        logger.error(`Failed to revoke device '${deviceId}'`);
      }
      break;
    }
    default:
      logger.error(`Unknown subcommand: ${subcommand}`);
      logger.info("Usage: nyxhive devices [list|approve|revoke] [device-id]");
      process.exit(1);
  }
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

main().catch((err) => {
  if (err?.code === "ConnectionRefused" || err?.message?.includes("ECONNREFUSED")) {
    logger.error("Cannot connect to NyxHive server. Is it running?");
  } else {
    logger.error(`Error: ${err}`);
  }
  process.exit(1);
});

import { resolveInstance, loadInstanceEnv } from "./resolve.js";
import { loadConfig } from "../config.js";
import { apiFetch, resolveServerApiKey } from "./api-client.js";
import { logger } from "../utils/logger.js";

const KNOWN_SUBCOMMANDS = new Set(["list", "approve", "revoke"]);

function parseArgs() {
  const args = process.argv.slice(3);
  let subcommand: string | undefined;
  let code: string | undefined;
  let channel: string | undefined;
  let senderId: string | undefined;
  let instanceName: string | undefined;
  let configPath: string | undefined;
  const positionals: string[] = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--instance" && i + 1 < args.length) {
      instanceName = args[++i];
    } else if (args[i] === "--config" && i + 1 < args.length) {
      configPath = args[++i];
    } else if (args[i] === "--channel" && i + 1 < args.length) {
      channel = args[++i];
    } else if (args[i] === "--sender" && i + 1 < args.length) {
      senderId = args[++i];
    } else if (!args[i].startsWith("--")) {
      positionals.push(args[i]);
    }
  }

  if (positionals.length > 0 && !KNOWN_SUBCOMMANDS.has(positionals[0])) {
    instanceName = positionals.shift();
  }

  subcommand = positionals[0];
  code = positionals[1];

  return { subcommand, code, channel, senderId, instanceName, configPath };
}

async function main() {
  const { subcommand, code, channel, senderId, instanceName, configPath } = parseArgs();
  const { configPath: resolved, instanceDir } = resolveInstance(instanceName, undefined, configPath);
  loadInstanceEnv(instanceDir);
  const config = loadConfig(resolved);
  const port = config.server.port;
  const base = `http://localhost:${port}`;
  const apiKey = resolveServerApiKey(config);

  switch (subcommand) {
    case "list":
    case undefined: {
      const data = await apiFetch(base, "/api/pairing", apiKey) as {
        approved: Array<{ channel: string; sender_id: string; sender: string; approved_at: string }>;
        pending: Array<{ channel: string; sender_id: string; sender: string; code: string; created_at: string }>;
      };

      if (data.pending.length === 0 && data.approved.length === 0) {
        logger.info("No paired users.");
        return;
      }

      if (data.pending.length > 0) {
        logger.info(`\n  Pending (${data.pending.length}):`);
        for (const p of data.pending) {
          logger.info(`    ${p.sender}  ${p.channel}  code: ${p.code}`);
        }
      }
      if (data.approved.length > 0) {
        logger.info(`\n  Approved (${data.approved.length}):`);
        for (const a of data.approved) {
          logger.info(`    ${a.sender}  ${a.channel}  (${a.sender_id})`);
        }
      }
      logger.info("");
      break;
    }
    case "approve": {
      if (!code) {
        // Auto-select if only one pending
        const data = await apiFetch(base, "/api/pairing", apiKey) as {
          pending: Array<{ code: string; sender: string; channel: string }>;
        };
        if (data.pending.length === 0) {
          logger.info("No pending pairing requests.");
          return;
        }
        if (data.pending.length === 1) {
          const p = data.pending[0];
          logger.info(`Approving ${p.sender} (${p.channel})...`);
          const result = await apiFetch(base, "/api/pairing/approve", apiKey, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ code: p.code }),
          }) as { approved?: { sender: string; channel: string } };
          if (result.approved) {
            logger.info(`Approved ${result.approved.sender} on ${result.approved.channel}`);
          }
          return;
        }
        logger.info("Multiple pending requests. Specify the code:");
        for (const p of data.pending) {
          logger.info(`  nyxhive pairing approve ${p.code}   # ${p.sender} (${p.channel})`);
        }
        return;
      }

      const result = await apiFetch(base, "/api/pairing/approve", apiKey, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      }) as { approved?: { sender: string; channel: string }; error?: string };

      if (result.approved) {
        logger.info(`Approved ${result.approved.sender} on ${result.approved.channel}`);
      } else {
        logger.error(result.error ?? "Failed to approve");
      }
      break;
    }
    case "revoke": {
      if (!channel || !senderId) {
        // If no flags, show approved list for easy selection
        const data = await apiFetch(base, "/api/pairing", apiKey) as {
          approved: Array<{ channel: string; sender_id: string; sender: string }>;
        };
        if (data.approved.length === 0) {
          logger.info("No approved users to revoke.");
          return;
        }
        logger.info("Specify --channel and --sender to revoke:");
        for (const a of data.approved) {
          logger.info(`  nyxhive pairing revoke --channel ${a.channel} --sender ${a.sender_id}   # ${a.sender}`);
        }
        return;
      }

      const result = await apiFetch(base, "/api/pairing/revoke", apiKey, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel, sender_id: senderId }),
      }) as { revoked?: boolean };

      if (result.revoked) {
        logger.info(`Revoked ${senderId} on ${channel}`);
      } else {
        logger.error("Failed to revoke");
      }
      break;
    }
    default:
      logger.error(`Unknown subcommand: ${subcommand}`);
      logger.info("Usage: nyxhive pairing [list|approve|revoke]");
      process.exit(1);
  }
}

main().catch((err) => {
  if (err?.code === "ConnectionRefused" || err?.message?.includes("ECONNREFUSED")) {
    logger.error("Cannot connect to NyxHive server. Is it running?");
  } else {
    logger.error(`Error: ${err}`);
  }
  process.exit(1);
});

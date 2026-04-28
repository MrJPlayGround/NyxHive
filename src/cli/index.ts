#!/usr/bin/env bun
import { logger } from "../utils/logger.js";

const command = process.argv[2];

switch (command) {
  case "init":
    await import("./init.js");
    break;
  case "start":
    await (await import("./start.js")).runStart();
    break;
  case "stop":
    await import("./stop.js");
    break;
  case "restart":
    await import("./restart.js");
    break;
  case "list":
    await import("./list.js");
    break;
  case "status":
    await import("./status.js");
    break;
  case "logs":
    await import("./logs.js");
    break;
  case "devices":
    await import("./devices.js");
    break;
  case "pairing":
    await import("./pairing.js");
    break;
  case "ingest":
    await import("./ingest.js");
    break;
  case "backup":
    await import("./backup.js");
    break;
  case "migrate": {
    const { runMigrations, dryRunMigrations, getMigrationStatus, getCurrentVersion } = await import("../migrations/runner.js");
    const { Database } = await import("bun:sqlite");
    const migrateArgs = process.argv.slice(3);
    const dbPath = migrateArgs.find(a => !a.startsWith("--")) ?? "data/nyxhive.db";
    const db = new Database(dbPath);
    if (migrateArgs.includes("--status")) {
      const status = getMigrationStatus(db, []);
      logger.info(`Current version: ${status.current_version}`);
      logger.info(`Applied: ${status.applied.join(", ") || "none"}`);
      logger.info(`Pending: ${status.pending.length}`);
    } else if (migrateArgs.includes("--dry-run")) {
      const result = dryRunMigrations(db, []);
      logger.info(`Current version: ${result.current_version}`);
      logger.info(`Would apply: ${result.would_apply.length} migrations`);
      for (const m of result.would_apply) {
        logger.info(`  v${m.version}: ${m.description}`);
      }
    } else {
      const result = runMigrations(db, []);
      if (result.success) {
        logger.info(`Migrations complete. Applied: ${result.applied.length}`);
      } else {
        logger.error(`Migration failed: ${result.error}`);
        process.exit(1);
      }
    }
    db.close();
    break;
  }
  case "config": {
    const { showConfig } = await import("./config-cmd.js");
    await showConfig();
    break;
  }
  case "instances": {
    const { handleInstances } = await import("./instances-cmd.js");
    await handleInstances(process.argv.slice(3));
    break;
  }
  case "templates": {
    const { handleTemplates } = await import("./templates.js");
    await handleTemplates(process.argv.slice(3));
    break;
  }
  case "preset": {
    const { handlePresets } = await import("./presets.js");
    await handlePresets(process.argv.slice(3));
    break;
  }
  case "deploy":
    await import("./deploy.js");
    break;
  case "update": {
    const { handleUpdate } = await import("./update.js");
    await handleUpdate(process.argv.slice(3));
    break;
  }
  case "bootstrap":
    await import("./bootstrap.js");
    break;
  case "setup":
    await import("./setup.js");
    break;
  case "rollback":
    await import("./rollback.js");
    break;
  case "service":
    await import("./service.js");
    break;
  // Backwards compat aliases (hidden from help)
  case "kill":
    process.argv.push("--force");
    await import("./stop.js");
    break;
  case "template-save": {
    const { handleTemplates } = await import("./templates.js");
    const saveArgs = process.argv.slice(3);
    await handleTemplates(["save", ...saveArgs]);
    break;
  }
  case "health":
    await (await import("./health.js")).runHealth();
    break;
  case "version":
    logger.info("NyxHive v0.1.0");
    break;
  case undefined:
  case "help":
  case "--help":
  case "-h":
    printHelp();
    break;
  default:
    logger.error(`Unknown command: ${command}`);
    printHelp();
    process.exit(1);
}

function printHelp() {
  logger.info(`
  NyxHive — Multi-agent AI platform

  Usage: nyxhive <command> [instance] [options]

  Core:
    init [name]                 Run setup wizard and create ~/.nyxhive/instances/<name>
    start [name] [-d] [--brain <anthropic|codex>]  Start instance
    stop [name] [--force]       Stop instance (--force = emergency kill)
    restart [name] [-d]         Restart instance
    status [name]               Show instance status
    health [name]               Validate instance config, DBs, API keys
    logs [name] [-f] [-n]       Tail instance logs
    list                        List all instances

  Access:
    devices [list|approve|revoke]    Manage gateway devices
    pairing [list|approve|revoke]    Manage channel pairing (Telegram, Discord, etc.)

  Data:
    ingest [vault-path]              Ingest knowledge base
    backup [list]                    Database backups
    migrate [--status|--dry-run]     Database migrations

  Setup:
    config [name]                    Show resolved config
    instances [list|add|remove]      Manage instance registry
    preset [list|apply|eject]        Manage soul presets
    templates [list|validate|save]   Manage templates
    setup                            Interactive machine setup
    update [--check] [--dry-run] [--stash] Update the NyxHive engine checkout
    deploy [name]                    Deploy updates
    bootstrap [name] --target <dir>  Provision a clean host/dir
    rollback [name]                  Rollback deploy
    service install|uninstall        OS service (launchd/systemd)

  version                            Print version
  help                               Show this help

  Instance Resolution:
    nyxhive start Acme            Uses bookmarked instance path (legacy ~/.nyxhive/instances still works)
    nyxhive start --config <path>    Uses explicit config file
    nyxhive start                    Uses ./config.toml or legacy ./config/nyxhive.toml
`);
}

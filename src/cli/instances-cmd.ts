import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
import TOML from "@iarna/toml";
import {
  loadBookmarks,
  addBookmark,
  removeBookmark,
  checkInstanceHealth,
  type Bookmark,
} from "./instance-registry.js";
import { logger } from "../utils/logger.js";

export async function handleInstances(args: string[]) {
  const subcommand = args[0];

  switch (subcommand) {
    case "list":
      listCmd();
      break;
    case "add":
      addCmd(args.slice(1));
      break;
    case "remove":
      removeCmd(args[1]);
      break;
    case "status":
      await statusCmd();
      break;
    default:
      logger.info(`
  Usage: nyxhive instances <command>

  Commands:
    list                     List all bookmarked instances
    add <name> --path <dir>  Bookmark an instance
    remove <name>            Remove a bookmark (data preserved)
    status                   Health check all bookmarked instances
`);
      if (subcommand) process.exit(1);
  }
}

function listCmd() {
  const store = loadBookmarks();

  if (store.bookmarks.length === 0) {
    logger.info("\n  No bookmarks. Add one with: nyxhive instances add <name> --path <dir>\n");
    return;
  }

  const nameWidth = Math.max(6, ...store.bookmarks.map(b => b.name.length)) + 2;
  const portWidth = 8;
  const pathWidth = 50;

  const header = [
    "Name".padEnd(nameWidth),
    "Port".padEnd(portWidth),
    "Path",
  ].join("  ");

  logger.info("\n  Bookmarked Instances:\n");
  logger.info(`  ${header}`);
  logger.info(`  ${"─".repeat(nameWidth + portWidth + pathWidth + 4)}`);

  for (const bm of store.bookmarks) {
    const row = [
      bm.name.padEnd(nameWidth),
      String(bm.port ?? "-").padEnd(portWidth),
      bm.path.slice(0, pathWidth),
    ].join("  ");
    logger.info(`  ${row}`);
  }
  logger.info("");
}

function addCmd(args: string[]) {
  let name: string | undefined;
  let path: string | undefined;
  let port: number | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--path" && i + 1 < args.length) {
      path = args[++i];
    } else if (args[i] === "--port" && i + 1 < args.length) {
      port = Number.parseInt(args[++i], 10);
    } else if (!args[i].startsWith("--") && !name) {
      name = args[i];
    }
  }

  if (!name || !path) {
    logger.error("  Error: Usage: nyxhive instances add <name> --path <dir> [--port <port>]");
    process.exit(1);
  }

  const absPath = resolve(path);

  // Auto-detect port from config if not specified
  if (port === undefined) {
    const configPath = join(absPath, "config.toml");
    if (existsSync(configPath)) {
      try {
        const raw = readFileSync(configPath, "utf-8");
        const config = JSON.parse(JSON.stringify(TOML.parse(raw)));
        port = (config.server as Record<string, unknown>)?.port as number | undefined;
      } catch {
        // Can't read config, port stays undefined
      }
    }
  }

  const bookmark: Bookmark = { name, path: absPath, port };
  addBookmark(bookmark);
  logger.info(`\n  Bookmarked "${name}".`);
  logger.info(`  Path: ${absPath}`);
  if (port !== undefined) logger.info(`  Port: ${port}`);
  logger.info("");
}

function removeCmd(name: string | undefined) {
  if (!name) {
    logger.error("  Error: Usage: nyxhive instances remove <name>");
    process.exit(1);
  }

  removeBookmark(name);
  logger.info(`\n  Bookmark "${name}" removed. Data is preserved.\n`);
}

async function statusCmd() {
  const store = loadBookmarks();

  if (store.bookmarks.length === 0) {
    logger.info("\n  No bookmarks.\n");
    return;
  }

  const nameWidth = Math.max(6, ...store.bookmarks.map(b => b.name.length)) + 2;
  const portWidth = 8;
  const statusWidth = 20;

  const header = [
    "Name".padEnd(nameWidth),
    "Port".padEnd(portWidth),
    "Status",
  ].join("  ");

  logger.info("\n  Instance Status:\n");
  logger.info(`  ${header}`);
  logger.info(`  ${"─".repeat(nameWidth + portWidth + statusWidth + 4)}`);

  const checks = await Promise.all(
    store.bookmarks.map(async (bm) => {
      const { status, ok } = await checkInstanceHealth(bm);
      return { bm, status, ok };
    }),
  );

  for (const { bm, status, ok } of checks) {
    const statusStr = ok ? "healthy" : status;
    const row = [
      bm.name.padEnd(nameWidth),
      String(bm.port ?? "-").padEnd(portWidth),
      statusStr,
    ].join("  ");
    logger.info(`  ${row}`);
  }
  logger.info("");
}

#!/usr/bin/env bun
import { resolve } from "node:path";
import { loadConfig } from "../src/config.js";
import { resolveInstance, loadInstanceEnv } from "../src/cli/resolve.js";
import { MemoryStore } from "../src/memory/store.js";
import { buildConversationQualityReport } from "../src/runtime/conversation-quality.js";
import { logger } from "../src/utils/logger.js";

const args = process.argv.slice(2);
const instanceName = args.find((arg) => !arg.startsWith("--"));
const limitArg = args.find((arg) => arg.startsWith("--limit="))?.split("=")[1];
const limit = Math.max(1, Math.min(500, Number(limitArg ?? 100) || 100));
logger.setLevel("error");

const { configPath, instanceDir } = resolveInstance(instanceName);
loadInstanceEnv(instanceDir);
const config = loadConfig(configPath);
const memory = new MemoryStore(resolve(config.daemon.data_dir), "memory");

try {
  const report = buildConversationQualityReport(memory.getConversationQualityTraceRows(limit));
  console.log(JSON.stringify(report, null, 2));
} finally {
  memory.close();
}

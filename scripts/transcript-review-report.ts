#!/usr/bin/env bun
import { resolve } from "node:path";
import { loadConfig } from "../src/config.js";
import { resolveInstance, loadInstanceEnv } from "../src/cli/resolve.js";
import { MemoryStore } from "../src/memory/store.js";
import { buildTranscriptCalibrationReport } from "../src/runtime/transcript-review.js";
import { logger } from "../src/utils/logger.js";

const args = process.argv.slice(2);
const instanceName = args.find((arg) => !arg.startsWith("--"));
const limitArg = args.find((arg) => arg.startsWith("--limit="))?.split("=")[1];
const maxPerCategoryArg = args.find((arg) => arg.startsWith("--max-per-category="))?.split("=")[1];
const limit = Math.max(1, Math.min(500, Number(limitArg ?? 100) || 100));
const maxPerCategory = Math.max(1, Math.min(10, Number(maxPerCategoryArg ?? 1) || 1));
logger.setLevel("error");

const { configPath, instanceDir } = resolveInstance(instanceName);
loadInstanceEnv(instanceDir);
const config = loadConfig(configPath);
const memory = new MemoryStore(resolve(config.daemon.data_dir), "memory");

try {
  const rows = memory.getConversationQualityTraceRows(limit);
  const report = buildTranscriptCalibrationReport(rows, { maxPerCategory });
  console.log(JSON.stringify(report, null, 2));
} finally {
  memory.close();
}

#!/usr/bin/env bun
import { resolve } from "node:path";
import { loadConfig } from "../src/config.js";
import { resolveInstance, loadInstanceEnv } from "../src/cli/resolve.js";
import { STARTER_MEMORY_EVAL_CASES, runGraphMemoryEvalSuite } from "../src/memory/eval.js";
import { GraphMemory } from "../src/memory/graph.js";
import { MemoryStore } from "../src/memory/store.js";
import { logger } from "../src/utils/logger.js";

const args = process.argv.slice(2);
const instanceName = args.find((arg) => !arg.startsWith("--"));
const asJson = args.includes("--json");
const failOnFail = args.includes("--fail-on-fail");
logger.setLevel("error");

const { configPath, instanceDir } = resolveInstance(instanceName);
loadInstanceEnv(instanceDir);
const config = loadConfig(configPath);
const memory = new MemoryStore(resolve(config.daemon.data_dir), "memory");

try {
  const graph = new GraphMemory(memory.getDb());
  const report = runGraphMemoryEvalSuite(graph, STARTER_MEMORY_EVAL_CASES);

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`Memory eval: ${report.passed}/${report.total} passed`);
    for (const result of report.results) {
      const status = result.passed ? "PASS" : "FAIL";
      const issues = [
        result.missingExpectedTerms.length > 0 ? `missing=${result.missingExpectedTerms.join("|")}` : "",
        result.forbiddenMatches.length > 0 ? `forbidden=${result.forbiddenMatches.join("|")}` : "",
        result.tokenBudgetExceeded ? `tokens=${result.estimatedTokens}/${STARTER_MEMORY_EVAL_CASES.find((testCase) => testCase.id === result.id)?.maxPromptTokens}` : "",
      ].filter(Boolean);
      console.log(`${status} ${result.id} tokens=${result.estimatedTokens}${issues.length > 0 ? ` ${issues.join(" ")}` : ""}`);
    }
  }

  if (failOnFail && report.failed > 0) {
    process.exitCode = 1;
  }
} finally {
  memory.close();
}

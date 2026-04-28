#!/usr/bin/env bun
import { writeRestartProvenance } from "../src/runtime/restart-provenance.js";

const [action, instance, ...argv] = process.argv.slice(2);

if ((action !== "schedule" && action !== "execute") || !instance) {
  process.exit(1);
}

writeRestartProvenance(process.env.NYXHIVE_RUN_DIR, {
  id: process.env.NYXHIVE_RESTART_ID,
  action,
  instance,
  source: process.env.NYXHIVE_RESTART_SOURCE || "manual-shell",
  reason: process.env.NYXHIVE_RESTART_REASON,
  runId: process.env.NYXHIVE_RUN_ID,
  traceId: process.env.NYXHIVE_TRACE_ID,
  callerPid: Number(process.env.NYXHIVE_RESTART_CALLER_PID || process.ppid),
  parentPid: Number(process.env.NYXHIVE_RESTART_PARENT_PID || 0),
  cwd: process.env.NYXHIVE_RESTART_CWD || process.cwd(),
  argv,
  logFile: process.env.NYXHIVE_RESTART_LOG_FILE,
  sessionName: process.env.NYXHIVE_RESTART_SESSION_NAME,
});

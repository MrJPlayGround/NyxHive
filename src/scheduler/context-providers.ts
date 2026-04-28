/**
 * Context-gathering functions for scheduled tasks.
 * These build rich input data for heartbeat and briefing agents,
 * pre-fetching data they can't access themselves.
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../utils/logger.js";
import type { QueueProcessor } from "../queue/processor.js";
import type { NyxHiveConfig } from "../types.js";
import type { ProposalStore } from "../proposals/store.js";
import { formatAgentPresenceStateForHeartbeat } from "./presence-state.js";

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(n);
}

function decodeOutput(output: Uint8Array<ArrayBufferLike> | undefined): string {
  return output ? new TextDecoder().decode(output).trim() : "";
}

function findProjectScript(config: NyxHiveConfig, relativePath: string): string | null {
  for (const dir of config.allowed_directories ?? []) {
    const candidate = join(dir, relativePath);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

async function readHeartbeatProbe(config: NyxHiveConfig): Promise<{ status: string; alerts: string[] } | null> {
  const scriptPath = findProjectScript(config, "scripts/heartbeat.sh");
  if (!scriptPath) return null;

  try {
    const proc = Bun.spawn(["/opt/homebrew/bin/bash", scriptPath, "--sentinel"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    const stdout = await new Response(proc.stdout).text();
    if (!stdout.trim()) return null;

    const parsed = JSON.parse(stdout.trim()) as { status?: string; alerts?: string[] };
    return {
      status: parsed.status === "alert" ? "alert" : "ok",
      alerts: Array.isArray(parsed.alerts) ? parsed.alerts.filter((line) => typeof line === "string" && line.trim().length > 0) : [],
    };
  } catch (err) {
    logger.warn(`[scheduler] Failed to read external heartbeat probe: ${err}`);
    return null;
  }
}

export interface ContextProviderDeps {
  db: Database;
  processor: QueueProcessor;
  config: NyxHiveConfig;
  proposalStore?: ProposalStore;
  agent?: string;
}

/**
 * Build a system health snapshot to inject into heartbeat task prompts.
 * Heartbeat agents run on cheap SDK models with no tool access, so we
 * pre-fetch the data they need directly from the DB.
 */
export async function gatherHeartbeatContext(deps: ContextProviderDeps): Promise<string> {
  const { db, processor, config, agent } = deps;
  const yesterday = Date.now() - 86_400_000;
  const last10m = Date.now() - 10 * 60 * 1000;
  const last30m = Date.now() - 30 * 60 * 1000;
  const lines: string[] = ["## System Health Snapshot", ""];

  try {
    lines.push(formatAgentPresenceStateForHeartbeat(db, agent));
    lines.push("");
  } catch { lines.push("### Presence State: (query error)", ""); }

  // Queue state
  try {
    const queue = db.query(`
      SELECT
        SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
        SUM(CASE WHEN status = 'processing' THEN 1 ELSE 0 END) AS processing,
        SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN status = 'dead_letter' THEN 1 ELSE 0 END) AS dead_letters
      FROM messages
    `).get() as {
      pending: number | null;
      processing: number | null;
      failed: number | null;
      dead_letters: number | null;
    } | null;

    if (queue) {
      lines.push("### Queue");
      lines.push(`- Pending: ${queue.pending ?? 0}`);
      lines.push(`- Processing: ${queue.processing ?? 0}`);
      lines.push(`- Failed: ${queue.failed ?? 0}`);
      lines.push(`- Dead letters: ${queue.dead_letters ?? 0}`);
      lines.push("");
    }
  } catch { lines.push("### Queue: (query error)", ""); }

  // External bash heartbeat probe
  try {
    const heartbeat = await readHeartbeatProbe(config);
    if (heartbeat) {
      lines.push("### External Heartbeat Probe");
      lines.push(`- Status: ${heartbeat.status.toUpperCase()}`);
      if (heartbeat.alerts.length > 0) {
        for (const alert of heartbeat.alerts) {
          lines.push(`- ${alert}`);
        }
      } else {
        lines.push("- No external alerts");
      }
      lines.push("");
    }
  } catch { /* helper already logs */ }

  // Failed scheduled tasks
  try {
    const failedTasks = db.query(`
      SELECT name, consecutive_failures, last_status, last_error
      FROM scheduled_tasks
      WHERE consecutive_failures > 0 OR last_status = 'failed'
      ORDER BY consecutive_failures DESC
      LIMIT 5
    `).all() as Array<{ name: string; consecutive_failures: number; last_status: string; last_error: string | null }>;

    if (failedTasks.length > 0) {
      lines.push("### Failing Scheduled Tasks");
      for (const t of failedTasks) {
        const err = t.last_error ? ` — ${t.last_error.substring(0, 80)}` : "";
        lines.push(`- ${t.name}: ${t.consecutive_failures} consecutive failures${err}`);
      }
    } else {
      lines.push("### Failing Scheduled Tasks: none");
    }
  } catch { lines.push("### Failing Scheduled Tasks: (query error)"); }

  // Cost last 24h from trace_events
  lines.push("");
  try {
    const traces = processor.getTraces();
    if (traces) {
      const breakdown = traces.getCostByAgent(yesterday);
      const totalActual = breakdown.reduce((s, a) => s + a.actual_cost, 0);
      const hoursElapsed = Math.max(1, (new Date().getHours() + 1));
      const projectedCost = totalActual / hoursElapsed * 24;
      const topSpender = breakdown[0];
      lines.push(`### Cost Last 24h: $${totalActual.toFixed(2)} actual API spend`);
      lines.push(`- Projected daily total: $${projectedCost.toFixed(2)}`);
      if (topSpender) {
        lines.push(`- Top spender: ${topSpender.agent} ($${topSpender.actual_cost.toFixed(2)})`);
      }
      for (const a of breakdown.slice(0, 8)) {
        const taskInfo = a.task_types.length > 0
          ? ` — ${a.task_types.map(t => `${t.type}:${t.count}`).join(", ")}`
          : "";
        lines.push(`- ${a.agent}: $${a.actual_cost.toFixed(2)} actual (${a.count} calls${taskInfo})`);
      }
      // Cost by task type (with actual dollar cost now available)
      const taskTypeAgg = new Map<string, { count: number; cost: number }>();
      for (const a of breakdown) {
        for (const t of a.task_types) {
          const prev = taskTypeAgg.get(t.type) ?? { count: 0, cost: 0 };
          taskTypeAgg.set(t.type, { count: prev.count + t.count, cost: prev.cost + t.cost });
        }
      }
      if (taskTypeAgg.size > 0) {
        lines.push("");
        lines.push("### Cost by Task Type");
        for (const [type, agg] of [...taskTypeAgg.entries()].sort((a, b) => b[1].cost - a[1].cost).slice(0, 6)) {
          const costStr = agg.cost > 0 ? `$${agg.cost.toFixed(2)}` : "flat";
          lines.push(`- ${type}: ${agg.count} calls, ${costStr}`);
        }
      }
    } else {
      lines.push("### Cost Last 24h: trace store not available");
    }
  } catch { lines.push("### Cost Last 24h: (query error)"); }

  // Recent trace failures
  lines.push("");
  try {
    const recentErrors = db.query(`
      SELECT agent, task, error, started_at
      FROM trace_events
      WHERE status = 'failed' AND started_at > ?
      ORDER BY started_at DESC
      LIMIT 8
    `).all(last30m) as Array<{
      agent: string | null;
      task: string | null;
      error: string | null;
      started_at: number;
    }>;

    const last10mCount = recentErrors.filter((row) => row.started_at >= last10m).length;
    if (recentErrors.length > 0) {
      lines.push(`### Recent Errors (${last10mCount} in last 10m, ${recentErrors.length} in last 30m)`);
      for (const row of recentErrors) {
        const stamp = new Date(row.started_at).toISOString().slice(11, 16);
        const scope = [row.agent, row.task].filter(Boolean).join(" / ") || "unknown";
        const error = row.error?.replace(/\s+/g, " ").slice(0, 140) ?? "(no error text)";
        lines.push(`- ${stamp} — ${scope}: ${error}`);
      }
    } else {
      lines.push("### Recent Errors: none in last 30m");
    }
  } catch { lines.push("### Recent Errors: (query error)"); }

  // Agent failure rates
  lines.push("");
  try {
    const agentRows = db.query(`
      SELECT key, total_invocations, total_failures
      FROM agent_registry
      WHERE total_failures > 0
      ORDER BY total_failures DESC
      LIMIT 5
    `).all() as Array<{ key: string; total_invocations: number; total_failures: number }>;

    if (agentRows.length > 0) {
      lines.push("### Agents with Failures");
      for (const a of agentRows) {
        const pct = a.total_invocations > 0 ? Math.round(a.total_failures / a.total_invocations * 100) : 0;
        lines.push(`- ${a.key}: ${a.total_failures}/${a.total_invocations} failures (${pct}%)`);
      }
    } else {
      lines.push("### Agent Failures: none");
    }
  } catch { lines.push("### Agent Failures: (query error)"); }

  lines.push("");
  return lines.join("\n");
}

/**
 * Pre-fetch all data the briefing needs so Nyx can synthesize without
 * wasting turns trying to query localhost (she has no Bash access).
 */
export function gatherBriefingContext(deps: ContextProviderDeps): string {
  const { db, processor, config, proposalStore } = deps;
  const yesterday = Date.now() - 86_400_000;
  const lines: string[] = ["## Pre-fetched Briefing Data", ""];

  // 1. Scheduled task results (last 24h)
  try {
    const tasks = db.query(
      "SELECT name, agent, category, last_status, last_run_at, last_result FROM scheduled_tasks WHERE last_run_at > ? ORDER BY last_run_at DESC",
    ).all(yesterday) as Array<{ name: string; agent: string; category: string | null; last_status: string; last_run_at: number; last_result: string | null }>;

    lines.push("### Scheduled Task Results (last 24h)");
    if (tasks.length === 0) {
      lines.push("No tasks ran in the last 24h.");
    } else {
      for (const t of tasks) {
        const time = new Date(t.last_run_at).toISOString().slice(11, 16);
        const preview = t.last_result?.substring(0, 300) ?? "(no result)";
        lines.push(`- **${t.name}** (${t.agent}) [${t.last_status}] at ${time}`);
        lines.push(`  ${preview}`);
      }
    }
  } catch { lines.push("### Scheduled Task Results: (query error)"); }

  // 2. Proposals
  lines.push("");
  try {
    if (proposalStore) {
      const stats = proposalStore.getStats();
      lines.push(`### Proposals — ${stats.total} total`);
      lines.push(`Pending: ${stats.pending}, Approved: ${stats.approved}, Executing: ${stats.executing}, Completed: ${stats.completed}, Merged: ${stats.merged}, Failed: ${stats.failed}, Rejected: ${stats.rejected}, Expired: ${stats.expired}`);

      // List proposals with review verdicts
      const all = proposalStore.list({});
      const reviewed = all.filter(p => p.verdict || p.review_result);
      if (reviewed.length > 0) {
        lines.push("");
        lines.push("**Reviewed proposals:**");
        for (const p of reviewed.slice(0, 15)) {
          const verdict = p.verdict ? ` — Verdict: ${p.verdict}` : "";
          lines.push(`- [${p.status}] ${p.title}${verdict} (${p.priority}, by ${p.proposed_by})`);
        }
      }

      const pending = all.filter(p => p.status === "proposed" || p.status === "approved");
      if (pending.length > 0) {
        lines.push("");
        lines.push("**Awaiting action:**");
        for (const p of pending.slice(0, 10)) {
          lines.push(`- [${p.status}] ${p.title} (${p.priority}, ${p.category})`);
        }
      }
    } else {
      lines.push("### Proposals: store not available");
    }
  } catch { lines.push("### Proposals: (query error)"); }

  // 3. Cost summary (from trace_events, with billing_type awareness)
  // IMPORTANT: Only show actual variable API spend as dollar amounts.
  // Subscription agents show token counts only — no dollar amounts — to prevent
  // the briefing LLM from reporting theoretical costs as real spend.
  lines.push("");
  try {
    const traces = processor.getTraces();
    if (traces) {
      const breakdown = traces.getCostByAgent(yesterday);
      const totalActual = breakdown.reduce((s, a) => s + a.actual_cost, 0);
      const apiAgents = breakdown.filter(a => a.actual_cost > 0);
      const subAgents = breakdown.filter(a => a.actual_cost === 0 && a.count > 0);

      lines.push("### Cost Last 24h");
      lines.push(`**Variable API spend: $${totalActual.toFixed(2)}**`);
      lines.push("Fixed costs: Anthropic Max $200/mo (covers Nyx, Scout, Tester, Vigil CLI agents)");

      if (apiAgents.length > 0) {
        lines.push("");
        lines.push("**Variable cost agents (pay-per-token):**");
        for (const a of apiAgents) {
          lines.push(`- ${a.agent}: $${a.actual_cost.toFixed(2)} (${a.count} calls, ${formatTokens(a.tokens_in)} in / ${formatTokens(a.tokens_out)} out)`);
        }
      }

      if (subAgents.length > 0) {
        lines.push("");
        lines.push("**Max subscription agents (flat rate, no variable cost):**");
        for (const a of subAgents) {
          lines.push(`- ${a.agent}: ${a.count} calls, ${formatTokens(a.tokens_in)} in / ${formatTokens(a.tokens_out)} out`);
        }
      }
    } else {
      lines.push("### Cost Last 24h: trace store not available");
    }
  } catch { lines.push("### Cost Last 24h: (query error)"); }

  // 3b. 7-day cost trend
  try {
    const traces = processor.getTraces();
    if (traces) {
      const history = traces.getDailyCostHistory(7);
      if (history.length >= 2) {
        const avg7d = history.reduce((s, d) => s + d.cost, 0) / history.length;
        const yesterday = history[history.length - 1];
        const delta = yesterday && avg7d > 0 ? ((yesterday.cost - avg7d) / avg7d * 100).toFixed(0) : "N/A";
        lines.push("");
        lines.push("**7-day cost trend (variable API only):**");
        for (const d of history) {
          lines.push(`- ${d.date}: $${d.cost.toFixed(2)}`);
        }
        lines.push(`7-day avg: $${avg7d.toFixed(2)} | Yesterday vs avg: ${delta}%`);
      }
    }
  } catch { /* non-critical, skip */ }

  // 4. Knowledge stats
  lines.push("");
  try {
    const knowledgeDb = new Database(join(config.daemon.data_dir, `${config.daemon.name?.toLowerCase() ?? "nyxhive"}_knowledge.db`), { readonly: true });
    const stats = knowledgeDb.query("SELECT COUNT(*) as count FROM documents").get() as { count: number } | null;
    lines.push(`### Knowledge Base: ${stats?.count ?? 0} documents`);
    knowledgeDb.close();
  } catch { lines.push("### Knowledge Base: (not available)"); }

  lines.push("");
  return lines.join("\n");
}

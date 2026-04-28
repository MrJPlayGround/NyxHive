#!/usr/bin/env bun
/**
 * Check current context window usage and costs across all conversations.
 * Helps verify state before deploying context propagation changes.
 */

import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";

const dataDir = process.env.NYXHIVE_DATA_DIR ?? join(homedir(), ".nyxhive", "instances", "NyxAI", "data");
const db = new Database(join(dataDir, "memory.db"), { readonly: true });

// Get context window info per model
const contextWindows: Record<string, number> = {
  "claude-opus-4-6": 200000,
  "claude-sonnet-4-6": 200000,
  "claude-haiku-4-5-20251001": 200000,
  "MiniMax-M2.5": 4096,
  "google/gemini-2.5-flash": 1000000,
};

function getContextWindow(model: string): number {
  return contextWindows[model] ?? 8000;
}

console.log("\n═══════════════════════════════════════════════════════════");
console.log("📊 CONTEXT WINDOW USAGE REPORT");
console.log("═══════════════════════════════════════════════════════════\n");

// 1. Per-conversation context usage
console.log("🗣️  CONVERSATIONS (by recent activity)");
console.log("─────────────────────────────────────────────────────────");

const convQuery = db.prepare(`
  SELECT
    c.id,
    c.channel,
    COUNT(m.id) as message_count,
    COALESCE(SUM(m.tokens_in), 0) as total_tokens_in,
    COALESCE(SUM(m.tokens_out), 0) as total_tokens_out,
    COALESCE(SUM(m.cost_usd), 0) as cost_usd,
    MAX(m.model) as last_model,
    datetime(c.updated_at / 1000, 'unixepoch') as updated_at
  FROM conversations c
  LEFT JOIN messages m ON m.conversation_id = c.id
  GROUP BY c.id
  ORDER BY c.updated_at DESC
  LIMIT 20
`);

const conversations = convQuery.all() as any[];

if (conversations.length === 0) {
  console.log("(No conversations yet)\n");
} else {
  for (const conv of conversations) {
    const tokens = conv.total_tokens_in + conv.total_tokens_out;
    const contextWindow = getContextWindow(conv.last_model || "claude-sonnet-4-6");
    const utilization = ((tokens / contextWindow) * 100).toFixed(1);
    console.log(`📌 ${conv.channel} (${conv.message_count} msgs)`);
    console.log(`   Tokens: ${tokens.toLocaleString()} / ${contextWindow.toLocaleString()} (${utilization}%)`);
    console.log(`   Cost: $${conv.cost_usd.toFixed(4)}`);
    console.log(`   Last: ${conv.updated_at}`);
    console.log();
  }
}

// 2. Cost summary (24h, 7d, 30d, all-time)
console.log("💰 COST BREAKDOWN");
console.log("─────────────────────────────────────────────────────────");

const now = Date.now();
const costs = {
  "Last 24h": now - 24 * 60 * 60 * 1000,
  "Last 7d": now - 7 * 24 * 60 * 60 * 1000,
  "Last 30d": now - 30 * 24 * 60 * 60 * 1000,
};

for (const [label, since] of Object.entries(costs)) {
  const costQuery = db.prepare(`
    SELECT
      COALESCE(SUM(cost_usd), 0) as total_cost,
      COALESCE(SUM(tokens_in + tokens_out), 0) as total_tokens,
      COUNT(*) as message_count
    FROM messages
    WHERE created_at > ?
  `);
  const result = costQuery.get(since) as any;
  console.log(`${label.padEnd(12)}: $${result.total_cost.toFixed(4)} (${result.total_tokens.toLocaleString()} tokens, ${result.message_count} msgs)`);
}
console.log();

// 3. Per-model usage
console.log("🤖 MODEL USAGE");
console.log("─────────────────────────────────────────────────────────");

const modelQuery = db.prepare(`
  SELECT
    model,
    COUNT(*) as message_count,
    COALESCE(SUM(tokens_in + tokens_out), 0) as total_tokens,
    COALESCE(SUM(cost_usd), 0) as cost_usd
  FROM messages
  WHERE model IS NOT NULL
  GROUP BY model
  ORDER BY cost_usd DESC
`);

const models = modelQuery.all() as any[];
for (const model of models) {
  console.log(`${(model.model || "unknown").padEnd(25)}: $${model.cost_usd.toFixed(4)} (${model.total_tokens.toLocaleString()} tokens)`);
}
console.log();

// 4. Budget check (from config)
console.log("⚠️  BUDGET STATUS");
console.log("─────────────────────────────────────────────────────────");

const monthlyUsageQuery = db.prepare(`
  SELECT COALESCE(SUM(cost_usd), 0) as total_cost
  FROM messages
  WHERE created_at > ?
`);
const monthlyUsage = monthlyUsageQuery.get(now - 30 * 24 * 60 * 60 * 1000) as any;
const monthlyBudgetWarn = 50.00; // Default from config

console.log(`Monthly spend: $${monthlyUsage.total_cost.toFixed(2)}`);
console.log(`Warning threshold: $${monthlyBudgetWarn.toFixed(2)}`);
console.log(`Status: ${monthlyUsage.total_cost > monthlyBudgetWarn ? "⛔ OVER THRESHOLD" : "✅ Within budget"}`);
console.log();

console.log("═══════════════════════════════════════════════════════════\n");

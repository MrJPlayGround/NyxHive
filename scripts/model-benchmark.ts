#!/usr/bin/env bun
/**
 * Model benchmark v2 — tests cheap models on real NyxHive automation workloads.
 *
 * Focus: heartbeat health checks, scout exploration, analyst summaries,
 * scribe documentation — the tasks that scale with automation.
 *
 * Usage: bun run scripts/model-benchmark.ts
 *   Reads OPENROUTER_API_KEY and MINIMAX_API_KEY from env or NyxAI instance env.
 *
 * Adds automated quality scoring via Sonnet judge + latency/cost comparison.
 */

import { readFileSync } from "fs";

// --- Load API keys from env or NyxAI instance env ---
function loadKeys(): { openrouter: string; minimax: string; anthropic: string } {
  let openrouter = process.env.OPENROUTER_API_KEY ?? "";
  let minimax = process.env.MINIMAX_API_KEY ?? "";
  let anthropic = process.env.ANTHROPIC_API_KEY ?? "";

  if (!openrouter || !minimax || !anthropic) {
    try {
      const envFile = readFileSync(`${process.env.HOME}/.nyxhive/instances/NyxAI/env`, "utf-8");
      for (const line of envFile.split("\n")) {
        const [key, ...rest] = line.split("=");
        const val = rest.join("=").trim();
        if (key === "OPENROUTER_API_KEY" && !openrouter) openrouter = val;
        if (key === "MINIMAX_API_KEY" && !minimax) minimax = val;
        if (key === "ANTHROPIC_API_KEY" && !anthropic) anthropic = val;
      }
    } catch {}
  }

  if (!openrouter) { console.error("Missing OPENROUTER_API_KEY"); process.exit(1); }
  if (!minimax) { console.error("Missing MINIMAX_API_KEY"); process.exit(1); }
  if (!anthropic) {
    console.warn("ANTHROPIC_API_KEY not found — Claude models will be skipped (key lives in tmux session env)");
  }
  return { openrouter, minimax, anthropic };
}

const KEYS = loadKeys();

// --- Models to test ---
interface ModelDef {
  id: string;
  label: string;
  provider: "openrouter" | "minimax" | "anthropic";
  inputRate: number;   // $ per million tokens
  outputRate: number;
  tier: number;
}

const MODELS: ModelDef[] = [
  // Tier 1 — cheapest
  { id: "google/gemini-2.0-flash-lite-001", label: "Gemini Flash Lite", provider: "openrouter", inputRate: 0.075, outputRate: 0.30, tier: 1 },
  { id: "google/gemini-2.5-flash-lite", label: "Gemini 2.5 Flash Lite", provider: "openrouter", inputRate: 0.10, outputRate: 0.40, tier: 1 },
  { id: "xiaomi/mimo-v2-flash", label: "MiMo v2 Flash", provider: "openrouter", inputRate: 0.09, outputRate: 0.29, tier: 1 },
  // Tier 2 — mid
  { id: "MiniMax-M2.5", label: "MiniMax M2.5", provider: "minimax", inputRate: 0, outputRate: 0, tier: 2 },
  { id: "qwen/qwen3-235b-a22b-2507", label: "Qwen3 235B", provider: "openrouter", inputRate: 0.071, outputRate: 0.10, tier: 2 },
  { id: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash", provider: "openrouter", inputRate: 0.30, outputRate: 2.50, tier: 2 },
  { id: "claude-haiku-4-5-20251001", label: "Claude Haiku", provider: "anthropic", inputRate: 0.80, outputRate: 4.00, tier: 2 },
  // Tier 3 — reference (what we're trying to avoid needing)
  { id: "mistralai/mistral-medium-3", label: "Mistral Medium 3", provider: "openrouter", inputRate: 0.40, outputRate: 2.00, tier: 3 },
];

// --- Test scenarios matching real automation workloads ---
interface TestCase {
  name: string;
  category: string;  // heartbeat | scout | analyst | scribe
  system: string;
  prompt: string;
  maxTokens: number;
  // For automated judging — what a good response looks like
  criteria: string;
}

const TESTS: TestCase[] = [
  // === HEARTBEAT: health checks (108 invocations, will scale to thousands) ===
  {
    name: "heartbeat-health",
    category: "heartbeat",
    system: "You are a system health monitor for a multi-agent AI orchestrator. Check the provided status and respond concisely. If everything is fine, respond with just 'ok'. If something needs attention, use [@alert: message] to notify.",
    prompt: `System status:
- Queue: 0 pending, 2 processing, 847 completed
- Providers: anthropic=idle, openrouter=idle, minimax=idle
- Last error: none in 24h
- Agent registry: 11 agents, 11 enabled
- Memory DB size: 4.2MB
- Uptime: 72h`,
    maxTokens: 100,
    criteria: "Should respond with 'ok' or a very brief all-clear. Must NOT hallucinate issues. Must NOT be verbose. Shorter is better.",
  },
  {
    name: "heartbeat-anomaly",
    category: "heartbeat",
    system: "You are a system health monitor for a multi-agent AI orchestrator. Check the provided status and respond concisely. If something needs attention, use [@alert: message] to notify.",
    prompt: `System status:
- Queue: 23 pending, 0 processing, 847 completed
- Providers: anthropic=error (3 failures in 60s), openrouter=idle, minimax=idle
- Last error: "429 Too Many Requests" from anthropic at 14:32
- Agent registry: 11 agents, 11 enabled
- Memory DB size: 4.2MB
- Uptime: 72h`,
    maxTokens: 200,
    criteria: "Must identify: (1) queue backup (23 pending, 0 processing), (2) Anthropic provider in error state with 429. Should use [@alert:] tag. Must NOT miss the anomaly. Must NOT hallucinate additional problems.",
  },
  {
    name: "heartbeat-metrics",
    category: "heartbeat",
    system: "You are a system health monitor. Analyze the metrics and flag any concerning trends. Be concise.",
    prompt: `Agent performance (last 24h):
| Agent | Invocations | Failures | Avg Duration | Cost |
|-------|------------|----------|-------------|------|
| nyx | 45 | 0 | 8.2s | $4.12 |
| forge | 12 | 2 | 198s | $15.40 |
| vigil | 8 | 0 | 43s | $2.10 |
| scout | 3 | 1 | 261s | $3.80 |
| heartbeat | 48 | 0 | 9s | $0.00 |

Daily budget: $8/day. Current spend: $25.42`,
    maxTokens: 200,
    criteria: "Must identify: (1) over budget ($25.42 vs $8 limit), (2) forge failure rate (2/12 = 17%), (3) scout failure (1/3 = 33%). Should flag budget overrun as primary concern. Must NOT miss the budget issue.",
  },

  // === SCOUT: codebase exploration and proposal generation ===
  {
    name: "scout-quality",
    category: "scout",
    system: "You are a code quality scout. Analyze findings and generate proposals using [@propose: title=\"...\" category=... description=\"...\" effort=... files=\"...\"] tags. Be concise.",
    prompt: "Scan results from NyxHive codebase:\n\n1. Dead export: 'export function oldClassify()' in src/providers/router.ts — no imports found\n2. Empty catch block: src/agents/invoke.ts:67 — catch {} with no logging\n3. TODO: src/queue/processor.ts:142 — 'TODO: implement retry backoff' (added 14 days ago)\n4. Large file: src/queue/processor.ts — 892 lines\n\nGenerate proposals for the top 2 findings.",
    maxTokens: 400,
    criteria: "Must generate exactly 2 [@propose:] tags with correct syntax (title, category, description, effort, files). Proposals should be for the most impactful findings. Must use the exact tag format.",
  },
  {
    name: "scout-deps",
    category: "scout",
    system: "You are a dependency health scanner. Analyze package dependencies and flag issues. Be concise.",
    prompt: `package.json dependencies:
{
  "hono": "^4.7.6",
  "better-sqlite3": "^11.8.1",
  "@anthropic-ai/sdk": "^0.39.0",
  "yaml": "^2.7.0",
  "bcrypt": "^5.1.1",
  "croner": "^9.0.0",
  "zod": "^3.24.2"
}

Import scan: better-sqlite3 is imported 0 times (using bun:sqlite instead).
@anthropic-ai/sdk is imported in 1 file (src/providers/anthropic.ts).
All others are actively used.

Latest versions: hono@4.8.1, @anthropic-ai/sdk@0.42.0, zod@3.25.0`,
    maxTokens: 300,
    criteria: "Must identify: (1) better-sqlite3 is unused (0 imports), (2) outdated packages with version gaps. Should NOT flag actively used packages as problems. Concise, actionable.",
  },

  // === ANALYST: data analysis and synthesis ===
  {
    name: "analyst-usage",
    category: "analyst",
    system: "You are a usage analyst for a multi-agent AI system. Summarize patterns and provide actionable insights. Be concise and data-driven.",
    prompt: `Weekly agent usage:
| Agent | Mon | Tue | Wed | Thu | Fri | Sat | Sun | Total | Cost |
|-------|-----|-----|-----|-----|-----|-----|-----|-------|------|
| nyx | 82 | 95 | 71 | 88 | 63 | 12 | 8 | 419 | $42 |
| forge | 18 | 22 | 15 | 31 | 12 | 2 | 0 | 100 | $123 |
| vigil | 14 | 12 | 16 | 10 | 8 | 6 | 6 | 72 | $18 |
| heartbeat | 96 | 96 | 96 | 96 | 96 | 96 | 96 | 672 | $0 |

Budget: $240/month. Week spend: $183. Projected monthly: $732.`,
    maxTokens: 300,
    criteria: "Must identify: (1) projected overspend ($732 vs $240 budget = 3x over), (2) forge is highest cost per invocation ($1.23/call), (3) weekday vs weekend pattern. Should recommend specific cost reduction actions.",
  },

  // === SCRIBE: documentation and summarization ===
  {
    name: "scribe-summary",
    category: "scribe",
    system: "You are a documentation writer. Summarize technical changes concisely for a changelog or release notes.",
    prompt: `Summarize these git commits into a brief changelog entry:

a1b2c3d feat: wire soul model_capabilities into agent registry
d4e5f6g chore: remove min_model/max_model from config.toml
h7i8j9k feat: replace manual floor/ceiling with routeWithTier()
l0m1n2o chore: remove duplicate MODEL_TIER_ALIASES from defaults.ts
p3q4r5s fix: capture LLM classifier tier in invoke.ts

These are all part of the "model routing soul integration" initiative.`,
    maxTokens: 200,
    criteria: "Should produce a concise, readable changelog entry (3-5 bullet points or a short paragraph). Must capture the essence: model routing moved from TOML config to soul system. Must NOT be longer than necessary.",
  },

  // === CLASSIFICATION: the task that runs on every single message ===
  {
    name: "classify-simple",
    category: "classification",
    system: `You are a task classifier. Given a user prompt, classify it.
Respond with ONLY JSON: {"task_type": "...", "tier": N}
Task types: trivial, simple_qa, conversation, analysis, coding, code_review, expert, research, summarization, long_context, worker_subtask, orchestrator
Tiers: 1 (cheap), 2 (mid), 3 (strong), 4 (top)`,
    prompt: `Prompt: "what's the capital of Portugal?"`,
    maxTokens: 50,
    criteria: "Must return valid JSON with task_type='simple_qa' and tier=1. Must NOT include any text outside the JSON object.",
  },
  {
    name: "classify-complex",
    category: "classification",
    system: `You are a task classifier. Given a user prompt, classify it.
Respond with ONLY JSON: {"task_type": "...", "tier": N}
Task types: trivial, simple_qa, conversation, analysis, coding, code_review, expert, research, summarization, long_context, worker_subtask, orchestrator
Tiers: 1 (cheap), 2 (mid), 3 (strong), 4 (top)`,
    prompt: `Prompt: "implement a retry mechanism with exponential backoff and circuit breaker pattern for the API client"`,
    maxTokens: 50,
    criteria: "Must return valid JSON with task_type='coding' and tier=3 or 4. Must NOT include any text outside the JSON object.",
  },
  {
    name: "classify-trap",
    category: "classification",
    system: `You are a task classifier. Given a user prompt, classify it.
Respond with ONLY JSON: {"task_type": "...", "tier": N}
Task types: trivial, simple_qa, conversation, analysis, coding, code_review, expert, research, summarization, long_context, worker_subtask, orchestrator
Tiers: 1 (cheap), 2 (mid), 3 (strong), 4 (top)`,
    prompt: `Prompt: "quick fix for the auth bug"`,
    maxTokens: 50,
    criteria: "Must return valid JSON with task_type='coding' and tier >= 2 (user says 'quick fix' but it's a coding task). Must NOT be tricked by 'quick' into tier 1. Must NOT include text outside the JSON object.",
  },
];

// --- Provider API calls ---
async function callOpenRouter(modelId: string, system: string, prompt: string, maxTokens: number): Promise<{ content: string; inputTokens: number; outputTokens: number; latencyMs: number }> {
  const start = Date.now();
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${KEYS.openrouter}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://nyxhive.dev",
      "X-Title": "NyxHive Benchmark",
    },
    body: JSON.stringify({
      model: modelId,
      messages: [{ role: "system", content: system }, { role: "user", content: prompt }],
      max_tokens: maxTokens,
      temperature: 0.3,
    }),
  });
  const data = await res.json() as any;
  if (data.error) throw new Error(data.error.message);
  return {
    content: data.choices?.[0]?.message?.content ?? "",
    inputTokens: data.usage?.prompt_tokens ?? 0,
    outputTokens: data.usage?.completion_tokens ?? 0,
    latencyMs: Date.now() - start,
  };
}

async function callMiniMax(system: string, prompt: string, maxTokens: number): Promise<{ content: string; inputTokens: number; outputTokens: number; latencyMs: number }> {
  const start = Date.now();
  const res = await fetch("https://api.minimaxi.chat/v1/text/chatcompletion_v2", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${KEYS.minimax}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "MiniMax-M2.5",
      messages: [{ role: "system", content: system }, { role: "user", content: prompt }],
      max_tokens: maxTokens,
      temperature: 0.3,
    }),
  });
  const data = await res.json() as any;
  if (data.base_resp?.status_code !== 0 && data.base_resp?.status_code !== undefined) {
    throw new Error(data.base_resp?.status_msg ?? "MiniMax error");
  }
  return {
    content: data.choices?.[0]?.message?.content ?? "",
    inputTokens: data.usage?.prompt_tokens ?? 0,
    outputTokens: data.usage?.completion_tokens ?? 0,
    latencyMs: Date.now() - start,
  };
}

async function callAnthropic(modelId: string, system: string, prompt: string, maxTokens: number): Promise<{ content: string; inputTokens: number; outputTokens: number; latencyMs: number }> {
  const start = Date.now();
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": KEYS.anthropic,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: modelId,
      system,
      messages: [{ role: "user", content: prompt }],
      max_tokens: maxTokens,
      temperature: 0.3,
    }),
  });
  const data = await res.json() as any;
  if (data.error) throw new Error(data.error.message);
  return {
    content: data.content?.[0]?.text ?? "",
    inputTokens: data.usage?.input_tokens ?? 0,
    outputTokens: data.usage?.output_tokens ?? 0,
    latencyMs: Date.now() - start,
  };
}

async function callModel(model: ModelDef, system: string, prompt: string, maxTokens: number) {
  if (model.provider === "minimax") return callMiniMax(system, prompt, maxTokens);
  if (model.provider === "anthropic") {
    if (!KEYS.anthropic) throw new Error("ANTHROPIC_API_KEY not available");
    return callAnthropic(model.id, system, prompt, maxTokens);
  }
  return callOpenRouter(model.id, system, prompt, maxTokens);
}

// --- Automated quality scoring via Sonnet judge ---
async function judgeResponse(test: TestCase, response: string): Promise<{ score: number; reason: string }> {
  const judgePrompt = `Rate this AI response on a scale of 1-5 based on the criteria.

TASK: ${test.name}
SYSTEM PROMPT: ${test.system}
USER PROMPT: ${test.prompt}

CRITERIA: ${test.criteria}

RESPONSE TO JUDGE:
---
${response.slice(0, 1000)}
---

Scoring:
5 = Perfect — meets all criteria, concise, accurate
4 = Good — meets most criteria, minor issues
3 = Acceptable — gets the job done but has notable gaps
2 = Poor — misses key criteria or has significant issues
1 = Fail — wrong answer, hallucinations, or completely off-topic

Respond with ONLY JSON: {"score": N, "reason": "brief explanation"}`;

  try {
    // Use Gemini 2.5 Flash as judge — cheap, good at structured evaluation
    const result = await callOpenRouter("google/gemini-2.5-flash", "You are a strict but fair AI response quality judge. Be concise.", judgePrompt, 150);
    const raw = result.content.trim();
    // Extract JSON from response (some models wrap in markdown)
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return { score: -1, reason: "judge returned non-JSON" };
    const parsed = JSON.parse(jsonMatch[0]);
    return { score: parsed.score, reason: parsed.reason };
  } catch {
    return { score: -1, reason: "judge failed" };
  }
}

// --- Main ---
interface Result {
  model: string;
  modelLabel: string;
  tier: number;
  test: string;
  category: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  costCents: number;
  score: number;
  scoreReason: string;
  response: string;
  error?: string;
}

async function main() {
  console.log("=== NyxHive Model Benchmark v2 ===");
  console.log(`Testing ${MODELS.length} models x ${TESTS.length} tasks = ${MODELS.length * TESTS.length} calls\n`);

  const results: Result[] = [];

  for (const model of MODELS) {
    console.log(`--- ${model.label} (T${model.tier}, ${model.provider}) ---`);

    for (const test of TESTS) {
      try {
        const r = await callModel(model, test.system, test.prompt, test.maxTokens);
        const costCents = ((r.inputTokens * model.inputRate / 1_000_000) + (r.outputTokens * model.outputRate / 1_000_000)) * 100;
        const judge = await judgeResponse(test, r.content);

        results.push({
          model: model.id, modelLabel: model.label, tier: model.tier,
          test: test.name, category: test.category,
          latencyMs: r.latencyMs, inputTokens: r.inputTokens, outputTokens: r.outputTokens,
          costCents, score: judge.score, scoreReason: judge.reason,
          response: r.content,
        });
        console.log(`  ${test.name}: ${r.latencyMs}ms, score=${judge.score}/5, $${costCents.toFixed(4)}c`);
      } catch (err: any) {
        results.push({
          model: model.id, modelLabel: model.label, tier: model.tier,
          test: test.name, category: test.category,
          latencyMs: 0, inputTokens: 0, outputTokens: 0,
          costCents: 0, score: 0, scoreReason: "error",
          response: "", error: err.message,
        });
        console.log(`  ${test.name}: ERROR — ${err.message}`);
      }
    }
    console.log();
  }

  // --- Summary by model ---
  console.log("\n=== RESULTS BY MODEL ===\n");
  console.log("Model                  | Tier | Avg Score | Avg Latency | Avg Cost    | Pass Rate |");
  console.log("-----------------------|------|-----------|-------------|-------------|-----------|");
  for (const model of MODELS) {
    const mr = results.filter(r => r.model === model.id && !r.error);
    if (mr.length === 0) { console.log(`${model.label.padEnd(22)} | T${model.tier}   | -         | -           | -           | 0%        |`); continue; }
    const avgScore = (mr.reduce((s, r) => s + r.score, 0) / mr.length).toFixed(1);
    const avgLatency = `${Math.round(mr.reduce((s, r) => s + r.latencyMs, 0) / mr.length)}ms`.padStart(11);
    const avgCost = `$${(mr.reduce((s, r) => s + r.costCents, 0) / mr.length).toFixed(4)}c`.padStart(11);
    const passRate = `${Math.round(mr.filter(r => r.score >= 3).length / mr.length * 100)}%`.padStart(9);
    console.log(`${model.label.padEnd(22)} | T${model.tier}   | ${avgScore.padStart(9)} | ${avgLatency} | ${avgCost} | ${passRate} |`);
  }

  // --- Summary by category ---
  console.log("\n=== BEST MODEL PER CATEGORY ===\n");
  const categories = [...new Set(TESTS.map(t => t.category))];
  for (const cat of categories) {
    const catResults = results.filter(r => r.category === cat && !r.error && r.score > 0);
    if (catResults.length === 0) continue;

    // Group by model, pick highest avg score, then cheapest
    const byModel = new Map<string, Result[]>();
    for (const r of catResults) {
      if (!byModel.has(r.model)) byModel.set(r.model, []);
      byModel.get(r.model)!.push(r);
    }

    const ranked = [...byModel.entries()]
      .map(([model, rs]) => ({
        model,
        label: rs[0].modelLabel,
        tier: rs[0].tier,
        avgScore: rs.reduce((s, r) => s + r.score, 0) / rs.length,
        avgCost: rs.reduce((s, r) => s + r.costCents, 0) / rs.length,
        avgLatency: rs.reduce((s, r) => s + r.latencyMs, 0) / rs.length,
      }))
      .sort((a, b) => b.avgScore - a.avgScore || a.avgCost - b.avgCost);

    console.log(`${cat.toUpperCase()}:`);
    for (const r of ranked.slice(0, 3)) {
      const marker = r === ranked[0] ? " <-- BEST" : "";
      console.log(`  ${r.label} (T${r.tier}): score=${r.avgScore.toFixed(1)}, cost=$${r.avgCost.toFixed(4)}c, latency=${Math.round(r.avgLatency)}ms${marker}`);
    }
    console.log();
  }

  // --- Detailed scores ---
  console.log("\n=== DETAILED SCORES ===\n");
  for (const test of TESTS) {
    console.log(`${test.name}:`);
    const tr = results.filter(r => r.test === test.name).sort((a, b) => b.score - a.score);
    for (const r of tr) {
      const status = r.error ? "ERROR" : `${r.score}/5`;
      const reason = r.error ? r.error : r.scoreReason;
      console.log(`  ${r.modelLabel.padEnd(22)} ${status.padEnd(6)} ${reason.slice(0, 80)}`);
    }
    console.log();
  }

  // --- Save raw results ---
  const outPath = "data/benchmark-results.json";
  const outData = results.map(r => ({ ...r, response: r.response.slice(0, 500) }));
  Bun.write(outPath, JSON.stringify(outData, null, 2));
  console.log(`Raw results saved to ${outPath}`);

  const totalCost = results.reduce((s, r) => s + r.costCents, 0);
  console.log(`\nTotal benchmark cost: $${(totalCost / 100).toFixed(4)} (includes judge calls)`);
}

main().catch(console.error);

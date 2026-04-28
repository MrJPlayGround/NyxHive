#!/usr/bin/env bun
/**
 * Model benchmark round 2 — tests new ultra-cheap models + MiniMax.
 * Focus: heartbeat, classification, scout tasks that will scale.
 */

import { readFileSync } from "fs";

function loadKeys(): { openrouter: string; minimax: string } {
  let openrouter = process.env.OPENROUTER_API_KEY ?? "";
  let minimax = process.env.MINIMAX_API_KEY ?? "";
  if (!openrouter || !minimax) {
    try {
      const envFile = readFileSync(`${process.env.HOME}/.nyxhive/instances/NyxAI/env`, "utf-8");
      for (const line of envFile.split("\n")) {
        const [key, ...rest] = line.split("=");
        const val = rest.join("=").trim();
        if (key === "OPENROUTER_API_KEY" && !openrouter) openrouter = val;
        if (key === "MINIMAX_API_KEY" && !minimax) minimax = val;
      }
    } catch {}
  }
  if (!openrouter) { console.error("Missing OPENROUTER_API_KEY"); process.exit(1); }
  if (!minimax) { console.error("Missing MINIMAX_API_KEY"); process.exit(1); }
  return { openrouter, minimax };
}

const KEYS = loadKeys();

interface ModelDef {
  id: string;
  label: string;
  provider: "openrouter" | "minimax";
  inputRate: number;
  outputRate: number;
}

const MODELS: ModelDef[] = [
  // Current roster
  { id: "MiniMax-M2.5", label: "MiniMax M2.5", provider: "minimax", inputRate: 0, outputRate: 0 },
  { id: "google/gemini-2.0-flash-lite-001", label: "Gemini Flash Lite", provider: "openrouter", inputRate: 0.075, outputRate: 0.30 },
  { id: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash", provider: "openrouter", inputRate: 0.30, outputRate: 2.50 },
  { id: "qwen/qwen3-235b-a22b-2507", label: "Qwen3 235B", provider: "openrouter", inputRate: 0.071, outputRate: 0.10 },
  { id: "xiaomi/mimo-v2-flash", label: "MiMo v2 Flash", provider: "openrouter", inputRate: 0.09, outputRate: 0.29 },
  // New ultra-cheap models
  { id: "qwen/qwen3.5-flash-02-23", label: "Qwen3.5 Flash", provider: "openrouter", inputRate: 0.0001, outputRate: 0.0004 },
  { id: "bytedance-seed/seed-2.0-mini", label: "Seed 2.0 Mini", provider: "openrouter", inputRate: 0.0001, outputRate: 0.0004 },
  { id: "qwen/qwen3.5-122b-a10b", label: "Qwen3.5 122B MoE", provider: "openrouter", inputRate: 0.0004, outputRate: 0.0032 },
  { id: "aion-labs/aion-2.0", label: "Aion 2.0", provider: "openrouter", inputRate: 0.0008, outputRate: 0.0016 },
];

interface TestCase {
  name: string;
  category: string;
  system: string;
  prompt: string;
  maxTokens: number;
  criteria: string;
}

const TESTS: TestCase[] = [
  {
    name: "heartbeat-ok",
    category: "heartbeat",
    system: "You are a system health monitor. If everything is fine, respond with just 'ok'. If something needs attention, use [@alert: message].",
    prompt: "System status:\n- Queue: 0 pending, 1 processing, 847 completed\n- Providers: anthropic=idle, openrouter=idle, minimax=idle\n- Last error: none in 24h\n- Uptime: 72h",
    maxTokens: 50,
    criteria: "Must respond with 'ok' or very brief all-clear. Must NOT hallucinate issues. Shorter is better. Ideal response is just 'ok'.",
  },
  {
    name: "heartbeat-alert",
    category: "heartbeat",
    system: "You are a system health monitor. If everything is fine, respond with just 'ok'. If something needs attention, use [@alert: message].",
    prompt: "System status:\n- Queue: 23 pending, 0 processing, 847 completed\n- Providers: anthropic=error (3 failures in 60s), openrouter=idle\n- Last error: '429 Too Many Requests' from anthropic at 14:32\n- Uptime: 72h",
    maxTokens: 150,
    criteria: "Must identify BOTH: (1) queue backup (23 pending, 0 processing), (2) Anthropic error. Must use [@alert:] tag. Must NOT miss either anomaly.",
  },
  {
    name: "heartbeat-budget",
    category: "heartbeat",
    system: "You are a budget monitor. Flag overspend. Be concise.",
    prompt: "Daily spend: $25.42. Daily budget: $8. Forge: 12 calls, $15.40, 2 failures. Scout: 3 calls, $3.80, 1 failure.",
    maxTokens: 150,
    criteria: "Must flag budget overrun ($25 vs $8). Must note failure rates. Concise — under 5 sentences.",
  },
  {
    name: "classify-simple",
    category: "classification",
    system: "Classify this prompt. Respond with ONLY JSON: {\"task_type\": \"...\", \"tier\": N}\nTypes: trivial, simple_qa, conversation, analysis, coding, code_review, expert, research, summarization, orchestrator\nTiers: 1-4 (cheap to top)",
    prompt: "what's the capital of Portugal?",
    maxTokens: 50,
    criteria: "Must return valid JSON with task_type='simple_qa' and tier=1. No text outside JSON.",
  },
  {
    name: "classify-coding",
    category: "classification",
    system: "Classify this prompt. Respond with ONLY JSON: {\"task_type\": \"...\", \"tier\": N}\nTypes: trivial, simple_qa, conversation, analysis, coding, code_review, expert, research, summarization, orchestrator\nTiers: 1-4 (cheap to top)",
    prompt: "implement a retry mechanism with exponential backoff and circuit breaker for the API client",
    maxTokens: 50,
    criteria: "Must return valid JSON with task_type='coding' and tier=3 or 4. No text outside JSON.",
  },
  {
    name: "classify-trap",
    category: "classification",
    system: "Classify this prompt. Respond with ONLY JSON: {\"task_type\": \"...\", \"tier\": N}\nTypes: trivial, simple_qa, conversation, analysis, coding, code_review, expert, research, summarization, orchestrator\nTiers: 1-4 (cheap to top)",
    prompt: "quick fix for the auth bug",
    maxTokens: 50,
    criteria: "Must return valid JSON with task_type='coding' and tier >= 2. 'quick fix' is user minimization — still a coding task. No text outside JSON.",
  },
  {
    name: "scout-propose",
    category: "scout",
    system: "You are a code quality scout. Generate proposals using [@propose: title=\"...\" category=... description=\"...\" effort=... files=\"...\"] tags.",
    prompt: "Findings:\n1. Empty catch block: src/agents/invoke.ts:67 — catch {} with no logging\n2. Dead export: 'export function oldClassify()' in router.ts — 0 imports\n\nGenerate proposals for both findings.",
    maxTokens: 400,
    criteria: "Must generate exactly 2 [@propose:] tags with correct format. Must include title, category, description, effort, files fields.",
  },
  {
    name: "summarize",
    category: "scribe",
    system: "Summarize technical changes concisely for a changelog.",
    prompt: "Commits:\n- feat: wire soul model_capabilities into agent registry\n- feat: replace manual floor/ceiling with routeWithTier()\n- chore: remove duplicate MODEL_TIER_ALIASES\n\nAll part of 'model routing soul integration'.",
    maxTokens: 150,
    criteria: "Concise changelog entry (3-5 bullets or short paragraph). Must capture: model routing moved from TOML to soul system. Not verbose.",
  },
];

// --- API calls ---
async function callOpenRouter(modelId: string, system: string, prompt: string, maxTokens: number) {
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
      max_tokens: maxTokens, temperature: 0.3,
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

async function callMiniMax(system: string, prompt: string, maxTokens: number) {
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
      max_tokens: maxTokens, temperature: 0.3,
    }),
  });
  const data = await res.json() as any;
  if (data.base_resp?.status_code && data.base_resp.status_code !== 0) {
    throw new Error(data.base_resp?.status_msg ?? `MiniMax error ${data.base_resp.status_code}`);
  }
  return {
    content: data.choices?.[0]?.message?.content ?? "",
    inputTokens: data.usage?.prompt_tokens ?? 0,
    outputTokens: data.usage?.completion_tokens ?? 0,
    latencyMs: Date.now() - start,
  };
}

async function callModel(model: ModelDef, system: string, prompt: string, maxTokens: number) {
  if (model.provider === "minimax") return callMiniMax(system, prompt, maxTokens);
  return callOpenRouter(model.id, system, prompt, maxTokens);
}

// Judge via Gemini 2.5 Flash
async function judge(test: TestCase, response: string): Promise<{ score: number; reason: string }> {
  const prompt = `Rate this AI response 1-5 based on criteria.

TASK: ${test.name}
CRITERIA: ${test.criteria}

RESPONSE:
---
${response.slice(0, 800)}
---

5=Perfect, 4=Good, 3=Acceptable, 2=Poor, 1=Fail
Respond with ONLY JSON: {"score": N, "reason": "brief"}`;

  try {
    const r = await callOpenRouter("google/gemini-2.5-flash", "You are a strict quality judge. Be concise.", prompt, 100);
    const match = r.content.match(/\{[\s\S]*\}/);
    if (!match) return { score: -1, reason: "no JSON" };
    const parsed = JSON.parse(match[0]);
    return { score: parsed.score, reason: parsed.reason };
  } catch { return { score: -1, reason: "judge failed" }; }
}

// --- Main ---
async function main() {
  console.log(`=== Model Benchmark Round 2 === (${MODELS.length} models x ${TESTS.length} tests)\n`);

  const results: Array<{
    model: string; label: string; test: string; category: string;
    latencyMs: number; costCents: number; score: number; reason: string;
    response: string; error?: string;
  }> = [];

  for (const model of MODELS) {
    console.log(`--- ${model.label} (${model.provider}) ---`);
    for (const test of TESTS) {
      try {
        const r = await callModel(model, test.system, test.prompt, test.maxTokens);
        const costCents = ((r.inputTokens * model.inputRate + r.outputTokens * model.outputRate) / 1_000_000) * 100;
        const j = await judge(test, r.content);
        results.push({ model: model.id, label: model.label, test: test.name, category: test.category,
          latencyMs: r.latencyMs, costCents, score: j.score, reason: j.reason, response: r.content });
        console.log(`  ${test.name.padEnd(18)} ${r.latencyMs}ms\tscore=${j.score}/5\t$${costCents.toFixed(6)}c`);
      } catch (err: any) {
        results.push({ model: model.id, label: model.label, test: test.name, category: test.category,
          latencyMs: 0, costCents: 0, score: 0, reason: "error", response: "", error: err.message });
        console.log(`  ${test.name.padEnd(18)} ERROR: ${err.message.slice(0, 60)}`);
      }
    }
    console.log();
  }

  // --- Leaderboard ---
  console.log("\n=== LEADERBOARD ===\n");
  console.log("Model                  | Avg Score | Avg Latency | Avg Cost/call | Pass (>=3) |");
  console.log("-----------------------|-----------|-------------|---------------|------------|");

  const modelIds = [...new Set(results.map(r => r.model))];
  const leaderboard = modelIds.map(id => {
    const mr = results.filter(r => r.model === id && !r.error);
    const label = mr[0]?.label ?? id;
    if (mr.length === 0) return { id, label, avgScore: 0, avgLatency: 0, avgCost: 0, passRate: 0, count: 0 };
    return {
      id, label,
      avgScore: mr.reduce((s, r) => s + r.score, 0) / mr.length,
      avgLatency: mr.reduce((s, r) => s + r.latencyMs, 0) / mr.length,
      avgCost: mr.reduce((s, r) => s + r.costCents, 0) / mr.length,
      passRate: mr.filter(r => r.score >= 3).length / mr.length,
      count: mr.length,
    };
  }).sort((a, b) => b.avgScore - a.avgScore || a.avgCost - b.avgCost);

  for (const m of leaderboard) {
    if (m.count === 0) { console.log(`${m.label.padEnd(22)} | FAILED    |             |               |            |`); continue; }
    console.log(`${m.label.padEnd(22)} | ${m.avgScore.toFixed(1).padStart(9)} | ${(Math.round(m.avgLatency) + "ms").padStart(11)} | $${m.avgCost.toFixed(6).padStart(11)}c | ${(Math.round(m.passRate * 100) + "%").padStart(10)} |`);
  }

  // --- Best per category ---
  console.log("\n=== BEST PER CATEGORY ===\n");
  const categories = [...new Set(TESTS.map(t => t.category))];
  for (const cat of categories) {
    const cr = results.filter(r => r.category === cat && !r.error && r.score > 0);
    const byModel = new Map<string, typeof cr>();
    for (const r of cr) { if (!byModel.has(r.model)) byModel.set(r.model, []); byModel.get(r.model)!.push(r); }

    const ranked = [...byModel.entries()]
      .map(([, rs]) => ({
        label: rs[0].label,
        avgScore: rs.reduce((s, r) => s + r.score, 0) / rs.length,
        avgCost: rs.reduce((s, r) => s + r.costCents, 0) / rs.length,
        avgLatency: rs.reduce((s, r) => s + r.latencyMs, 0) / rs.length,
      }))
      .sort((a, b) => b.avgScore - a.avgScore || a.avgCost - b.avgCost);

    console.log(`${cat.toUpperCase()}:`);
    for (const r of ranked.slice(0, 4)) {
      const best = r === ranked[0] ? " <--" : "";
      console.log(`  ${r.label.padEnd(22)} score=${r.avgScore.toFixed(1)}  cost=$${r.avgCost.toFixed(6)}c  ${Math.round(r.avgLatency)}ms${best}`);
    }
    console.log();
  }

  // --- Problem responses ---
  console.log("=== FAILURES & LOW SCORES ===\n");
  for (const r of results.filter(r => r.score <= 2 || r.error)) {
    console.log(`${r.label} / ${r.test}: ${r.error ? "ERROR: " + r.error.slice(0, 80) : "score=" + r.score + " — " + r.reason}`);
    if (!r.error && r.response) console.log(`  Response: ${r.response.slice(0, 200)}\n`);
  }

  Bun.write("data/benchmark-round2.json", JSON.stringify(results.map(r => ({ ...r, response: r.response.slice(0, 500) })), null, 2));
  console.log("\nResults saved to data/benchmark-round2.json");
}

main().catch(console.error);

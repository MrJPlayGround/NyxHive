#!/usr/bin/env bun
/**
 * Model benchmark round 3 — DeepSeek + Llama 4 vs current roster.
 * Focus: can these replace Sonnet for Researcher/Tester/Vigil tier tasks?
 * Also tests analysis, code_review, and longer reasoning tasks.
 */

import { readFileSync } from "fs";

function loadKeys(): { openrouter: string } {
  let openrouter = process.env.OPENROUTER_API_KEY ?? "";
  if (!openrouter) {
    try {
      const envFile = readFileSync(`${process.env.HOME}/.nyxhive/instances/NyxAI/env`, "utf-8");
      for (const line of envFile.split("\n")) {
        const [key, ...rest] = line.split("=");
        const val = rest.join("=").trim();
        if (key === "OPENROUTER_API_KEY" && !openrouter) openrouter = val;
      }
    } catch {}
  }
  if (!openrouter) { console.error("Missing OPENROUTER_API_KEY"); process.exit(1); }
  return { openrouter };
}

const KEYS = loadKeys();

interface ModelDef {
  id: string;
  label: string;
  inputRate: number;  // $ per million tokens
  outputRate: number;
}

const MODELS: ModelDef[] = [
  // Current tier 2-3 roster (baselines)
  { id: "xiaomi/mimo-v2-flash",             label: "MiMo v2 Flash",      inputRate: 0.09,  outputRate: 0.29 },
  { id: "google/gemini-2.5-flash",          label: "Gemini 2.5 Flash",   inputRate: 0.30,  outputRate: 2.50 },
  { id: "qwen/qwen3-235b-a22b-2507",        label: "Qwen3 235B",         inputRate: 0.071, outputRate: 0.10 },
  // DeepSeek
  { id: "deepseek/deepseek-v3.2",           label: "DeepSeek V3.2",      inputRate: 0.25,  outputRate: 0.40 },
  { id: "deepseek/deepseek-v3.2-speciale",  label: "DeepSeek Speciale",  inputRate: 0.40,  outputRate: 1.20 },
  { id: "deepseek/deepseek-r1",             label: "DeepSeek R1",        inputRate: 0.70,  outputRate: 2.50 },
  // Llama 4
  { id: "meta-llama/llama-4-scout",         label: "Llama 4 Scout",      inputRate: 0.08,  outputRate: 0.30 },
  { id: "meta-llama/llama-4-maverick",      label: "Llama 4 Maverick",   inputRate: 0.15,  outputRate: 0.60 },
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
  // --- Heartbeat (baseline — MiMo should crush these) ---
  {
    name: "heartbeat-alert",
    category: "heartbeat",
    system: "You are a system health monitor. If everything is fine, respond with just 'ok'. If something needs attention, use [@alert: message].",
    prompt: "System status:\n- Queue: 23 pending, 0 processing, 847 completed\n- Providers: anthropic=error (3 failures in 60s), openrouter=idle\n- Last error: '429 Too Many Requests' from anthropic at 14:32\n- Uptime: 72h",
    maxTokens: 150,
    criteria: "Must identify BOTH: (1) queue backup (23 pending, 0 processing), (2) Anthropic error. Must use [@alert:] tag. Must NOT miss either anomaly.",
  },
  // --- Classification ---
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
    criteria: "Must return valid JSON with task_type='coding' and tier >= 2. 'quick fix' is user minimization - still a coding task. No text outside JSON.",
  },
  // --- Analysis (key tier 3 task — can these replace Sonnet?) ---
  {
    name: "analysis-usage",
    category: "analysis",
    system: "You are an AI system analyst. Analyze data and provide actionable insights. Be concise and specific.",
    prompt: "Agent usage last 7 days:\n- Forge: 47 invocations, $12.30, 3 failures, avg 45s\n- Scout: 23 invocations, $0.85, 1 failure, avg 8s\n- Scribe: 12 invocations, $0.02, 0 failures, avg 2s\n- Nyx: 89 invocations, $18.50, 0 failures, avg 12s\n- Researcher: 5 invocations, $3.20, 2 failures, avg 120s\n\nTotal: $34.87 (budget: $50/week)\n\nIdentify: (1) cost optimization opportunities, (2) reliability concerns, (3) any anomalies.",
    maxTokens: 400,
    criteria: "Must identify: Nyx is most expensive per-call ($0.21), Researcher has 40% failure rate, Forge dominates cost. Should suggest concrete actions (not vague). Must be structured and concise.",
  },
  {
    name: "analysis-pattern",
    category: "analysis",
    system: "You are a pattern analyst for a multi-agent AI system. Identify trends and anomalies.",
    prompt: "Recent git commits (last 7 days):\n- fix: handle null response from minimax\n- fix: minimax timeout on large prompts\n- feat: add minimax retry logic\n- fix: strip think tags from minimax response\n- chore: increase minimax timeout to 30s\n- feat: add fallback when minimax fails\n- fix: minimax rate limit handling\n\nWhat pattern do you see? What would you recommend?",
    maxTokens: 300,
    criteria: "Must identify the pattern: all 7 commits are MiniMax-related fixes, suggesting systemic reliability issues. Should recommend evaluating MiniMax alternatives or reducing dependency. Concise, not verbose.",
  },
  // --- Code Review (can these spot issues without running code?) ---
  {
    name: "code-review",
    category: "code_review",
    system: "Review this code for bugs, security issues, and improvements. Be specific with line references.",
    prompt: "```typescript\nasync function processMessage(msg: any) {\n  const user = await db.query(`SELECT * FROM users WHERE id = '${msg.userId}'`);\n  if (!user) return;\n  \n  const result = await fetch(msg.url);\n  const data = await result.json();\n  \n  try {\n    await db.query(`INSERT INTO logs (user_id, data) VALUES ('${user.id}', '${JSON.stringify(data)}')`);\n  } catch {}\n  \n  return data;\n}\n```",
    maxTokens: 400,
    criteria: "MUST identify: (1) SQL injection on msg.userId, (2) SQL injection on data insert, (3) SSRF via msg.url (user-controlled fetch), (4) empty catch block swallows errors, (5) 'any' type. Missing any of the first 3 is a fail.",
  },
  // --- Scout (structured output with action tags) ---
  {
    name: "scout-propose",
    category: "scout",
    system: "You are a code quality scout. Generate proposals using [@propose: title=\"...\" category=... description=\"...\" effort=... files=\"...\"] tags.",
    prompt: "Findings:\n1. Empty catch block: src/agents/invoke.ts:67 - catch {} with no logging\n2. Dead export: 'export function oldClassify()' in router.ts - 0 imports\n\nGenerate proposals for both findings.",
    maxTokens: 400,
    criteria: "Must generate exactly 2 [@propose:] tags with correct format. Must include title, category, description, effort, files fields.",
  },
  // --- Research (longer reasoning, synthesis) ---
  {
    name: "research-compare",
    category: "research",
    system: "You are a technical researcher. Compare technologies objectively with pros/cons. Be concise but thorough.",
    prompt: "Compare SQLite vs PostgreSQL for a multi-agent AI orchestrator that:\n- Runs on a single Mac Mini\n- Has 10 agents, ~100 messages/hour\n- Stores conversation history, execution traces, proposals\n- Needs full-text search\n- Data is ~500MB and growing slowly\n- Zero-ops is important (single developer)\n\nWhich should we use and why?",
    maxTokens: 500,
    criteria: "Must recommend SQLite (correct for this use case). Must cite: zero-ops, single-server, low write volume, FTS5 support. Must acknowledge PostgreSQL strengths fairly. Structured comparison, not just opinion.",
  },
  // --- Summarization ---
  {
    name: "summarize-technical",
    category: "summarization",
    system: "Summarize technical changes concisely for a changelog.",
    prompt: "Commits:\n- feat: wire soul model_capabilities into agent registry\n- feat: replace manual floor/ceiling with routeWithTier()\n- chore: remove duplicate MODEL_TIER_ALIASES\n- feat: update routing table — MiMo for classification + worker_subtask\n- fix: bump MiMo to tier 2 in MODEL_TIERS\n\nAll part of 'model routing soul integration'.",
    maxTokens: 200,
    criteria: "Concise changelog entry (3-5 bullets or short paragraph). Must capture: soul system now controls model routing bounds, routeWithTier replaces manual logic, MiMo promoted for cheap tasks. Not verbose.",
  },
  // --- Delegation understanding (orchestrator-adjacent) ---
  {
    name: "delegation-parse",
    category: "orchestrator",
    system: "You are an AI orchestrator. Parse the user request and decide which agent(s) to delegate to. Available agents:\n- Forge: coding, implementation\n- Tester: test writing, test running\n- Scout: code scanning, quality checks\n- Researcher: external research, comparisons\n- Scribe: documentation, summaries\n\nRespond with delegation tags: [@agent: task description]",
    prompt: "Run the test suite, fix any failures, then write a summary of what was broken.",
    maxTokens: 300,
    criteria: "Must delegate to at least Tester (run tests) and Forge (fix failures). Scribe for summary is a bonus. Must use [@agent:] tag format. Must chain tasks logically (test first, then fix, then summarize).",
  },
];

// --- API call ---
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
  // Strip think tags (DeepSeek R1 uses them)
  let content = data.choices?.[0]?.message?.content ?? "";
  content = content.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  return {
    content,
    inputTokens: data.usage?.prompt_tokens ?? 0,
    outputTokens: data.usage?.completion_tokens ?? 0,
    latencyMs: Date.now() - start,
  };
}

// Judge via Gemini 2.5 Flash
async function judge(test: TestCase, response: string): Promise<{ score: number; reason: string }> {
  const prompt = `Rate this AI response 1-5 based on criteria.

TASK: ${test.name}
CRITERIA: ${test.criteria}

RESPONSE:
---
${response.slice(0, 1000)}
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
  console.log(`=== Model Benchmark Round 3 === (${MODELS.length} models x ${TESTS.length} tests)\n`);
  console.log("Focus: DeepSeek + Llama 4 vs current roster for tier 2-3 tasks\n");

  const results: Array<{
    model: string; label: string; test: string; category: string;
    latencyMs: number; costCents: number; score: number; reason: string;
    response: string; error?: string;
  }> = [];

  for (const model of MODELS) {
    console.log(`--- ${model.label} ---`);
    for (const test of TESTS) {
      try {
        const r = await callOpenRouter(model.id, test.system, test.prompt, test.maxTokens);
        const costCents = ((r.inputTokens * model.inputRate + r.outputTokens * model.outputRate) / 1_000_000) * 100;
        const j = await judge(test, r.content);
        results.push({ model: model.id, label: model.label, test: test.name, category: test.category,
          latencyMs: r.latencyMs, costCents, score: j.score, reason: j.reason, response: r.content });
        console.log(`  ${test.name.padEnd(20)} ${r.latencyMs}ms\tscore=${j.score}/5\t$${costCents.toFixed(6)}c`);
      } catch (err: any) {
        results.push({ model: model.id, label: model.label, test: test.name, category: test.category,
          latencyMs: 0, costCents: 0, score: 0, reason: "error", response: "", error: err.message });
        console.log(`  ${test.name.padEnd(20)} ERROR: ${err.message.slice(0, 60)}`);
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
    for (const r of ranked.slice(0, 5)) {
      const best = r === ranked[0] ? " <--" : "";
      console.log(`  ${r.label.padEnd(22)} score=${r.avgScore.toFixed(1)}  cost=$${r.avgCost.toFixed(6)}c  ${Math.round(r.avgLatency)}ms${best}`);
    }
    console.log();
  }

  // --- Sonnet replacement analysis ---
  console.log("=== SONNET REPLACEMENT CANDIDATES ===\n");
  console.log("For tier 3 agents (Researcher, Tester, Vigil) — need score >= 4.0 on analysis + code_review:\n");
  for (const m of leaderboard) {
    if (m.count === 0) continue;
    const analysisResults = results.filter(r => r.model === m.id && (r.category === "analysis" || r.category === "code_review") && !r.error);
    if (analysisResults.length === 0) continue;
    const avgAnalysis = analysisResults.reduce((s, r) => s + r.score, 0) / analysisResults.length;
    const viable = avgAnalysis >= 4.0 ? "VIABLE" : "NO";
    console.log(`  ${m.label.padEnd(22)} analysis+review avg=${avgAnalysis.toFixed(1)}  overall=${m.avgScore.toFixed(1)}  cost=$${m.avgCost.toFixed(6)}c  ${viable}`);
  }

  // --- Problem responses ---
  console.log("\n=== FAILURES & LOW SCORES ===\n");
  for (const r of results.filter(r => r.score <= 2 || r.error)) {
    console.log(`${r.label} / ${r.test}: ${r.error ? "ERROR: " + r.error.slice(0, 80) : "score=" + r.score + " — " + r.reason}`);
    if (!r.error && r.response) console.log(`  Response: ${r.response.slice(0, 200)}\n`);
  }

  Bun.write("data/benchmark-round3.json", JSON.stringify(results.map(r => ({ ...r, response: r.response.slice(0, 500) })), null, 2));
  console.log("\nResults saved to data/benchmark-round3.json");
}

main().catch(console.error);

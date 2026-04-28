#!/usr/bin/env bun
/**
 * Model benchmark: Tests non-Anthropic models against representative agent workloads.
 * Compares T2 (Haiku alternatives) and T3 (Sonnet alternatives) candidates.
 *
 * Usage: source ~/.nyxhive/instances/NyxAI/env && bun scripts/benchmark-models.ts
 */

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
if (!OPENROUTER_API_KEY) {
  console.error("Missing OPENROUTER_API_KEY. Run: source ~/.nyxhive/instances/NyxAI/env");
  process.exit(1);
}

// ── Models to test ──

interface ModelDef {
  id: string;
  name: string;
  tier: number;
  costIn: number;   // per M tokens
  costOut: number;
}

const MODELS: ModelDef[] = [
  // T2 candidates (Haiku replacements)
  { id: "xiaomi/mimo-v2-flash",             name: "MiMo v2 Flash",         tier: 2, costIn: 0.09,  costOut: 0.29 },
  { id: "google/gemini-2.5-flash-preview-05-20", name: "Gemini 2.5 Flash",      tier: 2, costIn: 0.15,  costOut: 0.60 },
  { id: "google/gemini-2.0-flash-lite-001", name: "Gemini 2.0 Flash Lite", tier: 1, costIn: 0.075, costOut: 0.30 },
  { id: "qwen/qwen3-235b-a22b-2507",       name: "Qwen3 235B",            tier: 2, costIn: 0.071, costOut: 0.10 },
  { id: "meta-llama/llama-4-maverick",      name: "Llama 4 Maverick",      tier: 2, costIn: 0.20,  costOut: 0.60 },
  // T3 candidates (Sonnet replacements)
  { id: "mistralai/mistral-medium-3",       name: "Mistral Medium 3",      tier: 3, costIn: 0.40,  costOut: 2.00 },
  { id: "google/gemini-2.5-pro-preview-05-06", name: "Gemini 2.5 Pro",        tier: 3, costIn: 1.25,  costOut: 10.0 },
];

// ── Test prompts (representative of actual agent workloads) ──

interface TestCase {
  name: string;
  taskType: string;
  targetTier: string; // "T2" or "T3" — which tier this tests
  prompt: string;
  system: string;
  criteria: string[];  // what to check in the output
}

const TESTS: TestCase[] = [
  // --- T2 tests (Haiku-level: scout housekeeping, simple analysis) ---
  {
    name: "Scout: Stale plan detection",
    taskType: "coding",
    targetTier: "T2",
    prompt: `Analyze these plan files and determine which are stale (already shipped).

Plan files:
- plans/ios-fixes-batch.md (created 2026-02-28)
- plans/proposal-pipeline-redesign.md (created 2026-02-25)
- plans/opencode-integration.md (created 2026-03-02)

Recent git log:
- 2026-03-01: "feat: ship iOS fixes batch — agent filter, alt-tab, kanban"
- 2026-03-01: "feat: proposal pipeline redesign complete"
- 2026-03-02: "feat: add OpenCode CLI integration" (branch: feat/opencode-integration, not merged)

For each stale plan, output a [@propose:] tag:
[@propose: title="..." description="..." category=maintenance effort=small files="..." scout_source="scout:housekeeping"]`,
    system: "You are Scout Lite, a lightweight discovery agent. Report findings with evidence. Use [@propose:] tags for actionable items. Be concise.",
    criteria: [
      "Correctly identifies ios-fixes-batch.md as stale (shipped 2026-03-01)",
      "Correctly identifies proposal-pipeline-redesign.md as stale (shipped 2026-03-01)",
      "Does NOT flag opencode-integration.md as stale (not merged yet)",
      "Uses [@propose:] tag format with required fields",
      "Includes file paths as evidence",
    ],
  },
  {
    name: "Scout: YAML validation",
    taskType: "coding",
    targetTier: "T2",
    prompt: `Validate this soul YAML for issues:

\`\`\`yaml
identity:
  name: Forge
  role: coder
  archetype: "builder"

capabilities:
  invocation: cli
  can_delegate: false
  max_tool_turns: 50
  mcp_tools:
    - search_knowledge
    - search_obsidian
    - claim_work
    - release_work
    - post_progress
    - nonexistent_tool
  allowed_directories:
    - /home/user/dev
    - /home/user/dev/nyxhive
    - /home/user/.nyxhive
    - /Users/deleted/old-project

rules:
  must:
    - "Run tests after every change"
    - "Commit with conventional commit style"
  must_not:
    - "Skip tests"
\`\`\`

Known valid MCP tools: search_knowledge, search_obsidian, list_proposals, get_proposal, list_threads, get_thread, get_queue_status, list_agents, git_log, git_status, list_projects, get_agent_status, claim_work, release_work, post_progress.

Known valid directories: /home/user/dev, /home/user/dev/nyxhive, /home/user/.nyxhive, /home/user/dev/example-mobile, /home/user/dev/example-app.

Report any invalid references.`,
    system: "You are Scout Lite, a lightweight discovery agent. Report findings with evidence. Be concise and factual.",
    criteria: [
      "Identifies 'nonexistent_tool' as invalid MCP tool",
      "Identifies '/Users/deleted/old-project' as invalid directory",
      "Does NOT flag valid tools/directories as problems",
      "Structured, clear output",
    ],
  },
  {
    name: "Worker: Structured extraction",
    taskType: "worker_subtask",
    targetTier: "T2",
    prompt: `Extract structured data from this git log:

commit a1b2c3d (HEAD -> feat/auth, origin/feat/auth)
Author: User <jay@example.com>
Date:   Mon Mar 2 09:00:00 2026

    feat: add JWT authentication middleware

    - Implement token validation in src/auth/jwt.ts
    - Add auth middleware to Hono routes
    - Create user session store in src/auth/sessions.ts
    - Add bcrypt password hashing

    Files: src/auth/jwt.ts, src/auth/sessions.ts, src/auth/middleware.ts, src/server/index.ts

commit d4e5f6g
Author: User <jay@example.com>
Date:   Sun Mar 1 15:00:00 2026

    fix: correct rate limiter window calculation

    Files: src/server/middleware.ts

Return JSON: { commits: [{ hash, type, title, files, date }] }`,
    system: "You are a worker agent. Extract structured data precisely. Return only the requested format.",
    criteria: [
      "Returns valid JSON",
      "Correctly extracts both commits",
      "Identifies 'feat' and 'fix' types",
      "Lists all files accurately",
      "No hallucinated data",
    ],
  },
  {
    name: "Conversation: Technical Q&A",
    taskType: "conversation",
    targetTier: "T2",
    prompt: "What's the difference between a cron expression '0 */4 * * *' and '0 0,4,8,12,16,20 * * *'? Which is better for running a task every 4 hours?",
    system: "You are a helpful assistant. Be concise and accurate.",
    criteria: [
      "Correctly explains both are equivalent (every 4 hours)",
      "Notes */4 is cleaner/preferred syntax",
      "Technically accurate about cron format",
      "Concise — doesn't over-explain",
    ],
  },

  // --- T3 tests (Sonnet-level: code analysis, review, complex reasoning) ---
  {
    name: "Code review: Security audit",
    taskType: "code_review",
    targetTier: "T3",
    prompt: `Review this endpoint for security issues:

\`\`\`typescript
app.post("/api/admin/users/:id/role", async (c) => {
  const userId = c.req.param("id");
  const { role } = await c.req.json();

  const db = c.get("db");
  db.run("UPDATE users SET role = '" + role + "' WHERE id = '" + userId + "'");

  return c.json({ ok: true });
});
\`\`\`

List every security issue, severity, and fix.`,
    system: "You are a security-focused code reviewer. Be thorough and precise. List issues with severity ratings.",
    criteria: [
      "Identifies SQL injection via string concatenation (critical)",
      "Identifies missing authentication/authorization check (critical)",
      "Identifies missing input validation on role (high)",
      "Suggests parameterized queries as fix",
      "Suggests auth middleware",
      "Severity ratings are reasonable",
    ],
  },
  {
    name: "Analysis: Architecture decision",
    taskType: "analysis",
    targetTier: "T3",
    prompt: `We have a multi-agent orchestrator (NyxHive) where agents are invoked as CLI subprocesses. Current problem: when Anthropic's API is down, all coding agents fail because they depend on the \`claude\` CLI binary.

We've added OpenCode as an alternative CLI for non-Anthropic models. Now we need to decide the fallback strategy:

Option A: Per-agent failover — each agent has a secondary provider/model configured. If primary fails, try secondary.
Option B: Global provider health — circuit breaker tracks provider health. When Anthropic trips, ALL agents auto-route to their best non-Anthropic equivalent.
Option C: Hybrid — circuit breaker for provider health + per-agent secondary for model preference.

Analyze trade-offs. Which approach for a small team (1 developer, 10 agents)?`,
    system: "You are a senior architect. Analyze trade-offs clearly. Consider operational complexity, reliability, and maintainability for a small team.",
    criteria: [
      "Analyzes all three options with real trade-offs",
      "Considers operational complexity for a solo dev",
      "Recommends Option A or C with reasoning (B is too complex for 1 dev)",
      "Mentions blast radius of global switches",
      "Practical, not theoretical",
    ],
  },
  {
    name: "Scout: Cross-file analysis",
    taskType: "coding",
    targetTier: "T3",
    prompt: `Analyze these two files for API/client mismatch:

**Server route (src/server/routes/proposals.ts):**
\`\`\`typescript
app.get("/api/proposals", (c) => {
  const status = c.req.query("status");
  const category = c.req.query("category");
  const limit = parseInt(c.req.query("limit") ?? "50");
  const proposals = store.list({ status, category, limit });
  return c.json(proposals);
});

app.post("/api/proposals/:id/approve", (c) => {
  const { reason } = await c.req.json();
  store.approve(c.req.param("id"), reason);
  return c.json({ ok: true });
});

app.post("/api/proposals/:id/reject", (c) => {
  const { reason } = await c.req.json();
  if (!reason) return c.json({ error: "reason required" }, 400);
  store.reject(c.req.param("id"), reason);
  return c.json({ ok: true });
});

app.delete("/api/proposals/:id", (c) => {
  store.delete(c.req.param("id"));
  return c.json({ ok: true });
});
\`\`\`

**iOS client (ProposalService.swift):**
\`\`\`swift
func listProposals(status: String? = nil) async throws -> [Proposal] {
    var url = baseURL + "/api/proposals"
    if let status { url += "?status=\\(status)" }
    return try await get(url)
}

func approveProposal(id: String) async throws {
    try await post("\\(baseURL)/api/proposals/\\(id)/approve", body: [:])
}

func rejectProposal(id: String, reason: String) async throws {
    try await post("\\(baseURL)/api/proposals/\\(id)/reject", body: ["reason": reason])
}
\`\`\`

Find mismatches between server and client.`,
    system: "You are Scout, a discovery agent. Find API/client mismatches with evidence. Be precise — cite specific lines and fields.",
    criteria: [
      "Missing: client doesn't use 'category' or 'limit' query params (server supports them)",
      "Missing: client has no deleteProposal method (server has DELETE endpoint)",
      "Missing: approve endpoint accepts 'reason' but client sends empty body",
      "Does NOT hallucinate mismatches that don't exist",
      "Cites specific code references",
    ],
  },
  {
    name: "Coding: Implement a function",
    taskType: "coding",
    targetTier: "T3",
    prompt: `Implement a function that parses NyxHive action tags from agent responses. Tags follow these formats:

1. Inline: \`[@agent: task description]\`
2. Inline with hint: \`[@agent(hint): task description]\`
3. Multi-line propose:
\`\`\`
[@propose:]
title: The title
description: Full description here
category: maintenance
effort: small
priority: medium
files: src/a.ts, src/b.ts
scout_source: scout:codebase-health
\`\`\`

Return an array of parsed tags with type, agent/fields, and raw content. Handle edge cases: nested brackets, tags inside code blocks (should be ignored), multiple tags in one response.

Write TypeScript. Include the type definitions.`,
    system: "You are Forge, a senior coder. Write clean TypeScript. Handle edge cases. No over-engineering.",
    criteria: [
      "Correct TypeScript with type definitions",
      "Handles inline [@agent: task] format",
      "Handles [@agent(hint): task] format",
      "Handles multi-line [@propose:] format",
      "Ignores tags inside code blocks",
      "Handles multiple tags in one response",
      "Clean, readable code",
    ],
  },
];

// ── API call ──

async function callModel(model: string, system: string, prompt: string): Promise<{ content: string; tokensIn: number; tokensOut: number; latencyMs: number }> {
  const start = Date.now();
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: prompt },
      ],
      max_tokens: 4096,
      temperature: 0.3,
    }),
  });

  const latencyMs = Date.now() - start;
  const data = await res.json() as any;

  if (data.error) {
    return { content: `[ERROR: ${data.error.message ?? JSON.stringify(data.error)}]`, tokensIn: 0, tokensOut: 0, latencyMs };
  }

  const choice = data.choices?.[0];
  const usage = data.usage ?? {};

  return {
    content: choice?.message?.content ?? "[empty response]",
    tokensIn: usage.prompt_tokens ?? 0,
    tokensOut: usage.completion_tokens ?? 0,
    latencyMs,
  };
}

// ── Run benchmark ──

interface Result {
  model: string;
  modelName: string;
  tier: number;
  test: string;
  targetTier: string;
  content: string;
  tokensIn: number;
  tokensOut: number;
  latencyMs: number;
  costUsd: number;
}

async function main() {
  console.log("=== NyxHive Model Benchmark ===\n");
  console.log(`Testing ${MODELS.length} models × ${TESTS.length} prompts = ${MODELS.length * TESTS.length} calls\n`);

  const results: Result[] = [];

  for (const test of TESTS) {
    console.log(`\n── ${test.name} (${test.targetTier}) ──`);

    // Only test models at or near the target tier
    const candidates = MODELS.filter(m => {
      if (test.targetTier === "T2") return m.tier <= 2;
      if (test.targetTier === "T3") return m.tier >= 2; // T2+ can attempt T3 tasks
      return true;
    });

    for (const model of candidates) {
      process.stdout.write(`  ${model.name.padEnd(22)} ... `);
      try {
        const res = await callModel(model.id, test.system, test.prompt);
        const cost = (res.tokensIn * model.costIn + res.tokensOut * model.costOut) / 1_000_000;
        results.push({
          model: model.id,
          modelName: model.name,
          tier: model.tier,
          test: test.name,
          targetTier: test.targetTier,
          content: res.content,
          tokensIn: res.tokensIn,
          tokensOut: res.tokensOut,
          latencyMs: res.latencyMs,
          costUsd: cost,
        });
        console.log(`${res.tokensOut} tok, ${res.latencyMs}ms, $${cost.toFixed(6)}`);
      } catch (err) {
        console.log(`FAILED: ${err}`);
      }
    }
  }

  // ── Output results ──
  console.log("\n\n=== RESULTS ===\n");

  // Group by test
  const byTest = new Map<string, Result[]>();
  for (const r of results) {
    const existing = byTest.get(r.test) ?? [];
    existing.push(r);
    byTest.set(r.test, existing);
  }

  for (const [testName, testResults] of byTest) {
    const test = TESTS.find(t => t.name === testName)!;
    console.log(`\n── ${testName} (${test.targetTier}) ──`);
    console.log(`Criteria: ${test.criteria.join(" | ")}\n`);

    for (const r of testResults) {
      console.log(`### ${r.modelName} (T${r.tier}) — ${r.tokensOut} tok, ${r.latencyMs}ms, $${r.costUsd.toFixed(6)}`);
      console.log(r.content.slice(0, 2000));
      if (r.content.length > 2000) console.log(`\n... (${r.content.length - 2000} more chars)`);
      console.log("\n---\n");
    }
  }

  // ── Summary table ──
  console.log("\n=== SUMMARY TABLE ===\n");
  console.log("Model".padEnd(24) + "Tier".padEnd(6) + "Avg Tok".padEnd(10) + "Avg ms".padEnd(10) + "Avg $/call".padEnd(12) + "Tests");

  const byModel = new Map<string, Result[]>();
  for (const r of results) {
    const existing = byModel.get(r.modelName) ?? [];
    existing.push(r);
    byModel.set(r.modelName, existing);
  }

  for (const [modelName, modelResults] of byModel) {
    const avgTok = Math.round(modelResults.reduce((s, r) => s + r.tokensOut, 0) / modelResults.length);
    const avgMs = Math.round(modelResults.reduce((s, r) => s + r.latencyMs, 0) / modelResults.length);
    const avgCost = modelResults.reduce((s, r) => s + r.costUsd, 0) / modelResults.length;
    const tier = modelResults[0].tier;
    console.log(
      modelName.padEnd(24) +
      `T${tier}`.padEnd(6) +
      String(avgTok).padEnd(10) +
      String(avgMs).padEnd(10) +
      `$${avgCost.toFixed(6)}`.padEnd(12) +
      String(modelResults.length)
    );
  }
}

main().catch(console.error);

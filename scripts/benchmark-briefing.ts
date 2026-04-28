#!/usr/bin/env bun
/**
 * Benchmark: Tests cheap OpenRouter models on briefing synthesis.
 * Usage: source ~/.nyxhive/instances/NyxAI/env && bun scripts/benchmark-briefing.ts
 */

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
if (!OPENROUTER_API_KEY) {
  console.error("Missing OPENROUTER_API_KEY. Run: source ~/.nyxhive/instances/NyxAI/env");
  process.exit(1);
}

const BRIEFING_CONTEXT = `## Pre-fetched Briefing Data

### Scheduled Task Results (last 24h)
- **health:check** (system) [success] at 22:30
  All systems nominal. API latency: 142ms avg. Memory: 312MB. Uptime: 47h.
- **scout:codebase-health** (scout) [success] at 03:00
  1632 tests passing, 0 failing. Coverage: 78%. Finding: queue/review-gate.ts (298L) has no tests.
- **learning:distill-patterns** (system) [success] at 02:00
  Distilled 3 new patterns from 47 traces. Top pattern: CLI agents recover from stream stalls via heartbeat timeout.
- **briefing:auto-review** (system) [success] at 08:00
  Reviewed 2 proposals. Both approved.

### Proposals — 9 total
Pending: 0, Approved: 1, Executing: 0, Completed: 2, Merged: 6, Failed: 0, Rejected: 0, Expired: 0

**Reviewed proposals:**
- [completed] Add unit tests for runReviewGate orchestrator — Verdict: APPROVE (medium, by scout)
- [completed] Add tests for development/loop.ts and plan.ts — Verdict: APPROVE (medium, by scout)
- [merged] Wire or remove unmounted dispatch-callback route — Verdict: APPROVE (small, by scout)
- [merged] Add unit tests for scheduler/cron.ts — Verdict: APPROVE (small, by scout)

**Awaiting action:**
- [approved] NyxHive Gateway — Full Web Operations Center (high, feature)

### Cost Last 24h
**Variable API spend: $0.16**
Fixed costs: Anthropic Max $200/mo (covers Nyx, Scout, Tester, Vigil CLI agents)

**Variable cost agents (pay-per-token):**
- analyst: $0.01 (3 calls, 4.2K in / 1.8K out)
- openrouter-classifier: $0.15 (42 calls, 21K in / 2.1K out)

**Max subscription agents (flat rate, no variable cost):**
- nyx: 8 calls, 156K in / 23K out
- scout: 4 calls, 89K in / 12K out
- tester: 2 calls, 45K in / 8K out

### Knowledge Base: 127 documents
`;

const BRIEFING_PROMPT = `Compile User's morning briefing from the pre-fetched data above. All data has been gathered for you — do NOT try to query any endpoints or APIs. Just synthesize.

Format the briefing as:

# Morning Briefing — 2026-03-04

## Proposals
For each reviewed proposal, show:
- Title — **Verdict: APPROVE/REJECT** — 1-line why
List any with APPROVE verdict that need User's attention first.
Count: X new, Y reviewed, Z awaiting action.

## Scans & Discoveries
Which scans ran overnight, 1-line summary of findings each.
Skip scans that found nothing noteworthy.

## Cost
Report the **Variable API spend** number exactly as provided — this is real money. The Max subscription agents have NO dollar cost shown because they're flat rate ($200/mo). Show their call counts and token usage for context, but DO NOT calculate or estimate dollar amounts for them.

## Action Items
- Proposals to approve (most important first)
- Failed tasks needing attention
- Anything time-sensitive

Keep it scannable — User reads this on his phone over coffee. No fluff.`;

// Also test a proposal review task
const PROPOSAL_REVIEW = `Review this proposal and provide your verdict.

Title: Add retry logic to Discord message sender
Category: improvement
Priority: medium
Effort: small
Proposed by: scout
Description: The Discord channel sender currently fails silently when Discord's API returns a 429 rate limit. Add exponential backoff retry (max 3 attempts) to handle transient failures gracefully.
Files affected: src/channels/discord.ts

Existing proposals (check for overlaps):
- [approved] NyxHive Gateway — Full Web Operations Center
- [completed] Add unit tests for runReviewGate orchestrator

Respond in EXACTLY this format:
VERDICT: DO | SKIP | MERGE
REASON: <1 sentence why>
EFFORT: <corrected estimate>
OVERLAPS: <proposal-id or "none">`;

interface ModelDef {
  id: string;
  name: string;
  costIn: number;
  costOut: number;
}

const MODELS: ModelDef[] = [
  { id: "google/gemini-2.5-flash", name: "Gemini 2.5 Flash", costIn: 0.30, costOut: 2.50 },
  { id: "google/gemini-2.5-flash-lite", name: "Gemini 2.5 Flash Lite", costIn: 0.10, costOut: 0.40 },
  { id: "google/gemini-2.0-flash-001", name: "Gemini 2.0 Flash", costIn: 0.10, costOut: 0.40 },
  { id: "qwen/qwen3-235b-a22b-2507", name: "Qwen3 235B MoE", costIn: 0.071, costOut: 0.10 },
  { id: "deepseek/deepseek-v3.2", name: "DeepSeek V3.2", costIn: 0.25, costOut: 0.40 },
  { id: "meta-llama/llama-4-scout", name: "Llama 4 Scout", costIn: 0.08, costOut: 0.30 },
];

async function callModel(model: ModelDef, systemPrompt: string, userPrompt: string): Promise<{
  content: string;
  latency: number;
  tokensIn: number;
  tokensOut: number;
  cost: number;
} | null> {
  const start = Date.now();
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        "X-Title": "NyxHive-Benchmark",
      },
      body: JSON.stringify({
        model: model.id,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        max_tokens: 2048,
        temperature: 0.3,
      }),
    });

    const data = await res.json() as any;
    const latency = Date.now() - start;

    if (!data.choices?.[0]) {
      console.error(`  ${model.name} FAILED: ${JSON.stringify(data.error || data).slice(0, 200)}`);
      return null;
    }

    const content = data.choices[0].message.content;
    const tokensIn = data.usage?.prompt_tokens ?? 0;
    const tokensOut = data.usage?.completion_tokens ?? 0;
    const cost = (tokensIn * model.costIn / 1e6) + (tokensOut * model.costOut / 1e6);

    return { content, latency, tokensIn, tokensOut, cost };
  } catch (err) {
    console.error(`  ${model.name} ERROR: ${err}`);
    return null;
  }
}

const SYSTEM_PROMPT = "You are Analyst, a research and analysis agent for NyxAI. Style: Evidence-first, thorough. Lead with findings.";

console.log("=== BRIEFING SYNTHESIS BENCHMARK ===\n");
console.log("Testing 6 models on 2 tasks: briefing synthesis + proposal review\n");

// Run all briefing tests in parallel
const briefingResults = await Promise.all(
  MODELS.map(async (model) => {
    const result = await callModel(model, SYSTEM_PROMPT, BRIEFING_CONTEXT + "---\n\n" + BRIEFING_PROMPT);
    if (result) {
      console.log(`\n${"=".repeat(80)}`);
      console.log(`BRIEFING — ${model.name} (${model.id})`);
      console.log(`Latency: ${(result.latency / 1000).toFixed(1)}s | Tokens: ${result.tokensIn}in/${result.tokensOut}out | Cost: $${result.cost.toFixed(6)}`);
      console.log(`${"=".repeat(80)}`);
      console.log(result.content);
    }
    return { model, result };
  })
);

console.log(`\n\n${"=".repeat(80)}`);
console.log("PROPOSAL REVIEW TEST");
console.log(`${"=".repeat(80)}\n`);

// Run all proposal review tests in parallel
const reviewResults = await Promise.all(
  MODELS.map(async (model) => {
    const result = await callModel(model, SYSTEM_PROMPT, PROPOSAL_REVIEW);
    if (result) {
      console.log(`\n${model.name}: ${result.content.trim()} [${(result.latency / 1000).toFixed(1)}s, $${result.cost.toFixed(6)}]`);
    }
    return { model, result };
  })
);

console.log(`\n\n${"=".repeat(80)}`);
console.log("SUMMARY");
console.log(`${"=".repeat(80)}`);
console.log("Model".padEnd(25) + "Briefing".padEnd(10) + "Review".padEnd(10) + "Cost/brief".padEnd(14) + "Monthly".padEnd(12) + "Tokens");
for (const br of briefingResults) {
  const rr = reviewResults.find(r => r.model.id === br.model.id);
  if (br.result) {
    const monthlyBriefing = br.result.cost * 30;
    const monthlyReview = (rr?.result?.cost ?? 0) * 20; // ~20 reviews/month
    const monthlyTotal = monthlyBriefing + monthlyReview;
    console.log(
      br.model.name.padEnd(25) +
      `${(br.result.latency / 1000).toFixed(1)}s`.padEnd(10) +
      `${rr?.result ? (rr.result.latency / 1000).toFixed(1) + "s" : "FAIL"}`.padEnd(10) +
      `$${br.result.cost.toFixed(6)}`.padEnd(14) +
      `$${monthlyTotal.toFixed(4)}`.padEnd(12) +
      `${br.result.tokensIn}in/${br.result.tokensOut}out`
    );
  }
}

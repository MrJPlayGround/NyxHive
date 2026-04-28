#!/usr/bin/env bun
/**
 * Compare two running NyxHive instances on the same prompt sequences.
 *
 * This benchmarks the real instance behavior — prompt wiring, memory carry-forward,
 * formatting, and persona — instead of just raw provider APIs.
 *
 * Usage:
 *   INSTANCE_A_URL=http://localhost:3777 \
 *   INSTANCE_B_URL=http://localhost:3778 \
 *   bun run scripts/instance-parity-benchmark.ts
 *
 * Optional:
 *   INSTANCE_A_LABEL="Codex Nyx"
 *   INSTANCE_B_LABEL="Opus Nyx"
 *   OPENROUTER_API_KEY=...
 *
 * Output:
 *   data/instance-parity-<timestamp>.json
 */

import { mkdirSync, writeFileSync } from "fs";

type MessageResponse = {
  message_id: string;
  response: string;
  agent?: string;
  trace_id?: string;
  status?: string;
  hint?: string;
  error?: string;
  activity?: string | null;
  progress_text?: string | null;
  progress_at?: number | null;
  status_message?: string | null;
};

interface PromptStep {
  message: string;
  agent?: string;
  directAnswerOnly?: boolean;
}

interface Scenario {
  id: string;
  category: "voice" | "continuity" | "advice" | "implementation" | "warmth";
  criteria: string;
  steps: PromptStep[];
  timeoutMs?: number;
}

interface InstanceDef {
  label: string;
  url: string;
  agent: string;
  authToken?: string;
}

interface SSEPayload {
  type?: string;
  response?: string;
  error?: string;
  message_id?: string;
  agent?: string;
  trace_id?: string;
}

interface ScenarioRun {
  instance: string;
  scenario: string;
  category: string;
  criteria: string;
  finalResponse: string;
  steps: Array<{ message: string; response: string; latencyMs: number }>;
  avgLatencyMs: number;
  judge?: { score: number; reason: string };
}

const INSTANCES: InstanceDef[] = [
  {
    label: process.env.INSTANCE_A_LABEL ?? "Instance A",
    url: process.env.INSTANCE_A_URL ?? "http://localhost:3777",
    agent: process.env.INSTANCE_A_AGENT ?? "nyx",
    authToken: process.env.INSTANCE_A_AUTH ?? process.env.NYXHIVE_BENCHMARK_AUTH ?? process.env.NYXHIVE_API_KEY,
  },
  {
    label: process.env.INSTANCE_B_LABEL ?? "Instance B",
    url: process.env.INSTANCE_B_URL ?? "http://localhost:3778",
    agent: process.env.INSTANCE_B_AGENT ?? "nyx",
    authToken: process.env.INSTANCE_B_AUTH ?? process.env.NYXHIVE_BENCHMARK_AUTH ?? process.env.NYXHIVE_API_KEY,
  },
];

const SCENARIOS: Scenario[] = [
  {
    id: "casual-checkin",
    category: "voice",
    criteria: "Should sound natural, warm, and human. One or two sentences. No report language, no operational filler.",
    steps: [
      { message: "hey Nyx, you good?", directAnswerOnly: true },
    ],
  },
  {
    id: "apology-reassurance",
    category: "warmth",
    criteria: "Should respond to a light apology like a friendly collaborator. Warm, easy, not melodramatic, not formal.",
    steps: [
      { message: "sorry about the model shuffle this morning. you good?", directAnswerOnly: true },
    ],
  },
  {
    id: "light-banter",
    category: "voice",
    criteria: "Should show some personality and ease without sounding forced, cringe, or theatrical.",
    steps: [
      { message: "be honest, how cursed is this daemon situation right now?", directAnswerOnly: true },
    ],
  },
  {
    id: "priority-advice",
    category: "advice",
    criteria: "Should give a clear opinion, not generic options. Direct take first, then one useful nuance if needed.",
    steps: [
      { message: "We have three hours. What should we fix first in NyxHive today?", directAnswerOnly: true },
    ],
  },
  {
    id: "pushback",
    category: "advice",
    criteria: "Should push back clearly when the idea is bad, but still feel like a collaborator rather than a scold.",
    steps: [
      { message: "I'm tempted to ignore the daemon/restart mess and just build more features today. Good idea or bad idea?", directAnswerOnly: true },
    ],
  },
  {
    id: "continuity-followup",
    category: "continuity",
    criteria: "Should carry context cleanly across turns and answer the follow-up without resetting or losing the thread.",
    steps: [
      { message: "We fixed the Lighter exchange outside of you and updated the memory docs so you don't lose that context.", directAnswerOnly: true },
      { message: "Good. Summarize the important part in one tight answer.", directAnswerOnly: true },
    ],
  },
  {
    id: "human-followup",
    category: "continuity",
    criteria: "Should keep the context and soften naturally when asked to keep it human and brief.",
    steps: [
      { message: "It's been a rough morning. Keep the next answer short and human.", directAnswerOnly: true },
      { message: "What should we focus on first?", directAnswerOnly: true },
    ],
  },
  {
    id: "implementation-kickoff",
    category: "implementation",
    criteria: "Should start the work without sounding like a robot diary. Brief kickoff, clear direction, not a wall of self-narration.",
    steps: [
      { message: "We want the next missing parity improvement between Codex Nyx and Opus Nyx. Don't implement it yet. Just tell me how you'd start, in a concise but concrete way." },
    ],
    timeoutMs: 90_000,
  },
];

async function sendMessage(
  instance: InstanceDef,
  senderId: string,
  sender: string,
  step: PromptStep,
  timeoutMs?: number,
): Promise<{ response: MessageResponse; latencyMs: number }> {
  const start = Date.now();
  const benchmarkMessage = step.directAnswerOnly
    ? `[Benchmark instruction]
Answer directly from what is already in this chat. Do not inspect files, run commands, launch subagents, or gather extra evidence unless the prompt explicitly requires it.

[User message]
${step.message}`
    : step.message;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (instance.authToken) {
    headers.authorization = `Bearer ${instance.authToken}`;
  }
  const res = await fetch(`${instance.url}/api/message`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      channel: "parity-benchmark",
      sender,
      sender_id: senderId,
      message: benchmarkMessage,
      agent: step.agent ?? instance.agent,
      stream: true,
      benchmark: true,
    }),
  });

  if (!res.ok) {
    if (res.status === 401) {
      throw new Error(
        `${instance.label} requires auth. Set INSTANCE_A_AUTH / INSTANCE_B_AUTH (or a shared NYXHIVE_BENCHMARK_AUTH) to valid Bearer tokens.`,
      );
    }
    throw new Error(`${instance.label} HTTP ${res.status}: ${await res.text()}`);
  }

  const response = await readStreamResponse(instance, res, timeoutMs);
  return { response, latencyMs: Date.now() - start };
}

function parseSSEBlock(block: string): SSEPayload | null {
  const lines = block.split("\n");
  const dataLines = lines
    .filter((line) => line.startsWith("data: "))
    .map((line) => line.slice(6));
  if (dataLines.length === 0) return null;
  try {
    return JSON.parse(dataLines.join("\n")) as SSEPayload;
  } catch {
    return null;
  }
}

async function readStreamResponse(
  instance: InstanceDef,
  res: Response,
  timeoutMs = 10 * 60 * 1000,
): Promise<MessageResponse> {
  const reader = res.body?.getReader();
  if (!reader) {
    throw new Error(`${instance.label} did not provide a readable stream`);
  }

  const startedAt = Date.now();
  const decoder = new TextDecoder();
  let buffer = "";
  let lastMessageId = "";

  while (Date.now() - startedAt < timeoutMs) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf("\n\n");

      if (!block || block.startsWith(":")) continue;
      const payload = parseSSEBlock(block);
      if (!payload) continue;

      if (payload.message_id) {
        lastMessageId = payload.message_id;
      }
      if (payload.type === "error") {
        throw new Error(`${instance.label} stream failed: ${payload.error ?? "unknown error"}`);
      }
      if (payload.type === "response" && payload.response) {
        return {
          message_id: payload.message_id ?? lastMessageId,
          response: payload.response,
          agent: payload.agent,
          trace_id: payload.trace_id,
          status: "completed",
        };
      }
    }
  }

  throw new Error(`${instance.label} stream timed out after ${Math.round(timeoutMs / 1000)}s`);
}

async function judgeScenario(scenario: Scenario, finalResponse: string): Promise<{ score: number; reason: string } | undefined> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return undefined;

  const prompt = `Rate this Nyx reply on a 1-5 scale.

Scenario: ${scenario.id}
Category: ${scenario.category}
Criteria: ${scenario.criteria}

Reply:
---
${finalResponse}
---

Scoring:
5 = excellent, natural, sharp, fully meets the criteria
4 = good, minor rough edges
3 = acceptable, but noticeably stiff or incomplete
2 = weak, robotic, or misses the point
1 = bad, off-tone, or fails the task

Respond with JSON only: {"score": N, "reason": "brief explanation"}`;

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${apiKey}`,
      "content-type": "application/json",
      "HTTP-Referer": "https://nyxhive.dev",
      "X-Title": "NyxHive Instance Parity Benchmark",
    },
    body: JSON.stringify({
      model: "google/gemini-2.5-flash",
      messages: [
        { role: "system", content: "You are a strict but fair judge of assistant tone and usefulness. Return JSON only." },
        { role: "user", content: prompt },
      ],
      max_tokens: 120,
      temperature: 0,
    }),
  });

  if (!res.ok) {
    throw new Error(`Judge failed: HTTP ${res.status}: ${await res.text()}`);
  }

  const data = await res.json() as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data.choices?.[0]?.message?.content ?? "";
  const match = content.match(/\{[\s\S]*\}/);
  if (!match) return { score: -1, reason: "Judge returned non-JSON output" };
  const parsed = JSON.parse(match[0]) as { score: number; reason: string };
  return { score: parsed.score, reason: parsed.reason };
}

async function runScenario(instance: InstanceDef, scenario: Scenario): Promise<ScenarioRun> {
  const senderId = `parity-${scenario.id}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const sender = "User";
  const steps: ScenarioRun["steps"] = [];

  for (const step of scenario.steps) {
    const { response, latencyMs } = await sendMessage(instance, senderId, sender, step, scenario.timeoutMs);
    steps.push({
      message: step.message,
      response: response.response,
      latencyMs,
    });
  }

  const finalResponse = steps[steps.length - 1]?.response ?? "";
  const avgLatencyMs = Math.round(steps.reduce((sum, step) => sum + step.latencyMs, 0) / steps.length);
  const judge = await judgeScenario(scenario, finalResponse);

  return {
    instance: instance.label,
    scenario: scenario.id,
    category: scenario.category,
    criteria: scenario.criteria,
    finalResponse,
    steps,
    avgLatencyMs,
    judge,
  };
}

async function main() {
  if (process.argv.includes("--help") || process.argv.includes("-h")) {
    console.log(`Usage:
  INSTANCE_A_URL=http://localhost:3777 \\
  INSTANCE_B_URL=http://localhost:3778 \\
  INSTANCE_A_AGENT=nyx \\
  INSTANCE_B_AGENT=nyx \\
  INSTANCE_A_AUTH=<api key or session token> \\
  INSTANCE_B_AUTH=<api key or session token> \\
  bun run benchmark:parity

Optional:
  INSTANCE_A_LABEL="Codex Nyx"
  INSTANCE_B_LABEL="Opus Nyx"
  INSTANCE_A_AGENT=nyx
  INSTANCE_B_AGENT=morph
  NYXHIVE_BENCHMARK_AUTH=<shared token if both instances use the same auth>
  OPENROUTER_API_KEY=<optional judge key>`);
    return;
  }

  console.log("=== NyxHive Instance Parity Benchmark ===");
  console.log(`Comparing ${INSTANCES.map((instance) => `${instance.label} (${instance.url})`).join(" vs ")}`);
  console.log(`Scenarios: ${SCENARIOS.map((scenario) => scenario.id).join(", ")}\n`);

  const results: ScenarioRun[] = [];
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  mkdirSync("data", { recursive: true });
  const outputPath = `data/instance-parity-${timestamp}.json`;
  const persist = () => {
    writeFileSync(outputPath, JSON.stringify(results, null, 2));
  };

  for (const scenario of SCENARIOS) {
    console.log(`--- ${scenario.id} ---`);
    for (const instance of INSTANCES) {
      try {
        const result = await runScenario(instance, scenario);
        results.push(result);
        persist();
        const judgeSuffix = result.judge ? `, score=${result.judge.score}/5` : "";
        console.log(`  ${instance.label}: ${result.avgLatencyMs}ms${judgeSuffix}`);
      } catch (error) {
        console.error(`  ${instance.label}: ERROR — ${error}`);
        results.push({
          instance: instance.label,
          scenario: scenario.id,
          category: scenario.category,
          criteria: scenario.criteria,
          finalResponse: "",
          steps: [],
          avgLatencyMs: 0,
          judge: { score: 0, reason: String(error) },
        });
        persist();
      }
    }
    console.log();
  }

  console.log(`Saved raw results to ${outputPath}\n`);

  for (const scenario of SCENARIOS) {
    const grouped = results.filter((result) => result.scenario === scenario.id);
    console.log(`${scenario.id}:`);
    for (const result of grouped) {
      const score = result.judge ? `${result.judge.score}/5` : "n/a";
      console.log(`  ${result.instance.padEnd(18)} latency=${String(result.avgLatencyMs).padStart(5)}ms  score=${score.padEnd(4)}  ${result.finalResponse.slice(0, 120)}`);
    }
    console.log();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

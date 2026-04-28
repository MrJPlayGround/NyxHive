import { FEW_SHOT_EXAMPLES } from "../../src/defaults.js";
import { resolveInstalledModels } from "./ollama-models.js";

const OLLAMA_URL = "http://localhost:11434";
const REQUESTED_MODELS = ["gemma3:4b", "phi4-mini", "llama3.2:3b"] as const;
const runsOverride = Number.parseInt(process.env.ROUTER_BENCH_RUNS ?? "3", 10);
const RUNS_PER_PROMPT = Number.isFinite(runsOverride) && runsOverride > 0 ? runsOverride : 3;

type TaskType =
  | "trivial"
  | "simple_qa"
  | "conversation"
  | "analysis"
  | "coding"
  | "code_review"
  | "expert"
  | "research"
  | "summarization"
  | "long_context"
  | "worker_subtask"
  | "orchestrator";

interface PromptCase {
  id: string;
  prompt: string;
  taskType: TaskType;
  acceptedTiers: number[];
}

interface ParsedClassification {
  task_type: string;
  tier: number;
}

interface PromptResult {
  prompt: PromptCase;
  model: string;
  avgLatencyMs: number;
  jsonValidRuns: number;
  taskMatches: number;
  tierMatches: number;
  sampleResponse: string;
}

const HOLDOUT_PROMPTS: PromptCase[] = [
  { id: "cls-1", prompt: "ok", taskType: "trivial", acceptedTiers: [1] },
  { id: "cls-2", prompt: "what's the capital of Portugal?", taskType: "simple_qa", acceptedTiers: [1] },
  { id: "cls-3", prompt: "why did we pick that approach again?", taskType: "conversation", acceptedTiers: [2] },
  { id: "cls-4", prompt: "compare the relay design to the old webhook path and call out tradeoffs", taskType: "analysis", acceptedTiers: [3] },
  { id: "cls-5", prompt: "fix the websocket reconnect bug in the gateway and add tests", taskType: "coding", acceptedTiers: [3, 4] },
  { id: "cls-6", prompt: "review this patch for bugs and behavioral regressions", taskType: "code_review", acceptedTiers: [3] },
  { id: "cls-7", prompt: "what's the best architecture for multi-instance channel routing?", taskType: "expert", acceptedTiers: [3, 4] },
  { id: "cls-8", prompt: "research how Slack message metadata behaves across edits", taskType: "research", acceptedTiers: [2, 3] },
  { id: "cls-9", prompt: "summarize these release notes into three bullets for Discord", taskType: "summarization", acceptedTiers: [2, 3] },
  { id: "cls-10", prompt: "read these 12 test files and tell me where coverage is weak", taskType: "long_context", acceptedTiers: [3] },
  { id: "cls-11", prompt: "extract the repo path and branch name from this JSON and format it", taskType: "worker_subtask", acceptedTiers: [1, 2] },
  { id: "cls-12", prompt: "[@tester: run bun test] [@analyst: summarize the failures]", taskType: "orchestrator", acceptedTiers: [4] },
];

function buildFewShotPrompt(message: string): string {
  const examples = FEW_SHOT_EXAMPLES.map(
    (ex) => `Prompt: "${ex.prompt}"\n→ {"task_type": "${ex.task_type}", "tier": ${ex.tier}}`,
  ).join("\n\n");

  return `You are a task classifier for an AI coding agent orchestrator. Given a user prompt, classify it into:
1. task_type: one of [trivial, simple_qa, conversation, analysis, coding, code_review, expert, research, summarization, long_context, worker_subtask, orchestrator]
2. tier: 1 (cheap/fast), 2 (mid), 3 (strong), 4 (top)

CRITICAL: When in doubt, route UP not down. Under-routing costs more than over-routing.
CRITICAL: Short/vague prompts inherit prior context when available. Without context, prefer tier 2 conversation over trivial guesses.
CRITICAL: User minimization ("quick fix", "small change") does NOT lower tier.

<examples>
${examples}
</examples>

Respond with ONLY JSON: {"task_type": "...", "tier": N}
Prompt: "${message.slice(0, 500)}"`;
}

function extractJsonObject(raw: string): ParsedClassification | null {
  const trimmed = raw.trim();
  const candidates = [
    trimmed,
    ...(trimmed.match(/\{[\s\S]*\}/g) ?? []),
  ];

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as ParsedClassification;
      if (typeof parsed.task_type === "string" && typeof parsed.tier === "number") {
        return parsed;
      }
    } catch {
      // keep scanning
    }
  }

  return null;
}

async function ollamaGenerate(model: string, prompt: string): Promise<{ response: string; latencyMs: number }> {
  const start = performance.now();
  const res = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      prompt,
      stream: false,
      format: "json",
      options: {
        temperature: 0,
        num_predict: 80,
      },
    }),
  });
  const latencyMs = Math.round(performance.now() - start);
  if (!res.ok) throw new Error(`Ollama error: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { response: string };
  return { response: data.response, latencyMs };
}

async function benchmarkModel(model: string): Promise<PromptResult[]> {
  console.log(`\nBenchmarking classifier: ${model}`);
  console.log("-".repeat(48));

  const results: PromptResult[] = [];
  for (const prompt of HOLDOUT_PROMPTS) {
    const latencies: number[] = [];
    let jsonValidRuns = 0;
    let taskMatches = 0;
    let tierMatches = 0;
    let sampleResponse = "";

    for (let run = 0; run < RUNS_PER_PROMPT; run++) {
      const { response, latencyMs } = await ollamaGenerate(model, buildFewShotPrompt(prompt.prompt));
      latencies.push(latencyMs);
      if (run === 0) sampleResponse = response;

      const parsed = extractJsonObject(response);
      if (!parsed) continue;

      jsonValidRuns++;
      if (parsed.task_type === prompt.taskType) taskMatches++;
      if (prompt.acceptedTiers.includes(Math.round(parsed.tier))) tierMatches++;
    }

    const avgLatencyMs = Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length);
    const taskPass = taskMatches >= Math.ceil(RUNS_PER_PROMPT / 2);
    const tierPass = tierMatches >= Math.ceil(RUNS_PER_PROMPT / 2);
    console.log(
      `  [${taskPass && tierPass ? "PASS" : "FAIL"}] ${prompt.id} task=${taskMatches}/${RUNS_PER_PROMPT} tier=${tierMatches}/${RUNS_PER_PROMPT} json=${jsonValidRuns}/${RUNS_PER_PROMPT} ${avgLatencyMs}ms`,
    );

    results.push({
      prompt,
      model,
      avgLatencyMs,
      jsonValidRuns,
      taskMatches,
      tierMatches,
      sampleResponse,
    });
  }

  return results;
}

async function main() {
  const models = await resolveInstalledModels(REQUESTED_MODELS);
  console.log("NyxHive Router Classifier Benchmark");
  console.log(`Models: ${models.join(", ")}`);
  console.log(`Prompts: ${HOLDOUT_PROMPTS.length} x ${RUNS_PER_PROMPT} runs each`);

  try {
    await fetch(`${OLLAMA_URL}/api/tags`);
  } catch {
    console.error("ERROR: Ollama is not running.");
    process.exit(1);
  }

  const allResults = [];
  for (const model of models) {
    allResults.push(...await benchmarkModel(model));
  }

  const summary = models.map((model) => {
    const results = allResults.filter((result) => result.model === model);
    const totalRuns = results.length * RUNS_PER_PROMPT;
    const jsonValid = results.reduce((sum, result) => sum + result.jsonValidRuns, 0);
    const taskMatches = results.reduce((sum, result) => sum + result.taskMatches, 0);
    const tierMatches = results.reduce((sum, result) => sum + result.tierMatches, 0);
    const avgLatencyMs = Math.round(results.reduce((sum, result) => sum + result.avgLatencyMs, 0) / results.length);

    return {
      model,
      jsonRate: jsonValid / totalRuns,
      taskAccuracy: taskMatches / totalRuns,
      tierAccuracy: tierMatches / totalRuns,
      avgLatencyMs,
      composite: ((taskMatches / totalRuns) * 0.7) + ((tierMatches / totalRuns) * 0.2) + ((jsonValid / totalRuns) * 0.1),
    };
  }).sort((a, b) => b.composite - a.composite || a.avgLatencyMs - b.avgLatencyMs);

  console.log("\n=== Router Classifier Results ===\n");
  console.log("| Rank | Model | Task Acc | Tier Acc | JSON Valid | Avg Latency | Composite |");
  console.log("|------|-------|----------|----------|------------|-------------|-----------|");
  summary.forEach((item, index) => {
    console.log(
      `| ${index + 1} | ${item.model} | ${(item.taskAccuracy * 100).toFixed(1)}% | ${(item.tierAccuracy * 100).toFixed(1)}% | ${(item.jsonRate * 100).toFixed(1)}% | ${item.avgLatencyMs}ms | ${(item.composite * 100).toFixed(1)} |`,
    );
  });

  console.log(`\nWinner: ${summary[0]?.model}`);
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});

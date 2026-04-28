import { TEST_PROMPTS } from "./prompts.js";
import { checkAnswer, scoreModel, type PromptResult } from "./score.js";
import { printReport } from "./report.js";
import { resolveInstalledModels } from "./ollama-models.js";

const OLLAMA_URL = "http://localhost:11434";
const REQUESTED_MODELS = ["ministral-3:3b", "phi4-mini", "llama3.2:3b", "gemma3:4b"] as const;
const WARMUP_PROMPT = "Respond with OK";
const RUNS_PER_PROMPT = 3;

async function ollamaGenerate(model: string, system: string, prompt: string): Promise<{ response: string; durationMs: number }> {
  const start = performance.now();
  const res = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      system,
      prompt,
      stream: false,
      options: { temperature: 0, num_predict: 20 },
    }),
  });
  const durationMs = Math.round(performance.now() - start);

  if (!res.ok) throw new Error(`Ollama error: ${res.status} ${await res.text()}`);
  const data = (await res.json()) as { response: string };
  return { response: data.response, durationMs };
}

async function getModelRam(model: string): Promise<number> {
  try {
    const res = await fetch(`${OLLAMA_URL}/api/ps`);
    const data = (await res.json()) as { models: Array<{ name: string; size: number }> };
    const entry = data.models.find((m) => m.name.startsWith(model));
    return entry ? Math.round(entry.size / 1024 / 1024) : 0;
  } catch {
    return 0;
  }
}

async function getSystemRam(): Promise<{ totalMB: number; usedMB: number; freeMB: number }> {
  try {
    const proc = Bun.spawn(["vm_stat"], { stdout: "pipe" });
    const text = await new Response(proc.stdout).text();
    const pageSize = 16384;
    const extract = (label: string) => {
      const match = text.match(new RegExp(`${label}:\\s+(\\d+)`));
      return match ? parseInt(match[1]) * pageSize / 1024 / 1024 : 0;
    };
    const free = extract("Pages free");
    const active = extract("Pages active");
    const inactive = extract("Pages inactive");
    const speculative = extract("Pages speculative");
    const wired = extract("Pages wired down");
    const totalMB = 16 * 1024;
    const usedMB = Math.round(active + wired);
    const freeMB = Math.round(free + inactive + speculative);
    return { totalMB, usedMB, freeMB };
  } catch {
    return { totalMB: 0, usedMB: 0, freeMB: 0 };
  }
}

async function warmup(model: string): Promise<void> {
  console.log(`  Warming up ${model}...`);
  await ollamaGenerate(model, "", WARMUP_PROMPT);
}

async function benchmarkModel(model: string): Promise<PromptResult[]> {
  console.log(`\nBenchmarking: ${model}`);
  console.log("-".repeat(40));

  const ramBefore = await getSystemRam();
  console.log(`  System RAM before: ${ramBefore.usedMB}MB used, ${ramBefore.freeMB}MB free`);

  await warmup(model);

  const ramAfter = await getSystemRam();
  console.log(`  System RAM after load: ${ramAfter.usedMB}MB used, ${ramAfter.freeMB}MB free (delta: +${ramAfter.usedMB - ramBefore.usedMB}MB)`);

  const results: PromptResult[] = [];

  for (const prompt of TEST_PROMPTS) {
    const runLatencies: number[] = [];
    let bestResponse = "";
    let correctCount = 0;

    for (let run = 0; run < RUNS_PER_PROMPT; run++) {
      const { response, durationMs } = await ollamaGenerate(model, prompt.system, prompt.prompt);
      runLatencies.push(durationMs);
      if (run === 0) bestResponse = response;

      const isCorrect = checkAnswer(prompt, response);
      if (isCorrect) correctCount++;
      if (isCorrect && !checkAnswer(prompt, bestResponse)) {
        bestResponse = response;
      }
    }

    const avgLatency = Math.round(runLatencies.reduce((a, b) => a + b, 0) / runLatencies.length);
    const correct = correctCount >= Math.ceil(RUNS_PER_PROMPT / 2);

    const status = correct ? "PASS" : "FAIL";
    console.log(`  [${status}] ${prompt.id}: "${bestResponse.trim().slice(0, 40)}" (${avgLatency}ms)`);

    results.push({ prompt, model, response: bestResponse, correct, latencyMs: avgLatency });
  }

  const ramDuring = await getSystemRam();
  console.log(`  System RAM peak: ${ramDuring.usedMB}MB used, ${ramDuring.freeMB}MB free`);

  return results;
}

async function main() {
  const models = await resolveInstalledModels(REQUESTED_MODELS);
  console.log("Local LLM Benchmark — NyxHive Classification Tasks");
  console.log(`Models: ${models.join(", ")}`);
  console.log(`Prompts: ${TEST_PROMPTS.length} x ${RUNS_PER_PROMPT} runs each`);
  console.log(`Total inference calls: ${TEST_PROMPTS.length * RUNS_PER_PROMPT * models.length}`);
  console.log();

  try {
    await fetch(`${OLLAMA_URL}/api/tags`);
  } catch {
    console.error("ERROR: Ollama is not running. Start it with: ollama serve");
    process.exit(1);
  }

  const baseline = await getSystemRam();
  console.log(`Baseline system RAM: ${baseline.usedMB}MB used, ${baseline.freeMB}MB free of ${baseline.totalMB}MB`);

  const allScores = [];
  const ramUsage: Record<string, number> = {};

  for (const model of models) {
    const results = await benchmarkModel(model);
    allScores.push(scoreModel(results));
    ramUsage[model] = await getModelRam(model);
  }

  printReport(allScores, ramUsage);

  const outPath = "scripts/llm-benchmark/results.json";
  await Bun.write(outPath, JSON.stringify({ scores: allScores, ramUsage, timestamp: new Date().toISOString() }, null, 2));
  console.log(`\nRaw results saved to ${outPath}`);
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});

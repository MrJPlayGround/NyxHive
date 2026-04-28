import { TEST_PROMPTS } from "./prompts-r2.js";
import { checkAnswer, scoreModel, type PromptResult } from "./score.js";
import { printReport } from "./report.js";
import { resolveInstalledModels } from "./ollama-models.js";

const OLLAMA_URL = "http://localhost:11434";
// Round 2: top 3 only — ministral eliminated (40% escalation)
const REQUESTED_MODELS = ["gemma3:4b", "phi4-mini", "llama3.2:3b"] as const;
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
    const data = (await res.json()) as { models: Array<{ name: string; size: number; size_vram: number }> };
    const entry = data.models.find((m) => m.name.startsWith(model));
    return entry ? Math.round(entry.size / 1024 / 1024) : 0;
  } catch {
    return 0;
  }
}

async function getSystemRam(): Promise<{ usedMB: number; freeMB: number; pressureLevel: string }> {
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
    const compressed = extract("Pages stored in compressor");
    const usedMB = Math.round(active + wired);
    const freeMB = Math.round(free + inactive + speculative);

    // Pressure heuristic
    let pressureLevel = "normal";
    if (freeMB < 500) pressureLevel = "high";
    else if (freeMB < 1500) pressureLevel = "moderate";
    if (compressed > 100) pressureLevel = pressureLevel === "normal" ? "moderate" : "high";

    return { usedMB, freeMB, pressureLevel };
  } catch {
    return { usedMB: 0, freeMB: 0, pressureLevel: "unknown" };
  }
}

async function unloadAllModels(): Promise<void> {
  // Tell Ollama to unload models by setting keep_alive to 0
  try {
    const psRes = await fetch(`${OLLAMA_URL}/api/ps`);
    const psData = (await psRes.json()) as { models: Array<{ name: string }> };
    for (const m of psData.models) {
      await fetch(`${OLLAMA_URL}/api/generate`, {
        method: "POST",
        body: JSON.stringify({ model: m.name, keep_alive: 0 }),
      });
    }
    // Wait for unload
    await new Promise((r) => setTimeout(r, 2000));
  } catch { /* ignore */ }
}

async function warmup(model: string): Promise<void> {
  console.log(`  Warming up ${model}...`);
  await ollamaGenerate(model, "", WARMUP_PROMPT);
}

interface RamSnapshot {
  model: string;
  phase: string;
  modelRamMB: number;
  systemUsedMB: number;
  systemFreeMB: number;
  pressure: string;
}

async function benchmarkModel(model: string): Promise<{ results: PromptResult[]; ramSnapshots: RamSnapshot[] }> {
  console.log(`\n${"=".repeat(50)}`);
  console.log(`Benchmarking: ${model}`);
  console.log("=".repeat(50));

  const ramSnapshots: RamSnapshot[] = [];

  // Unload other models first for clean measurement
  await unloadAllModels();
  const ramClean = await getSystemRam();
  ramSnapshots.push({ model, phase: "before_load", modelRamMB: 0, systemUsedMB: ramClean.usedMB, systemFreeMB: ramClean.freeMB, pressure: ramClean.pressureLevel });
  console.log(`  RAM before load: ${ramClean.usedMB}MB used, ${ramClean.freeMB}MB free [${ramClean.pressureLevel}]`);

  await warmup(model);

  const ramLoaded = await getSystemRam();
  const modelRam = await getModelRam(model);
  ramSnapshots.push({ model, phase: "after_load", modelRamMB: modelRam, systemUsedMB: ramLoaded.usedMB, systemFreeMB: ramLoaded.freeMB, pressure: ramLoaded.pressureLevel });
  console.log(`  RAM after load: ${ramLoaded.usedMB}MB used, ${ramLoaded.freeMB}MB free, model=${modelRam}MB [${ramLoaded.pressureLevel}]`);

  const results: PromptResult[] = [];
  let peakUsed = ramLoaded.usedMB;
  let minFree = ramLoaded.freeMB;

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
    console.log(`  [${status}] ${prompt.id}: "${bestResponse.trim().slice(0, 50)}" (${avgLatency}ms)`);

    results.push({ prompt, model, response: bestResponse, correct, latencyMs: avgLatency });

    // RAM sample every 5 prompts
    if (results.length % 5 === 0) {
      const ramMid = await getSystemRam();
      if (ramMid.usedMB > peakUsed) peakUsed = ramMid.usedMB;
      if (ramMid.freeMB < minFree) minFree = ramMid.freeMB;
      ramSnapshots.push({ model, phase: `mid_${results.length}`, modelRamMB: await getModelRam(model), systemUsedMB: ramMid.usedMB, systemFreeMB: ramMid.freeMB, pressure: ramMid.pressureLevel });
    }
  }

  const ramFinal = await getSystemRam();
  if (ramFinal.usedMB > peakUsed) peakUsed = ramFinal.usedMB;
  if (ramFinal.freeMB < minFree) minFree = ramFinal.freeMB;
  ramSnapshots.push({ model, phase: "after_benchmark", modelRamMB: await getModelRam(model), systemUsedMB: ramFinal.usedMB, systemFreeMB: ramFinal.freeMB, pressure: ramFinal.pressureLevel });

  console.log(`  RAM peak: ${peakUsed}MB used, min free: ${minFree}MB [${ramFinal.pressureLevel}]`);

  return { results, ramSnapshots };
}

async function main() {
  const models = await resolveInstalledModels(REQUESTED_MODELS);
  console.log("Local LLM Benchmark — Round 2 (Stress Test)");
  console.log(`Models: ${models.join(", ")}`);
  console.log(`Prompts: ${TEST_PROMPTS.length} x ${RUNS_PER_PROMPT} runs each`);
  console.log(`Total inference calls: ${TEST_PROMPTS.length * RUNS_PER_PROMPT * models.length}`);
  console.log();

  try {
    await fetch(`${OLLAMA_URL}/api/tags`);
  } catch {
    console.error("ERROR: Ollama is not running.");
    process.exit(1);
  }

  const baseline = await getSystemRam();
  console.log(`Baseline RAM: ${baseline.usedMB}MB used, ${baseline.freeMB}MB free of 16384MB [${baseline.pressureLevel}]`);

  const allScores = [];
  const ramUsage: Record<string, number> = {};
  const allRamSnapshots: RamSnapshot[] = [];

  for (const model of models) {
    const { results, ramSnapshots } = await benchmarkModel(model);
    allScores.push(scoreModel(results));
    ramUsage[model] = await getModelRam(model);
    allRamSnapshots.push(...ramSnapshots);
  }

  printReport(allScores, ramUsage);

  // Print RAM analysis
  console.log("\n## RAM Analysis\n");
  console.log("| Model | Before Load | After Load | Model Size | Peak Used | Min Free | Pressure |");
  console.log("|-------|------------|------------|------------|-----------|----------|----------|");
  for (const model of models) {
    const snaps = allRamSnapshots.filter((s) => s.model === model);
    const before = snaps.find((s) => s.phase === "before_load");
    const after = snaps.find((s) => s.phase === "after_load");
    const peakUsed = Math.max(...snaps.map((s) => s.systemUsedMB));
    const minFree = Math.min(...snaps.map((s) => s.systemFreeMB));
    const worstPressure = snaps.some((s) => s.pressure === "high") ? "HIGH" : snaps.some((s) => s.pressure === "moderate") ? "moderate" : "normal";
    console.log(`| ${model} | ${before?.systemFreeMB ?? "?"}MB free | ${after?.systemFreeMB ?? "?"}MB free | ${after?.modelRamMB ?? "?"}MB | ${peakUsed}MB | ${minFree}MB | ${worstPressure} |`);
  }

  // Composite scoring: accuracy 60%, latency 25%, RAM efficiency 15%
  console.log("\n## Composite Score (accuracy 60% + latency 25% + RAM 15%)\n");
  const maxLatency = Math.max(...allScores.map((s) => s.avgLatencyMs));
  const maxRam = Math.max(...Object.values(ramUsage));
  const composite = allScores.map((s) => {
    const accScore = s.accuracy * 60;
    const latScore = (1 - s.avgLatencyMs / maxLatency) * 25;
    const ramScore = (1 - (ramUsage[s.model] ?? maxRam) / maxRam) * 15;
    const total = accScore + latScore + ramScore;
    return { model: s.model, accScore, latScore, ramScore, total };
  }).sort((a, b) => b.total - a.total);

  console.log("| Model | Accuracy (60%) | Latency (25%) | RAM (15%) | TOTAL |");
  console.log("|-------|---------------|---------------|-----------|-------|");
  for (const c of composite) {
    console.log(`| ${c.model} | ${c.accScore.toFixed(1)} | ${c.latScore.toFixed(1)} | ${c.ramScore.toFixed(1)} | ${c.total.toFixed(1)} |`);
  }

  const winner = composite[0];
  console.log(`\n${"=".repeat(70)}`);
  console.log(`ROUND 2 WINNER: ${winner.model} — composite score ${winner.total.toFixed(1)}/100`);
  console.log("=".repeat(70));

  const outPath = "scripts/llm-benchmark/results-r2.json";
  await Bun.write(outPath, JSON.stringify({
    scores: allScores,
    ramUsage,
    ramSnapshots: allRamSnapshots,
    composite,
    winner: winner.model,
    timestamp: new Date().toISOString(),
  }, null, 2));
  console.log(`\nRaw results saved to ${outPath}`);
}

main().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});

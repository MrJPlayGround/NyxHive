import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";

interface BenchResult {
  cacheType: string;
  promptTokens: number;
  promptTokensPerSecond: number | null;
  generationTokens: number | null;
  generationTokensPerSecond: number | null;
  raw?: unknown;
  error?: string;
}

interface QualityResult {
  cacheType: string;
  contextSize: number;
  loadMemoryMb: number;
  afterRunMemoryMb: number;
  startupMs?: number;
  prompts: Array<{
    id: string;
    latencyMs: number;
    completionTokens: number;
    response: string;
  }>;
  error?: string;
}

interface HealthResponse {
  status?: string;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
  usage?: { completion_tokens?: number };
}

const LLAMA_SERVER = process.env.TURBOQUANT_LLAMA_SERVER ?? "/home/user/dev/llama-cpp-turboquant/build/bin/llama-server";
const LLAMA_BENCH = process.env.TURBOQUANT_LLAMA_BENCH ?? "/home/user/dev/llama-cpp-turboquant/build/bin/llama-bench";
const MODEL_PATH = process.env.TURBOQUANT_MODEL ?? "/home/user/dev/models/qwen2.5-3b-instruct-q4_k_m.gguf";
const PORT = Number.parseInt(process.env.TURBOQUANT_PORT ?? "8090", 10);
const GPU_LAYERS = Number.parseInt(process.env.TURBOQUANT_GPU_LAYERS ?? "99", 10);
const CACHE_TYPES = splitCsv(process.env.TURBOQUANT_CACHE_TYPES, ["f16", "q8_0", "q4_0", "turbo4", "turbo3"]);
const PROMPT_SIZES = splitCsv(process.env.TURBOQUANT_PROMPT_SIZES, ["2048", "8192", "16384"]).map((value) => Number.parseInt(value, 10));
const QUALITY_CONTEXT = Number.parseInt(process.env.TURBOQUANT_QUALITY_CONTEXT ?? "8192", 10);
const QUALITY_CACHE_TYPES = splitCsv(process.env.TURBOQUANT_QUALITY_CACHE_TYPES, ["f16", "turbo4", "turbo3"]);
const OUTPUT_DIR = process.env.TURBOQUANT_OUTPUT_DIR ?? join("scripts", "llm-benchmark", "out");
const SERVER_START_TIMEOUT_MS = Number.parseInt(process.env.TURBOQUANT_SERVER_TIMEOUT_MS ?? "60000", 10);
const COMPLETION_TIMEOUT_MS = Number.parseInt(process.env.TURBOQUANT_COMPLETION_TIMEOUT_MS ?? "180000", 10);

const QUALITY_PROMPTS = [
  { id: "classification", prompt: "Classify the sentiment as positive, negative, or neutral: 'The product works fine but the shipping was terrible and took 3 weeks.' Respond with one word." },
  { id: "routing", prompt: "A user says: 'Check the TypeScript files for unused imports.' Respond with only the best NyxHive agent name: nyx, analyst, tester, scout, or guide." },
  { id: "math", prompt: "What is 247 * 38? Show the calculation briefly." },
  { id: "code", prompt: "Write a Python function that returns true if a string is a valid email address using regex. Code only." },
  { id: "summary", prompt: "Summarize this in one sentence: The Federal Reserve held rates steady because inflation is still sticky, and markets rallied after the announcement." },
] as const;

function splitCsv(value: string | undefined, fallback: string[]): string[] {
  const items = value?.split(",").map((item) => item.trim()).filter(Boolean);
  return items && items.length > 0 ? items : fallback;
}

function getTimestamp(): string {
  return new Date().toISOString().replaceAll(":", "-");
}

function getMemoryMb(pid: number): number {
  const proc = Bun.spawnSync(["ps", "-o", "rss=", "-p", String(pid)]);
  if (proc.exitCode !== 0) return 0;
  const rssKb = Number.parseInt(proc.stdout.toString().trim(), 10);
  if (!Number.isFinite(rssKb)) return 0;
  return Math.round(rssKb / 1024);
}

async function waitForServer(port: number, timeoutMs = 30_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) {
        const body = await response.json() as HealthResponse;
        if (!body.status || body.status === "ok") return;
      }
    } catch {
      // ignore until timeout
    }
    await Bun.sleep(500);
  }
  throw new Error(`llama-server failed to become healthy on port ${port} within ${timeoutMs}ms`);
}

function startOutputDrain(stream: ReadableStream<Uint8Array> | null | undefined): Promise<string> {
  if (!stream) return Promise.resolve("");
  return new Response(stream).text().catch(() => "");
}

function benchArgs(cacheType: string, promptTokens: number): string[] {
  return [
    "-m", MODEL_PATH,
    "-ctk", cacheType,
    "-ctv", cacheType,
    "-ngl", String(GPU_LAYERS),
    "-p", String(promptTokens),
    "-n", "128",
    "-r", "1",
    "-o", "json",
  ];
}

function parseBenchOutput(output: string, cacheType: string, promptTokens: number): BenchResult {
  const parsed = JSON.parse(output) as Array<Record<string, unknown>>;
  const prompt = parsed.find((entry) => Number(entry.n_prompt) > 0);
  const generation = parsed.find((entry) => Number(entry.n_gen) > 0);
  if (!prompt || !generation) {
    throw new Error(`Unexpected llama-bench output for ${cacheType} @ ${promptTokens}`);
  }
  return {
    cacheType,
    promptTokens,
    promptTokensPerSecond: Number(prompt.avg_ts ?? 0),
    generationTokens: Number(generation.n_gen ?? 0),
    generationTokensPerSecond: Number(generation.avg_ts ?? 0),
    raw: parsed,
  };
}

async function runBenchmarks(): Promise<BenchResult[]> {
  const results: BenchResult[] = [];
  for (const cacheType of CACHE_TYPES) {
    for (const promptTokens of PROMPT_SIZES) {
      console.log(`[bench] ${cacheType} prompt=${promptTokens}`);
      const proc = Bun.spawn([LLAMA_BENCH, ...benchArgs(cacheType, promptTokens)], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const exitCode = await proc.exited;
      if (exitCode !== 0) {
        results.push({
          cacheType,
          promptTokens,
          promptTokensPerSecond: null,
          generationTokens: null,
          generationTokensPerSecond: null,
          error: (stderr || stdout).trim(),
        });
        console.log(`[bench] ${cacheType} prompt=${promptTokens} failed`);
        continue;
      }
      try {
        results.push(parseBenchOutput(stdout, cacheType, promptTokens));
      } catch (error) {
        results.push({
          cacheType,
          promptTokens,
          promptTokensPerSecond: null,
          generationTokens: null,
          generationTokensPerSecond: null,
          error: error instanceof Error ? error.message : String(error),
        });
        console.log(`[bench] ${cacheType} prompt=${promptTokens} parse failed`);
      }
    }
  }
  return results;
}

async function runCompletion(prompt: string): Promise<{ latencyMs: number; completionTokens: number; response: string }> {
  const startedAt = performance.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(`completion timed out after ${COMPLETION_TIMEOUT_MS}ms`), COMPLETION_TIMEOUT_MS);
  const response = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [{ role: "user", content: prompt }],
      max_tokens: 256,
      temperature: 0,
    }),
    signal: controller.signal,
  }).finally(() => clearTimeout(timeout));
  const latencyMs = Math.round(performance.now() - startedAt);
  if (!response.ok) {
    throw new Error(`completion request failed: ${response.status} ${await response.text()}`);
  }
  const body = await response.json() as ChatCompletionResponse;
  return {
    latencyMs,
    completionTokens: body.usage?.completion_tokens ?? 0,
    response: body.choices?.[0]?.message?.content?.trim() ?? "",
  };
}

async function withServer<T>(cacheType: string, contextSize: number, run: (pid: number, startupMs: number) => Promise<T>): Promise<T> {
  const args = [
    "-m", MODEL_PATH,
    "--cache-type-k", cacheType,
    "--cache-type-v", cacheType,
    "-ngl", String(GPU_LAYERS),
    "-c", String(contextSize),
    "--host", "127.0.0.1",
    "--port", String(PORT),
  ];
  const proc = Bun.spawn([LLAMA_SERVER, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdoutPromise = startOutputDrain(proc.stdout);
  const stderrPromise = startOutputDrain(proc.stderr);
  const startedAt = performance.now();
  try {
    await waitForServer(PORT, SERVER_START_TIMEOUT_MS);
    return await run(proc.pid, Math.round(performance.now() - startedAt));
  } finally {
    proc.kill();
    await proc.exited;
    await Promise.allSettled([stdoutPromise, stderrPromise]);
  }
}

async function runQualityChecks(): Promise<QualityResult[]> {
  const results: QualityResult[] = [];
  for (const cacheType of QUALITY_CACHE_TYPES) {
    console.log(`[quality] ${cacheType} ctx=${QUALITY_CONTEXT}`);
    try {
      const quality = await withServer(cacheType, QUALITY_CONTEXT, async (pid, startupMs) => {
        const prompts: QualityResult["prompts"] = [];
        const loadMemoryMb = getMemoryMb(pid);
        for (const item of QUALITY_PROMPTS) {
          const completion = await runCompletion(item.prompt);
          prompts.push({
            id: item.id,
            latencyMs: completion.latencyMs,
            completionTokens: completion.completionTokens,
            response: completion.response,
          });
        }
        return {
          cacheType,
          contextSize: QUALITY_CONTEXT,
          loadMemoryMb,
          afterRunMemoryMb: getMemoryMb(pid),
          startupMs,
          prompts,
        };
      });
      results.push(quality);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({
        cacheType,
        contextSize: QUALITY_CONTEXT,
        loadMemoryMb: 0,
        afterRunMemoryMb: 0,
        prompts: [],
        error: message,
      });
      console.log(`[quality] ${cacheType} failed: ${message}`);
    }
  }
  return results;
}

function printSummary(benchmarks: BenchResult[], quality: QualityResult[]): void {
  console.log("\nTurboQuant benchmark summary\n");
  console.log("| Cache | Prompt | Prompt tok/s | Gen tok/s |");
  console.log("|-------|--------|--------------|-----------|");
  for (const result of benchmarks) {
    const promptRate = result.promptTokensPerSecond === null ? "FAILED" : result.promptTokensPerSecond.toFixed(2);
    const genRate = result.generationTokensPerSecond === null ? "FAILED" : result.generationTokensPerSecond.toFixed(2);
    console.log(`| ${result.cacheType} | ${result.promptTokens} | ${promptRate} | ${genRate} |`);
  }

  console.log("\nQuality pass summary\n");
  console.log("| Cache | Load MB | After run MB | Startup | Avg latency |");
  console.log("|-------|---------|--------------|---------|-------------|");
  for (const result of quality) {
    if (result.error) {
      console.log(`| ${result.cacheType} | FAILED | FAILED | FAILED | ${result.error} |`);
      continue;
    }
    const avgLatency = Math.round(result.prompts.reduce((sum, item) => sum + item.latencyMs, 0) / result.prompts.length);
    console.log(`| ${result.cacheType} | ${result.loadMemoryMb} | ${result.afterRunMemoryMb} | ${result.startupMs ?? 0}ms | ${avgLatency}ms |`);
  }
}

async function main(): Promise<void> {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const timestamp = getTimestamp();
  const modelName = basename(MODEL_PATH);

  console.log(`TurboQuant local benchmark`);
  console.log(`Model: ${MODEL_PATH}`);
  console.log(`Cache types: ${CACHE_TYPES.join(", ")}`);
  console.log(`Prompt sizes: ${PROMPT_SIZES.join(", ")}`);

  const benchmarks = await runBenchmarks();
  const quality = await runQualityChecks();
  printSummary(benchmarks, quality);

  const outputPath = join(OUTPUT_DIR, `turboquant-${modelName}-${timestamp}.json`);
  await Bun.write(outputPath, JSON.stringify({
    model: MODEL_PATH,
    cacheTypes: CACHE_TYPES,
    promptSizes: PROMPT_SIZES,
    qualityContext: QUALITY_CONTEXT,
    benchmarks,
    quality,
    timestamp: new Date().toISOString(),
  }, null, 2));
  console.log(`\nSaved results to ${outputPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

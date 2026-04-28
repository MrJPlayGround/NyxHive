import type { TestPrompt } from "./prompts.js";

export interface PromptResult {
  prompt: TestPrompt;
  model: string;
  response: string;
  correct: boolean;
  latencyMs: number;
}

export interface ModelScore {
  model: string;
  total: number;
  correct: number;
  accuracy: number;
  avgLatencyMs: number;
  p95LatencyMs: number;
  byCategory: Record<string, { total: number; correct: number; accuracy: number }>;
}

export function checkAnswer(prompt: TestPrompt, response: string): boolean {
  const cleaned = response.trim().toUpperCase();
  return prompt.acceptableAnswers.some((ans) => {
    const expected = ans.toUpperCase();
    return prompt.substringMatch
      ? cleaned.includes(expected)
      : cleaned === expected;
  });
}

export function scoreModel(results: PromptResult[]): ModelScore {
  if (results.length === 0) throw new Error("No results to score");

  const model = results[0].model;
  const correct = results.filter((r) => r.correct).length;
  const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);
  const p95Index = Math.min(Math.floor((latencies.length - 1) * 0.95), latencies.length - 1);

  const byCategory: Record<string, { total: number; correct: number; accuracy: number }> = {};
  for (const r of results) {
    const cat = r.prompt.category;
    if (!byCategory[cat]) byCategory[cat] = { total: 0, correct: 0, accuracy: 0 };
    byCategory[cat].total++;
    if (r.correct) byCategory[cat].correct++;
  }
  for (const cat of Object.values(byCategory)) {
    cat.accuracy = cat.total > 0 ? cat.correct / cat.total : 0;
  }

  return {
    model,
    total: results.length,
    correct,
    accuracy: correct / results.length,
    avgLatencyMs: Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length),
    p95LatencyMs: latencies[p95Index] ?? latencies[latencies.length - 1],
    byCategory,
  };
}

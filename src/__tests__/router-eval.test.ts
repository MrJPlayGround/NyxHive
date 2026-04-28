/**
 * Accuracy evaluation: classifyLocal() vs routing-dataset.jsonl
 *
 * Measures baseline accuracy of the regex classifier against
 * the ground-truth dataset. Run with: bun test src/__tests__/router-eval.test.ts
 */
import { describe, test, expect } from "bun:test";
import { readFileSync, existsSync } from "fs";
import { ProviderRouter } from "../providers/router.js";
import type { TaskType } from "../providers/types.js";

const BASELINE_PATH = "data/routing-baseline.json";

interface Baseline {
  min_overall_accuracy: number;
  min_trap_accuracy: number;
}

function loadBaseline(): Baseline | null {
  if (!existsSync(BASELINE_PATH)) return null;
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, "utf-8"));
  } catch {
    return null;
  }
}

interface DatasetEntry {
  prompt: string;
  task_type: TaskType;
  tier: number;
  signals: string[];
  note: string;
}

const DATASET_PATH = "data/routing-dataset.jsonl";

function loadDataset(): DatasetEntry[] {
  if (!existsSync(DATASET_PATH)) return [];
  const raw = readFileSync(DATASET_PATH, "utf-8");
  return raw.trim().split("\n").map((line) => JSON.parse(line));
}

function isTrapExample(entry: DatasetEntry): boolean {
  const signals = entry.signals.map((s) => s.toLowerCase());
  const note = entry.note.toLowerCase();
  const prompt = entry.prompt.toLowerCase();
  const words = prompt.split(/\s+/);

  const minimizingWords = ["just", "quick", "small", "tiny", "simple", "easy", "minor", "little", "basic"];
  const hasMinimizingLanguage = entry.tier >= 3 && minimizingWords.some((w) => words.includes(w));
  const isShortButComplex = entry.prompt.length < 50 && entry.tier >= 3;
  const hasTrapSignal = signals.some((s) =>
    ["trap", "mislead", "deceptive", "user minimizes scope"].some((kw) => s.includes(kw))
  );
  const hasTrapNote = ["trap", "mislead", "sounds simple", "user says", "underestimat"].some((kw) => note.includes(kw));

  return hasMinimizingLanguage || isShortButComplex || hasTrapSignal || hasTrapNote;
}

function isContextDependent(entry: DatasetEntry): boolean {
  const signals = entry.signals.map((s) => s.toLowerCase());
  return signals.some((s) =>
    ["context-dependent", "continuation", "continuation prompt", "continuation request",
     "follow-up", "vague", "inherit previous", "inherit previous task type"].includes(s)
  );
}

const router = new ProviderRouter({
  orchestrator_model: "claude-opus-4-6",
  orchestrator_provider: "anthropic",
  classifier_model: "deepseek/deepseek-v3.2",
  classifier_provider: "openrouter",
  coding_model: "claude-sonnet-4-6",
  coding_provider: "anthropic",
});

const hasDataset = existsSync(DATASET_PATH);

describe("classifyLocal accuracy vs dataset", () => {
  const dataset = loadDataset();
  const traps = dataset.filter(isTrapExample);
  const contextDep = dataset.filter(isContextDependent);

  test.skipIf(!hasDataset)("report overall accuracy", () => {
    let correct = 0;
    const errors: Array<{ prompt: string; expected: string; got: string }> = [];

    for (const entry of dataset) {
      const classified = router.classifyLocal(entry.prompt);
      if (classified === entry.task_type) {
        correct++;
      } else {
        errors.push({ prompt: entry.prompt.slice(0, 80), expected: entry.task_type, got: classified });
      }
    }

    const accuracy = (correct / dataset.length * 100).toFixed(1);
    console.log(`\n=== OVERALL ACCURACY: ${accuracy}% (${correct}/${dataset.length}) ===`);

    // Report by task type
    const byType = new Map<string, { total: number; correct: number }>();
    for (const entry of dataset) {
      const classified = router.classifyLocal(entry.prompt);
      const key = entry.task_type;
      if (!byType.has(key)) byType.set(key, { total: 0, correct: 0 });
      const stat = byType.get(key)!;
      stat.total++;
      if (classified === entry.task_type) stat.correct++;
    }

    console.log("\n--- By task_type ---");
    for (const [type, stat] of [...byType.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      const pct = (stat.correct / stat.total * 100).toFixed(1);
      console.log(`  ${type.padEnd(16)} ${pct}% (${stat.correct}/${stat.total})`);
    }

    // Report by tier
    const byTier = new Map<number, { total: number; correct: number }>();
    for (const entry of dataset) {
      const classified = router.classifyLocal(entry.prompt);
      const key = entry.tier;
      if (!byTier.has(key)) byTier.set(key, { total: 0, correct: 0 });
      const stat = byTier.get(key)!;
      stat.total++;
      if (classified === entry.task_type) stat.correct++;
    }

    console.log("\n--- By tier ---");
    for (const [tier, stat] of [...byTier.entries()].sort((a, b) => a[0] - b[0])) {
      const pct = (stat.correct / stat.total * 100).toFixed(1);
      console.log(`  T${tier} ${pct}% (${stat.correct}/${stat.total})`);
    }

    // Sample errors
    console.log(`\n--- Sample misclassifications (${errors.length} total) ---`);
    for (const err of errors.slice(0, 20)) {
      console.log(`  "${err.prompt}" → expected ${err.expected}, got ${err.got}`);
    }

    // The regex classifier is a baseline — we expect imperfect results
    expect(correct).toBeGreaterThan(0);

    // CI gate: fail if accuracy drops below stored baseline
    const baseline = loadBaseline();
    if (baseline) {
      const accuracyNum = correct / dataset.length * 100;
      expect(accuracyNum).toBeGreaterThanOrEqual(baseline.min_overall_accuracy);
    }
  });

  test.skipIf(!hasDataset)("report trap example accuracy", () => {
    let correct = 0;
    const errors: Array<{ prompt: string; expected: string; got: string; tier: number }> = [];

    for (const entry of traps) {
      const classified = router.classifyLocal(entry.prompt);
      if (classified === entry.task_type) {
        correct++;
      } else {
        errors.push({ prompt: entry.prompt.slice(0, 80), expected: entry.task_type, got: classified, tier: entry.tier });
      }
    }

    const accuracy = (correct / traps.length * 100).toFixed(1);
    console.log(`\n=== TRAP ACCURACY: ${accuracy}% (${correct}/${traps.length}) ===`);

    console.log(`\n--- Sample trap misclassifications ---`);
    for (const err of errors.slice(0, 15)) {
      console.log(`  [T${err.tier}] "${err.prompt}" → expected ${err.expected}, got ${err.got}`);
    }

    expect(correct).toBeGreaterThan(0);

    // CI gate: fail if trap accuracy drops below stored baseline
    const baseline = loadBaseline();
    if (baseline) {
      const accuracyNum = correct / traps.length * 100;
      expect(accuracyNum).toBeGreaterThanOrEqual(baseline.min_trap_accuracy);
    }
  });

  test.skipIf(!hasDataset)("report context-dependent accuracy", () => {
    let correct = 0;
    const errors: Array<{ prompt: string; expected: string; got: string }> = [];

    for (const entry of contextDep) {
      const classified = router.classifyLocal(entry.prompt);
      if (classified === entry.task_type) {
        correct++;
      } else {
        errors.push({ prompt: entry.prompt.slice(0, 80), expected: entry.task_type, got: classified });
      }
    }

    const accuracy = (correct / contextDep.length * 100).toFixed(1);
    console.log(`\n=== CONTEXT-DEPENDENT ACCURACY: ${accuracy}% (${correct}/${contextDep.length}) ===`);

    console.log(`\n--- Sample context-dependent misclassifications ---`);
    for (const err of errors.slice(0, 15)) {
      console.log(`  "${err.prompt}" → expected ${err.expected}, got ${err.got}`);
    }

    expect(correct).toBeGreaterThan(0);
  });
});

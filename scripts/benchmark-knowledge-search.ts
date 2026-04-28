#!/usr/bin/env bun

import { Database } from "bun:sqlite";
import { cpSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KnowledgeStore } from "../src/memory/knowledge.js";

interface BenchmarkStats {
  label: string;
  corpusSize: number;
  dimensions: number;
  queries: number;
  limit: number;
  threshold: number;
  avgMs: number;
  medianMs: number;
  p95Ms: number;
  minMs: number;
  maxMs: number;
  avgScanned: number;
  avgReranked: number;
  strategies: Record<string, number>;
}

interface BenchmarkQuery {
  embedding: Float32Array;
  queryText: string;
}

interface LiveSource {
  label: string;
  dbPath: string;
  projectName: string;
}

const DIMENSIONS = Number(process.env.KNOWLEDGE_BENCH_DIMENSIONS ?? "1536");
const QUERY_COUNT = Number(process.env.KNOWLEDGE_BENCH_QUERIES ?? "40");
const SEARCH_LIMIT = Number(process.env.KNOWLEDGE_BENCH_LIMIT ?? "5");
const SEARCH_THRESHOLD = Number(process.env.KNOWLEDGE_BENCH_THRESHOLD ?? "0.7");
const SYNTHETIC_SIZES = (process.env.KNOWLEDGE_BENCH_SIZES ?? "1000,3000,5000,10000")
  .split(",")
  .map((value) => Number(value.trim()))
  .filter((value) => Number.isFinite(value) && value > 0);

const LIVE_SOURCES: LiveSource[] = [
  {
    label: "NyxAI",
    dbPath: "/home/user/.nyxhive/instances/NyxAI/data/nyxai_knowledge.db",
    projectName: "nyxai",
  },
  {
    label: "NyxLabs",
    dbPath: "/home/user/.nyxhive/instances/NyxLabs/data/nyxlabs_knowledge.db",
    projectName: "nyxlabs",
  },
  {
    label: "Acme",
    dbPath: "/home/user/.nyxhive/instances/Acme/data/acme_knowledge.db",
    projectName: "acme",
  },
];

function createRng(seed = 42): () => number {
  let state = seed >>> 0;
  return () => {
    state = (1664525 * state + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function makeNormalizedEmbedding(dimensions: number, rng: () => number): Float32Array {
  const vector = new Float32Array(dimensions);
  let norm = 0;
  for (let index = 0; index < dimensions; index++) {
    const value = rng() * 2 - 1;
    vector[index] = value;
    norm += value * value;
  }
  const scale = Math.sqrt(norm) || 1;
  for (let index = 0; index < dimensions; index++) {
    vector[index] /= scale;
  }
  return vector;
}

function percentile(sortedValues: number[], ratio: number): number {
  if (sortedValues.length === 0) return 0;
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil(sortedValues.length * ratio) - 1));
  return sortedValues[index] ?? 0;
}

function summarize(
  label: string,
  corpusSize: number,
  dimensions: number,
  queries: number,
  limit: number,
  threshold: number,
  durations: number[],
  scanned: number[],
  reranked: number[],
  strategies: Record<string, number>,
): BenchmarkStats {
  const sorted = durations.slice().sort((left, right) => left - right);
  const total = sorted.reduce((sum, value) => sum + value, 0);
  return {
    label,
    corpusSize,
    dimensions,
    queries,
    limit,
    threshold,
    avgMs: total / Math.max(sorted.length, 1),
    medianMs: percentile(sorted, 0.5),
    p95Ms: percentile(sorted, 0.95),
    minMs: sorted[0] ?? 0,
    maxMs: sorted[sorted.length - 1] ?? 0,
    avgScanned: scanned.reduce((sum, value) => sum + value, 0) / Math.max(scanned.length, 1),
    avgReranked: reranked.reduce((sum, value) => sum + value, 0) / Math.max(reranked.length, 1),
    strategies,
  };
}

function formatMs(value: number): string {
  return `${value.toFixed(2)}ms`;
}

function createSyntheticStore(size: number, dimensions: number, queries: number): { dir: string; store: KnowledgeStore; queryCases: BenchmarkQuery[] } {
  const dir = mkdtempSync(join(tmpdir(), "nyxhive-knowledge-bench-"));
  const store = new KnowledgeStore(dir, "bench", dimensions);
  const rng = createRng(size);
  const queryCases: BenchmarkQuery[] = [];
  const sampleStride = Math.max(1, Math.floor(size / queries));

  for (let index = 0; index < size; index++) {
    const embedding = makeNormalizedEmbedding(dimensions, rng);
    const topic = `topic${index % 20}`;
    const module = `module${Math.floor(index / 20)}`;
    store.upsertChunk(
      `Synthetic Doc ${index} ${topic}`,
      "Overview",
      `Synthetic benchmark chunk ${index} about ${topic} ${module}`,
      "benchmark",
      `/synthetic/doc-${index}.md`,
      `hash-${index}`,
      embedding,
      "global",
      1,
      undefined,
      0,
    );
    if (queryCases.length < queries && index % sampleStride === 0) {
      queryCases.push({
        embedding: new Float32Array(embedding),
        queryText: `${topic} ${module}`,
      });
    }
  }

  while (queryCases.length < queries) {
    const embedding = makeNormalizedEmbedding(dimensions, rng);
    queryCases.push({
      embedding,
      queryText: `topic${queryCases.length % 20}`,
    });
  }

  return { dir, store, queryCases };
}

function loadLiveQueryCases(dbPath: string, dimensions: number, queries: number): BenchmarkQuery[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db
      .query("SELECT embedding, title, section, category FROM knowledge_chunks ORDER BY RANDOM() LIMIT ?")
      .all(queries) as Array<{ embedding: Buffer; title: string; section: string | null; category: string | null }>;
    return rows
      .map((row) => ({
        embedding: new Float32Array(new Float32Array(row.embedding.buffer, row.embedding.byteOffset, dimensions)),
        queryText: [row.title, row.section, row.category].filter(Boolean).join(" "),
      }));
  } finally {
    db.close();
  }
}

function copyLiveDb(source: LiveSource): { dir: string; copiedDbPath: string; store: KnowledgeStore } {
  const dir = mkdtempSync(join(tmpdir(), "nyxhive-knowledge-live-"));
  const copiedDbPath = join(dir, `${source.projectName}_knowledge.db`);
  cpSync(source.dbPath, copiedDbPath);
  const walPath = `${source.dbPath}-wal`;
  const shmPath = `${source.dbPath}-shm`;
  try { cpSync(walPath, `${copiedDbPath}-wal`); } catch { /* ignore */ }
  try { cpSync(shmPath, `${copiedDbPath}-shm`); } catch { /* ignore */ }
  const store = new KnowledgeStore(dir, source.projectName, DIMENSIONS);
  return { dir, copiedDbPath, store };
}

function readCorpusSize(dbPath: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db.query("SELECT COUNT(*) AS count FROM knowledge_chunks").get() as { count: number };
    return row.count;
  } finally {
    db.close();
  }
}

function runSearchBenchmark(
  label: string,
  corpusSize: number,
  store: KnowledgeStore,
  queryCases: BenchmarkQuery[],
): BenchmarkStats {
  for (let index = 0; index < Math.min(5, queryCases.length); index++) {
    const sample = queryCases[index]!;
    store.searchDetailed(sample.embedding, SEARCH_LIMIT, SEARCH_THRESHOLD, undefined, undefined, sample.queryText);
  }

  const durations: number[] = [];
  const scanned: number[] = [];
  const reranked: number[] = [];
  const strategies: Record<string, number> = {};
  for (const queryCase of queryCases) {
    const started = performance.now();
    const result = store.searchDetailed(
      queryCase.embedding,
      SEARCH_LIMIT,
      SEARCH_THRESHOLD,
      undefined,
      undefined,
      queryCase.queryText,
    );
    durations.push(performance.now() - started);
    scanned.push(result.stats.scannedCount);
    reranked.push(result.stats.rerankedCount);
    strategies[result.stats.strategy] = (strategies[result.stats.strategy] ?? 0) + 1;
  }

  return summarize(label, corpusSize, DIMENSIONS, queryCases.length, SEARCH_LIMIT, SEARCH_THRESHOLD, durations, scanned, reranked, strategies);
}

function printTable(stats: BenchmarkStats[]): void {
  console.log("");
  console.log("label        corpus  avg      median   p95      scanned  rerank");
  console.log("-----------  ------  -------  -------  -------  -------  -------");
  for (const stat of stats) {
    const label = stat.label.padEnd(11, " ");
    const corpus = String(stat.corpusSize).padStart(6, " ");
    console.log(`${label}  ${corpus}  ${formatMs(stat.avgMs).padStart(7, " ")}  ${formatMs(stat.medianMs).padStart(7, " ")}  ${formatMs(stat.p95Ms).padStart(7, " ")}  ${String(stat.avgScanned.toFixed(1)).padStart(7, " ")}  ${String(stat.avgReranked.toFixed(1)).padStart(7, " ")}`);
  }
}

async function main(): Promise<void> {
  const stats: BenchmarkStats[] = [];

  for (const size of SYNTHETIC_SIZES) {
    const { dir, store, queryCases } = createSyntheticStore(size, DIMENSIONS, QUERY_COUNT);
    try {
      stats.push(runSearchBenchmark(`synthetic-${size}`, size, store, queryCases));
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  for (const source of LIVE_SOURCES) {
    const { dir, copiedDbPath, store } = copyLiveDb(source);
    try {
      const corpusSize = readCorpusSize(copiedDbPath);
      const queryCases = loadLiveQueryCases(copiedDbPath, DIMENSIONS, QUERY_COUNT);
      stats.push(runSearchBenchmark(source.label, corpusSize, store, queryCases));
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  printTable(stats);

  const outputDir = join("/home/user/dev/nyxhive", "data");
  mkdirSync(outputDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputPath = join(outputDir, `knowledge-search-benchmark-${timestamp}.json`);
  writeFileSync(outputPath, JSON.stringify({ generatedAt: new Date().toISOString(), stats }, null, 2));
  console.log("");
  console.log(`Saved results to ${outputPath}`);
}

await main();

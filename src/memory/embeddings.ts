import { logger } from "../utils/logger.js";

const OPENROUTER_EMBEDDINGS_URL = "https://openrouter.ai/api/v1/embeddings";
const MAX_BATCH_SIZE = 50;

export interface EmbeddingProvider {
  embed(text: string): Promise<Float32Array>;
  embedBatch(texts: string[]): Promise<Float32Array[]>;
  readonly dimensions: number;
}

interface EmbeddingResponse {
  data?: Array<{ embedding: number[]; index: number }>;
  usage?: { prompt_tokens: number; total_tokens: number };
}

export class OpenRouterEmbedding implements EmbeddingProvider {
  private apiKey: string;
  private model: string;
  readonly dimensions: number;
  private cache = new Map<string, { embedding: Float32Array; ts: number }>();
  private static readonly CACHE_MAX = 256;
  private static readonly CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

  constructor(apiKey: string, model = "openai/text-embedding-3-small", dimensions = 1536) {
    this.apiKey = apiKey;
    this.model = model;
    this.dimensions = dimensions;
  }

  async embed(text: string): Promise<Float32Array> {
    const cached = this.cache.get(text);
    if (cached && Date.now() - cached.ts < OpenRouterEmbedding.CACHE_TTL_MS) {
      return cached.embedding;
    }

    const results = await this.embedBatch([text]);
    this.cacheSet(text, results[0]);
    return results[0];
  }

  private cacheSet(key: string, embedding: Float32Array): void {
    if (this.cache.size >= OpenRouterEmbedding.CACHE_MAX) {
      let oldestKey: string | undefined;
      let oldestTs = Number.POSITIVE_INFINITY;
      for (const [k, v] of this.cache) {
        if (v.ts < oldestTs) { oldestTs = v.ts; oldestKey = k; }
      }
      if (oldestKey) this.cache.delete(oldestKey);
    }
    this.cache.set(key, { embedding, ts: Date.now() });
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    const allEmbeddings: Float32Array[] = new Array(texts.length);

    for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
      const batch = texts.slice(i, i + MAX_BATCH_SIZE);

      const response = await fetch(OPENROUTER_EMBEDDINGS_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: this.model,
          input: batch,
          dimensions: this.dimensions,
        }),
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Embedding API error ${response.status}: ${text}`);
      }

      const data = (await response.json()) as EmbeddingResponse;
      const batchNumber = i / MAX_BATCH_SIZE + 1;
      logger.debug(`[embeddings] Batch ${batchNumber}: ${data.usage?.prompt_tokens ?? "?"} tokens`);

      if (!data.data?.length) {
        throw new Error(`Embedding API returned no data for batch ${batchNumber}`);
      }

      // Sort by index to maintain order
      const sorted = data.data.sort((a, b) => a.index - b.index);
      for (let j = 0; j < sorted.length; j++) {
        allEmbeddings[i + j] = new Float32Array(sorted[j].embedding);
      }
    }

    return allEmbeddings;
  }
}

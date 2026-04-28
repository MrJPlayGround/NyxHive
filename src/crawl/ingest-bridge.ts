import { chunkMarkdown } from "../memory/ingest.js";
import type { EmbeddingProvider } from "../memory/embeddings.js";
import type { KnowledgeStore } from "../memory/knowledge.js";
import type { CrawlIngestStats, CrawlResult, CrawlSource } from "./types.js";

export class CrawlIngestBridge {
  constructor(
    private readonly store: KnowledgeStore,
    private readonly embedder: EmbeddingProvider,
  ) {}

  async ingestCrawlResults(results: CrawlResult[], source: CrawlSource): Promise<CrawlIngestStats> {
    const stats: CrawlIngestStats = {
      pagesProcessed: 0,
      chunksCreated: 0,
      chunksSkipped: 0,
      errors: [],
    };

    const existingHashes = this.store.getExistingHashes();
    const toEmbed: Array<ReturnType<typeof chunkMarkdown>[number]> = [];
    const sourceAgent = `crawl:${source.name}`;
    const crawledAt = new Date().toISOString();

    for (const result of results) {
      if (result.statusCode !== 200 || !result.markdown.trim()) continue;
      stats.pagesProcessed++;

      try {
        const content = buildSyntheticMarkdown(result.url, source, result.markdown, crawledAt);
        const title = derivePageTitle(result.url);
        const chunks = chunkMarkdown(title, content, "crawl", result.url);

        for (const chunk of chunks) {
          const key = `${chunk.sourcePath}::${chunk.section ?? "_ROOT_"}::${chunk.chunkIndex}`;
          const existingHash = existingHashes.get(key);
          if (existingHash === chunk.contentHash) {
            stats.chunksSkipped++;
            continue;
          }
          toEmbed.push(chunk);
        }
      } catch (error) {
        stats.errors.push(`${result.url}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const batchSize = 50;
    for (let index = 0; index < toEmbed.length; index += batchSize) {
      const batch = toEmbed.slice(index, index + batchSize);
      const embeddings = await this.embedder.embedBatch(batch.map((chunk) => chunk.prefixed));

      for (let offset = 0; offset < batch.length; offset++) {
        const chunk = batch[offset];
        this.store.upsertChunk(
          chunk.title,
          chunk.section,
          chunk.content,
          chunk.category,
          chunk.sourcePath,
          chunk.contentHash,
          embeddings[offset],
          source.scope,
          chunk.priority,
          sourceAgent,
          chunk.chunkIndex,
        );
        stats.chunksCreated++;
      }
    }

    return stats;
  }
}

function buildSyntheticMarkdown(url: string, source: CrawlSource, markdown: string, crawledAt: string): string {
  return [
    "---",
    "source: crawl",
    `url: ${escapeFrontmatterValue(url)}`,
    `scope: ${escapeFrontmatterValue(source.scope)}`,
    `crawl_source: ${escapeFrontmatterValue(source.name)}`,
    `crawled_at: ${escapeFrontmatterValue(crawledAt)}`,
    "---",
    "",
    markdown,
  ].join("\n");
}

function derivePageTitle(url: string): string {
  const parsed = new URL(url);
  const parts = parsed.pathname.split("/").filter(Boolean);
  const last = parts.at(-1);
  return last ? decodeURIComponent(last) : parsed.hostname;
}

function escapeFrontmatterValue(value: string): string {
  return JSON.stringify(value);
}

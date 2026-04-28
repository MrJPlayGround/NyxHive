import { describe, expect, mock, test } from "bun:test";
import { chunkMarkdown } from "../memory/ingest.js";
import type { EmbeddingProvider } from "../memory/embeddings.js";
import type { KnowledgeStore } from "../memory/knowledge.js";
import { CrawlIngestBridge } from "../crawl/index.js";

const SOURCE = {
  id: "source-1",
  name: "bun-docs",
  url: "https://bun.sh/docs",
  schedule: "0 3 * * 0",
  depth: 2,
  pageLimit: 50,
  pathGlob: null,
  scope: "reference",
  enabled: true,
  lastCrawlAt: null,
  lastStatus: null,
  lastError: null,
  pagesFound: 0,
  chunksCreated: 0,
  origin: "config",
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

function makeEmbedder(): EmbeddingProvider {
  return {
    dimensions: 3,
    embed: mock(async () => new Float32Array([1, 0, 0])),
    embedBatch: mock(async (texts: string[]) => texts.map((_, index) => new Float32Array([index + 1, 0, 0]))),
  };
}

describe("CrawlIngestBridge", () => {
  test("filters bad pages and preserves source metadata on upsert", async () => {
    const upsertChunk = mock(() => {});
    const store = {
      getExistingHashes: () => new Map<string, string>(),
      upsertChunk,
    } as unknown as KnowledgeStore;
    const bridge = new CrawlIngestBridge(store, makeEmbedder());

    const stats = await bridge.ingestCrawlResults([
      {
        url: "https://bun.sh/docs/runtime",
        markdown: "## Runtime\n" + "A".repeat(120),
        statusCode: 200,
      },
      {
        url: "https://bun.sh/docs/missing",
        markdown: "## Missing\n" + "B".repeat(120),
        statusCode: 404,
      },
      {
        url: "https://bun.sh/docs/empty",
        markdown: "   ",
        statusCode: 200,
      },
    ], SOURCE);

    expect(stats).toMatchObject({
      pagesProcessed: 1,
      chunksCreated: 1,
      chunksSkipped: 0,
      errors: [],
    });
    expect(upsertChunk).toHaveBeenCalledTimes(1);
    const args = upsertChunk.mock.calls[0] as unknown as unknown[];
    expect(args[4]).toBe("https://bun.sh/docs/runtime");
    expect(args[7]).toBe("reference");
    expect(args[9]).toBe("crawl:bun-docs");
  });

  test("skips unchanged chunks using existing hashes", async () => {
    const url = "https://bun.sh/docs/setup";
    const markdown = "## Setup\n" + "C".repeat(120);
    const existingChunk = chunkMarkdown("setup", markdown, "crawl", url)[0]!;
    const upsertChunk = mock(() => {});
    const store = {
      getExistingHashes: () => new Map([[`${url}::${existingChunk.section ?? "_ROOT_"}::${existingChunk.chunkIndex}`, existingChunk.contentHash]]),
      upsertChunk,
    } as unknown as KnowledgeStore;
    const bridge = new CrawlIngestBridge(store, makeEmbedder());

    const stats = await bridge.ingestCrawlResults([{ url, markdown, statusCode: 200 }], SOURCE);

    expect(stats).toMatchObject({
      pagesProcessed: 1,
      chunksCreated: 0,
      chunksSkipped: 1,
    });
    expect(upsertChunk).not.toHaveBeenCalled();
  });

  test("accumulates per-page errors without aborting the batch", async () => {
    const upsertChunk = mock(() => {});
    const store = {
      getExistingHashes: () => new Map<string, string>(),
      upsertChunk,
    } as unknown as KnowledgeStore;
    const bridge = new CrawlIngestBridge(store, makeEmbedder());

    const stats = await bridge.ingestCrawlResults([
      {
        url: "not-a-url",
        markdown: "## Broken\n" + "D".repeat(120),
        statusCode: 200,
      },
      {
        url: "https://bun.sh/docs/api",
        markdown: "## API\n" + "E".repeat(120),
        statusCode: 200,
      },
    ], SOURCE);

    expect(stats.pagesProcessed).toBe(2);
    expect(stats.chunksCreated).toBe(1);
    expect(stats.errors).toHaveLength(1);
    expect(stats.errors[0]).toContain("not-a-url");
    expect(upsertChunk).toHaveBeenCalledTimes(1);
  });
});

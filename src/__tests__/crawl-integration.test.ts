import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CrawlIngestBridge, CrawlService, CrawlSourceStore } from "../crawl/index.js";
import { KnowledgeStore } from "../memory/knowledge.js";
import { Scheduler } from "../scheduler/index.js";

function okResponse(result: unknown): Response {
  return new Response(JSON.stringify({ success: true, result }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

describe("crawl integration", () => {
  let db: Database;
  let dataDir: string;
  let store: KnowledgeStore;
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    process.env.CLOUDFLARE_ACCOUNT_ID = "acct-test";
    process.env.CLOUDFLARE_API_TOKEN = "cf-test-token";
    db = new Database(":memory:");
    dataDir = mkdtempSync(join(tmpdir(), "nyxhive-crawl-int-"));
    store = new KnowledgeStore(dataDir, "crawl-int", 3);
    fetchSpy = spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
    store.close();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_API_TOKEN;
  });

  it("runs the scheduler crawl task and cleans up disabled source knowledge", async () => {
    fetchSpy
      .mockResolvedValueOnce(okResponse("job-123"))
      .mockResolvedValueOnce(okResponse({ id: "job-123", status: "completed" }))
      .mockResolvedValueOnce(okResponse({
        status: "completed",
        records: [{
          url: "https://example.com/docs/api",
          markdown: "# API\n\nDetailed API documentation that is long enough to become knowledge because it includes a proper explanatory paragraph with enough text to clear the chunking threshold cleanly.",
          statusCode: 200,
        }],
      }));

    const sources = new CrawlSourceStore(db, { default_depth: 2, default_page_limit: 50 });
    const sourceId = sources.addDynamic({
      name: "example-docs",
      url: "https://example.com/docs",
      schedule: "0 * * * *",
      origin: "agent:mcp",
    });
    db.run("UPDATE crawl_sources SET created_at = ?, last_crawl_at = ? WHERE id = ?", [
      Date.parse("2026-03-10T00:00:00.000Z"),
      Date.parse("2026-03-10T01:00:00.000Z"),
      sourceId,
    ]);

    const bridge = new CrawlIngestBridge(store, {
      embedBatch: async (texts: string[]) => texts.map(() => new Float32Array([1, 2, 3])),
    } as any);
    const service = new CrawlService({ pollIntervalMs: 1, timeoutMs: 50 });
    const processor = {
      shouldRunAutonomousTask: () => true,
      emitEvent: () => {},
      getGraphMemory: () => undefined,
      getKnowledge: () => store,
      getRouting: () => undefined,
      getOutcomes: () => undefined,
      getPatterns: () => undefined,
      getChannels: () => undefined,
    } as any;

    const scheduler = new Scheduler(db, processor, { scheduler: {} } as any);
    scheduler.setCrawlRuntime({ service, sources, ingest: bridge });

    const runTaskId = scheduler.addTask({
      name: "crawl:run-sources",
      agent: "system",
      prompt: "run crawls",
      cron_expression: "0 */4 * * *",
    });
    await scheduler.triggerTask(runTaskId);

    expect(store.getAllChunks().length).toBeGreaterThan(0);
    expect(sources.getById(sourceId)?.lastStatus).toBe("completed");

    sources.remove(sourceId);
    const cleanupTaskId = scheduler.addTask({
      name: "crawl:cleanup-stale",
      agent: "system",
      prompt: "cleanup crawls",
      cron_expression: "30 3 * * 0",
    });
    await scheduler.triggerTask(cleanupTaskId);

    expect(store.getAllChunks()).toHaveLength(0);
  });
});

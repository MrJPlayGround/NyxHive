import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { NyxHiveConfig } from "../types.js";
import { Scheduler } from "../scheduler/index.js";
import { CrawlSourceStore } from "../crawl/index.js";

function makeConfig(): NyxHiveConfig {
  return {
    daemon: {
      name: "test-instance",
      log_level: "info",
      data_dir: "/tmp/test-instance",
    },
    server: { port: 3777 },
    agents: {},
    providers: {},
    routing: {
      classifier_model: "test-model",
      classifier_provider: "openrouter",
      cli_escalation_tasks: [],
    },
    context: {
      max_history: 10,
      summary_threshold: 5,
    },
  } as unknown as NyxHiveConfig;
}

describe("Scheduler crawl system tasks", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  test("crawl:run-sources crawls due sources and updates stats", async () => {
    const processor = {
      getKnowledge: mock(() => undefined),
    };
    const scheduler = new Scheduler(db, processor as any, makeConfig());
    const sources = new CrawlSourceStore(db, {
      default_depth: 2,
      default_page_limit: 50,
    });
    const sourceId = sources.addDynamic({
      name: "bun-docs",
      url: "https://bun.sh/docs",
      schedule: "0 */4 * * *",
      origin: "agent:test",
    });
    const createdAt = new Date("2026-03-11T00:00:00Z").getTime();
    db.run("UPDATE crawl_sources SET created_at = ?, updated_at = ? WHERE id = ?", [createdAt, createdAt, sourceId]);

    const service = {
      crawlSite: mock(async () => [
        { url: "https://bun.sh/docs/runtime", markdown: "## Runtime\n" + "A".repeat(120), statusCode: 200 },
      ]),
    };
    const ingest = {
      ingestCrawlResults: mock(async () => ({
        pagesProcessed: 1,
        chunksCreated: 4,
        chunksSkipped: 0,
        errors: [],
      })),
    };

    scheduler.setCrawlRuntime({
      service: service as any,
      sources,
      ingest: ingest as any,
    });

    const result = await (scheduler as any).executeSystemTask({ name: "crawl:run-sources" });
    const updated = sources.getById(sourceId);

    expect(result).toContain("bun-docs: 1 pages, 4 chunks");
    expect(service.crawlSite).toHaveBeenCalledTimes(1);
    expect(ingest.ingestCrawlResults).toHaveBeenCalledTimes(1);
    expect(updated).toMatchObject({
      lastStatus: "completed",
      pagesFound: 1,
      chunksCreated: 4,
    });
    expect(updated?.lastCrawlAt).not.toBeNull();
  });

  test("crawl:cleanup-stale removes knowledge for inactive sources", async () => {
    const knowledge = {
      deleteBySourceAgent: mock(() => 3),
    };
    const processor = {
      getKnowledge: mock(() => knowledge),
    };
    const scheduler = new Scheduler(db, processor as any, makeConfig());
    const sources = new CrawlSourceStore(db, {});
    const sourceId = sources.addDynamic({
      name: "old-docs",
      url: "https://example.com/docs",
      schedule: "0 3 * * 0",
      origin: "agent:test",
    });
    sources.remove(sourceId);

    scheduler.setCrawlRuntime({ sources });

    const result = await (scheduler as any).executeSystemTask({ name: "crawl:cleanup-stale" });

    expect(result).toBe("Removed 3 crawl chunks from 1 inactive sources");
    expect(knowledge.deleteBySourceAgent).toHaveBeenCalledWith("crawl:old-docs");
  });
});

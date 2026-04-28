import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { CrawlSourceStore } from "../crawl/index.js";

describe("CrawlSourceStore", () => {
  let db: Database;
  let store: CrawlSourceStore;

  beforeEach(() => {
    db = new Database(":memory:");
    store = new CrawlSourceStore(db, {
      default_depth: 3,
      default_page_limit: 75,
    });
  });

  afterEach(() => {
    db.close();
  });

  test("upserts config sources with defaults and disables removed ones", () => {
    store.upsertFromConfig([
      {
        name: "bun-docs",
        url: "https://bun.sh/docs",
        schedule: "0 3 * * 0",
      },
    ]);

    const enabled = store.getEnabled();
    expect(enabled).toHaveLength(1);
    expect(enabled[0]).toMatchObject({
      name: "bun-docs",
      depth: 3,
      pageLimit: 75,
      scope: "general",
      origin: "config",
      enabled: true,
    });

    store.upsertFromConfig([]);

    expect(store.getEnabled()).toHaveLength(0);
    expect(store.getInactive()[0]).toMatchObject({
      name: "bun-docs",
      enabled: false,
      lastStatus: "removed",
    });
  });

  test("returns due sources from cron evaluation", () => {
    const id = store.addDynamic({
      name: "docs",
      url: "https://example.com/docs",
      schedule: "0 */4 * * *",
      origin: "agent:test",
    });

    const createdAt = new Date("2026-03-11T00:00:00Z").getTime();
    db.run("UPDATE crawl_sources SET created_at = ?, updated_at = ? WHERE id = ?", [createdAt, createdAt, id]);

    const due = store.getDue(new Date("2026-03-11T04:00:00Z").getTime());
    expect(due.map((source) => source.id)).toContain(id);

    const notDue = store.getDue(new Date("2026-03-11T03:59:00Z").getTime());
    expect(notDue.map((source) => source.id)).not.toContain(id);
  });

  test("blocks config removal but disables dynamic sources", () => {
    store.upsertFromConfig([
      {
        name: "config-docs",
        url: "https://example.com/config",
        schedule: "0 3 * * 0",
      },
    ]);
    const configSource = store.getEnabled()[0];
    expect(() => store.remove(configSource.id)).toThrow("Config crawl sources cannot be removed at runtime");

    const dynamicId = store.addDynamic({
      name: "dynamic-docs",
      url: "https://example.com/dynamic",
      schedule: "0 3 * * 0",
      origin: "agent:test",
    });
    store.remove(dynamicId);

    expect(store.getById(dynamicId)).toMatchObject({
      enabled: false,
      lastStatus: "removed",
    });
  });

  test("upserts dynamic sources by name and preserves the existing id", () => {
    const firstId = store.addDynamic({
      name: "docs",
      url: "https://example.com/docs",
      schedule: "0 3 * * 0",
      origin: "agent:test",
    });
    store.remove(firstId);

    const secondId = store.addDynamic({
      name: "docs",
      url: "https://example.com/reference",
      schedule: "0 4 * * 1",
      depth: 5,
      pageLimit: 120,
      pathGlob: "/reference/**",
      scope: "reference",
      origin: "agent:mcp",
    });

    expect(secondId).toBe(firstId);
    expect(store.getEnabled()).toHaveLength(1);
    expect(store.getById(firstId)).toMatchObject({
      id: firstId,
      url: "https://example.com/reference",
      schedule: "0 4 * * 1",
      depth: 5,
      pageLimit: 120,
      pathGlob: "/reference/**",
      scope: "reference",
      origin: "agent:mcp",
      enabled: true,
    });
  });

  test("updates crawl stats without overwriting last successful run on failure", () => {
    const id = store.addDynamic({
      name: "docs",
      url: "https://example.com/docs",
      schedule: "0 3 * * 0",
      origin: "agent:test",
    });

    const completedAt = new Date("2026-03-11T03:00:00Z").getTime();
    store.updateAfterCrawl(id, "completed", {
      pagesFound: 12,
      chunksCreated: 48,
      completedAt,
    });

    expect(store.getById(id)).toMatchObject({
      lastCrawlAt: completedAt,
      lastStatus: "completed",
      pagesFound: 12,
      chunksCreated: 48,
    });

    store.updateAfterCrawl(id, "failed", {
      lastError: "rate limited",
      completedAt: completedAt + 60_000,
    });

    expect(store.getById(id)).toMatchObject({
      lastCrawlAt: completedAt,
      lastStatus: "failed",
      lastError: "rate limited",
      pagesFound: 0,
      chunksCreated: 0,
    });
  });
});

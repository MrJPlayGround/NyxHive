import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { Database } from "bun:sqlite";
import {
  buildCrawlUsage,
  formatCrawlCommandResult,
  parseCrawlCommandText,
  runCrawlCommand,
  validateCrawlUrl,
} from "../crawl/command.js";
import { CrawlSourceStore } from "../crawl/index.js";

describe("parseCrawlCommandText", () => {
  it("parses url and flags", () => {
    const parsed = parseCrawlCommandText('/crawl https://example.com/docs --save --scope reference --depth 3 --limit 25 --glob "/api/**"');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.input).toEqual({
      url: "https://example.com/docs",
      saveSource: true,
      scope: "reference",
      depth: 3,
      limit: 25,
      pathGlob: "/api/**",
    });
  });

  it("returns usage on missing url", () => {
    const parsed = parseCrawlCommandText("/crawl");
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toBe(buildCrawlUsage("/crawl"));
  });

  it("rejects invalid numeric bounds", () => {
    const parsed = parseCrawlCommandText("/crawl https://example.com --depth 0");
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("Depth must be an integer between 1 and 10.");
  });

  it("rejects file:// scheme", () => {
    const parsed = parseCrawlCommandText("/crawl file:///etc/passwd");
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("Unsupported scheme");
  });

  it("rejects ftp:// scheme", () => {
    const parsed = parseCrawlCommandText("/crawl ftp://example.com/file");
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("Unsupported scheme");
  });

  it("rejects localhost", () => {
    const parsed = parseCrawlCommandText("/crawl http://localhost:8080/admin");
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("Blocked destination");
  });

  it("rejects 127.0.0.1", () => {
    const parsed = parseCrawlCommandText("/crawl http://127.0.0.1/secret");
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("Blocked destination");
  });

  it("rejects private IP 10.x", () => {
    const parsed = parseCrawlCommandText("/crawl http://10.0.0.1/internal");
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("Blocked destination");
  });

  it("rejects private IP 172.16.x", () => {
    const parsed = parseCrawlCommandText("/crawl http://172.16.0.1/internal");
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("Blocked destination");
  });

  it("rejects private IP 192.168.x", () => {
    const parsed = parseCrawlCommandText("/crawl http://192.168.1.1/router");
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("Blocked destination");
  });

  it("rejects link-local 169.254.x", () => {
    const parsed = parseCrawlCommandText("/crawl http://169.254.169.254/metadata");
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("Blocked destination");
  });

  it("rejects 0.0.0.0", () => {
    const parsed = parseCrawlCommandText("/crawl http://0.0.0.0/");
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toContain("Blocked destination");
  });

  it("accepts valid https URL", () => {
    const parsed = parseCrawlCommandText("/crawl https://docs.example.com/api");
    expect(parsed.ok).toBe(true);
  });

  it("accepts valid http URL", () => {
    const parsed = parseCrawlCommandText("/crawl http://example.com/page");
    expect(parsed.ok).toBe(true);
  });
});

describe("validateCrawlUrl", () => {
  it("returns null for valid https URL", () => {
    expect(validateCrawlUrl("https://example.com")).toBeNull();
  });

  it("returns null for valid http URL", () => {
    expect(validateCrawlUrl("http://example.com")).toBeNull();
  });

  it("rejects file:// scheme", () => {
    expect(validateCrawlUrl("file:///etc/passwd")).toContain("Unsupported scheme");
  });

  it("rejects javascript: scheme", () => {
    expect(validateCrawlUrl("javascript:alert(1)")).not.toBeNull();
  });

  it("rejects data: scheme", () => {
    expect(validateCrawlUrl("data:text/html,<h1>hi</h1>")).not.toBeNull();
  });

  it("rejects localhost", () => {
    expect(validateCrawlUrl("http://localhost")).toContain("Blocked destination");
  });

  it("rejects ::1", () => {
    expect(validateCrawlUrl("http://[::1]/")).toContain("Blocked destination");
  });

  it("rejects 127.x.x.x range", () => {
    expect(validateCrawlUrl("http://127.0.0.2/")).toContain("Blocked destination");
  });

  it("rejects 172.31.x (top of range)", () => {
    expect(validateCrawlUrl("http://172.31.255.1/")).toContain("Blocked destination");
  });

  it("allows 172.32.x (outside private range)", () => {
    expect(validateCrawlUrl("http://172.32.0.1/")).toBeNull();
  });

  it("rejects completely invalid URL", () => {
    expect(validateCrawlUrl("not-a-url")).toContain("Invalid URL");
  });
});

describe("runCrawlCommand", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  it("executes crawl and saves a recurring source when requested", async () => {
    const runtime = {
      service: {
        crawlSite: mock(async () => [
          { url: "https://example.com/docs", markdown: "# Docs", statusCode: 200 },
          { url: "https://example.com/setup", markdown: "# Setup", statusCode: 200 },
        ]),
      },
      ingest: {
        ingestCrawlResults: mock(async () => ({
          pagesProcessed: 2,
          chunksCreated: 5,
          chunksSkipped: 1,
          errors: [],
        })),
      },
      sources: {
        addDynamic: mock(() => "source-123"),
        updateAfterCrawl: mock(() => {}),
      },
    };

    const result = await runCrawlCommand({
      url: "https://example.com/docs",
      saveSource: true,
      origin: "test",
    }, runtime as any);

    expect(runtime.service.crawlSite).toHaveBeenCalled();
    expect(runtime.ingest.ingestCrawlResults).toHaveBeenCalled();
    expect(runtime.sources.addDynamic).toHaveBeenCalled();
    expect(result.sourceId).toBe("source-123");
    expect(formatCrawlCommandResult(result)).toContain('Saved recurring source');
  });

  it("reuses an existing saved source when the same name is saved again", async () => {
    const sources = new CrawlSourceStore(db, {
      default_depth: 2,
      default_page_limit: 50,
    });
    const runtime = {
      service: {
        crawlSite: mock(async (url: string) => [
          { url, markdown: "# Docs", statusCode: 200 },
        ]),
      },
      ingest: {
        ingestCrawlResults: mock(async () => ({
          pagesProcessed: 1,
          chunksCreated: 2,
          chunksSkipped: 0,
          errors: [],
        })),
      },
      sources,
    };

    const first = await runCrawlCommand({
      url: "https://example.com/docs",
      name: "docs",
      saveSource: true,
      origin: "agent:test",
    }, runtime as any);
    const second = await runCrawlCommand({
      url: "https://example.com/reference",
      name: "docs",
      saveSource: true,
      origin: "agent:test",
    }, runtime as any);

    expect(first.sourceId).toBeDefined();
    expect(second.sourceId).toBe(first.sourceId);
    expect(sources.getEnabled()).toHaveLength(1);
    expect(sources.getById(first.sourceId!)).toMatchObject({
      name: "docs",
      url: "https://example.com/reference",
      lastStatus: "completed",
      pagesFound: 1,
      chunksCreated: 2,
    });
  });

  it("fails cleanly when crawl runtime is unavailable", async () => {
    await expect(runCrawlCommand({ url: "https://example.com" }, {})).rejects.toThrow("Crawl pipeline not available");
  });
});

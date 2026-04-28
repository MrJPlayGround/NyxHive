import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import {
  CrawlAuthError,
  CrawlQuotaError,
  CrawlRequestError,
  CrawlService,
  CrawlTimeoutError,
} from "../crawl/index.js";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
}

describe("CrawlService", () => {
  let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;

  beforeEach(() => {
    fetchSpy = spyOn(globalThis, "fetch");
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  test("fetchPage accepts plain-text markdown responses", async () => {
    fetchSpy.mockResolvedValue(new Response("# Bun Docs\n\nPlain markdown body", { status: 200 }));

    const service = new CrawlService({
      accountId: "acct",
      apiToken: "token",
    });

    await expect(service.fetchPage("https://bun.sh/docs")).resolves.toBe("# Bun Docs\n\nPlain markdown body");
  });

  test("crawlSite polls until completion and collects paginated results", async () => {
    const responses = [
      jsonResponse({ success: true, result: "job-123" }),
      jsonResponse({ success: true, result: { status: "running" } }),
      jsonResponse({ success: true, result: { status: "completed" } }),
      jsonResponse({
        success: true,
        result: {
          records: [
            { url: "https://example.com/docs/intro", markdown: "## Intro\n" + "A".repeat(120), statusCode: 200 },
          ],
          cursor: "page-2",
        },
      }),
      jsonResponse({
        success: true,
        result: {
          records: [
            { url: "https://example.com/docs/setup", markdown: "## Setup\n" + "B".repeat(120), statusCode: 200 },
          ],
        },
      }),
    ];

    fetchSpy.mockImplementation((async () => responses.shift() ?? new Response("missing mock", { status: 500 })) as unknown as typeof fetch);

    const service = new CrawlService({
      accountId: "acct",
      apiToken: "token",
      pollIntervalMs: 0,
    });

    const results = await service.crawlSite("https://example.com/docs", {
      depth: 3,
      limit: 25,
      pathGlob: "/docs/**",
    });

    expect(results).toEqual([
      { url: "https://example.com/docs/intro", markdown: "## Intro\n" + "A".repeat(120), statusCode: 200 },
      { url: "https://example.com/docs/setup", markdown: "## Setup\n" + "B".repeat(120), statusCode: 200 },
    ]);
    expect(fetchSpy).toHaveBeenCalledTimes(5);
  });

  test("retries transient server failures", async () => {
    fetchSpy
      .mockResolvedValueOnce(new Response("upstream down", { status: 500 }))
      .mockResolvedValueOnce(jsonResponse({ success: true, result: "# Recovered" }));

    const service = new CrawlService({
      accountId: "acct",
      apiToken: "token",
    });

    await expect(service.fetchPage("https://example.com/docs")).resolves.toBe("# Recovered");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  test("raises typed errors for auth and quota failures", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("forbidden", { status: 403 }));

    const service = new CrawlService({
      accountId: "acct",
      apiToken: "token",
    });

    await expect(service.fetchPage("https://example.com/docs")).rejects.toBeInstanceOf(CrawlAuthError);

    fetchSpy.mockReset();
    fetchSpy
      .mockResolvedValueOnce(new Response("slow down", { status: 429 }))
      .mockResolvedValueOnce(new Response("slow down", { status: 429 }))
      .mockResolvedValueOnce(new Response("slow down", { status: 429 }));

    await expect(service.fetchPage("https://example.com/docs/rate-limited")).rejects.toBeInstanceOf(CrawlQuotaError);
  });

  test("times out long-running crawl jobs", async () => {
    fetchSpy.mockImplementation(
      (async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/browser-rendering/crawl")) {
          return jsonResponse({ success: true, result: "job-timeout" });
        }
        return jsonResponse({ success: true, result: { status: "running" } });
      }) as unknown as typeof fetch,
    );

    const service = new CrawlService({
      accountId: "acct",
      apiToken: "token",
      timeoutMs: 5,
      pollIntervalMs: 0,
    });

    await expect(service.crawlSite("https://example.com/docs")).rejects.toBeInstanceOf(CrawlTimeoutError);
  });

  test("rejects invalid urls before making requests", async () => {
    const service = new CrawlService({
      accountId: "acct",
      apiToken: "token",
    });

    await expect(service.fetchPage("definitely-not-a-url")).rejects.toBeInstanceOf(CrawlRequestError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

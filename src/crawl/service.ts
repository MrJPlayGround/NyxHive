import {
  CrawlAuthError,
  type CrawlOptions,
  CrawlQuotaError,
  CrawlRequestError,
  type CrawlResult,
  CrawlTimeoutError,
} from "./types.js";
import { validateCrawlUrl } from "./command.js";

interface CrawlServiceOptions {
  accountId?: string;
  apiToken?: string;
  baseUrl?: string;
  timeoutMs?: number;
  pageTimeoutMs?: number;
  pollIntervalMs?: number;
}

interface CloudflareEnvelope<T> {
  success?: boolean;
  errors?: Array<{ code?: number; message?: string }>;
  result?: T;
}

interface ParsedCloudflareResponse<T> {
  success?: boolean;
  errors?: Array<{ code?: number; message?: string }>;
  result: T;
}

interface CrawlStatusResponse {
  id?: string;
  status?: string;
  cursor?: string | null;
  records?: unknown[];
  results?: unknown[];
}

const TERMINAL_STATUSES = new Set([
  "completed",
  "errored",
  "cancelled_due_to_timeout",
  "cancelled_due_to_limits",
  "cancelled_by_user",
]);

export class CrawlService {
  private readonly accountId: string;
  private readonly apiToken: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly pageTimeoutMs: number;
  private readonly pollIntervalMs: number;

  constructor(options: CrawlServiceOptions = {}) {
    this.accountId = options.accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID ?? "";
    this.apiToken = options.apiToken ?? process.env.CLOUDFLARE_API_TOKEN ?? "";
    if (!this.accountId || !this.apiToken) {
      throw new CrawlAuthError("Missing CLOUDFLARE_ACCOUNT_ID or CLOUDFLARE_API_TOKEN");
    }

    this.baseUrl = options.baseUrl ?? "https://api.cloudflare.com/client/v4/accounts";
    this.timeoutMs = options.timeoutMs ?? 300_000;
    this.pageTimeoutMs = options.pageTimeoutMs ?? 30_000;
    this.pollIntervalMs = options.pollIntervalMs ?? 2_000;
  }

  async fetchPage(url: string): Promise<string> {
    validateUrl(url);
    const response = await this.request<string>("/browser-rendering/markdown", {
      method: "POST",
      body: JSON.stringify({ url }),
      timeoutMs: this.pageTimeoutMs,
    });

    if (typeof response !== "string") {
      throw new CrawlRequestError(`Unexpected markdown response for ${url}`);
    }

    return response;
  }

  async crawlSite(url: string, options: CrawlOptions = {}): Promise<CrawlResult[]> {
    validateUrl(url);

    const jobId = await this.request<string>("/browser-rendering/crawl", {
      method: "POST",
      body: JSON.stringify(buildCrawlRequest(url, options)),
      timeoutMs: this.pageTimeoutMs,
    });

    if (!jobId) {
      throw new CrawlRequestError(`Cloudflare did not return a crawl job id for ${url}`);
    }

    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      const status = await this.request<CrawlStatusResponse>(`/browser-rendering/crawl/${jobId}`, {
        timeoutMs: this.pageTimeoutMs,
      });

      const state = status?.status ?? "unknown";
      if (!TERMINAL_STATUSES.has(state)) {
        await sleep(this.pollIntervalMs);
        continue;
      }

      if (state === "completed") {
        return this.collectResults(jobId);
      }

      if (state === "cancelled_due_to_limits") {
        throw new CrawlQuotaError(`Cloudflare crawl hit account limits for ${url}`);
      }

      if (state === "cancelled_due_to_timeout") {
        throw new CrawlTimeoutError(`Cloudflare crawl timed out for ${url}`);
      }

      throw new CrawlRequestError(`Cloudflare crawl ${jobId} ended with status '${state}'`);
    }

    throw new CrawlTimeoutError(`Cloudflare crawl exceeded ${this.timeoutMs}ms for ${url}`);
  }

  private async collectResults(jobId: string): Promise<CrawlResult[]> {
    const results: CrawlResult[] = [];
    let cursor: string | undefined;

    do {
      const query = new URLSearchParams({ status: "completed" });
      if (cursor) query.set("cursor", cursor);
      const page = await this.request<CrawlStatusResponse>(
        `/browser-rendering/crawl/${jobId}?${query.toString()}`,
        { timeoutMs: this.pageTimeoutMs },
      );

      const records = Array.isArray(page?.records)
        ? page.records
        : Array.isArray(page?.results)
          ? page.results
          : [];

      for (const record of records) {
        const normalized = normalizeCrawlRecord(record);
        if (normalized) results.push(normalized);
      }

      cursor = typeof page?.cursor === "string" && page.cursor.length > 0 ? page.cursor : undefined;
    } while (cursor);

    return results;
  }

  private async request<T>(
    path: string,
    init: {
      method?: string;
      body?: string;
      timeoutMs?: number;
    } = {},
  ): Promise<T> {
    const url = `${this.baseUrl}/${this.accountId}${path}`;
    let lastError: unknown;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetch(url, {
          method: init.method ?? "GET",
          headers: {
            Authorization: `Bearer ${this.apiToken}`,
            "Content-Type": "application/json",
          },
          body: init.body,
          signal: AbortSignal.timeout(init.timeoutMs ?? this.pageTimeoutMs),
        });

        if (response.status === 401 || response.status === 403) {
          throw new CrawlAuthError(`Cloudflare returned ${response.status}`);
        }

        if (response.status === 429) {
          if (attempt < 2) {
            await sleep(2 ** attempt * 1000);
            continue;
          }
          throw new CrawlQuotaError("Cloudflare crawl rate limit exceeded");
        }

        if (response.status >= 500) {
          if (attempt < 2) {
            await sleep(2 ** attempt * 1000);
            continue;
          }
          throw new CrawlRequestError(`Cloudflare returned ${response.status}`);
        }

        const payload = await parseCloudflareResponse<T>(response);
        const errorMessage = payload.errors?.map((error) => error.message).filter(Boolean).join("; ");

        if (!response.ok || payload.success === false) {
          if (response.status === 400) {
            throw new CrawlRequestError(errorMessage || "Invalid crawl request");
          }
          if (response.status === 429) {
            throw new CrawlQuotaError(errorMessage || "Cloudflare crawl rate limit exceeded");
          }
          throw new CrawlRequestError(errorMessage || `Cloudflare request failed with ${response.status}`);
        }

        return payload.result;
      } catch (error) {
        lastError = error;
        if (error instanceof CrawlAuthError || error instanceof CrawlQuotaError || error instanceof CrawlRequestError) {
          throw error;
        }
        if (error instanceof DOMException && error.name === "TimeoutError") {
          throw new CrawlTimeoutError(`Cloudflare request to ${path} timed out`);
        }
        if (attempt < 2) {
          await sleep(2 ** attempt * 1000);
        }
      }
    }

    throw lastError instanceof Error ? lastError : new CrawlRequestError("Cloudflare crawl request failed");
  }
}

function buildCrawlRequest(url: string, options: CrawlOptions): Record<string, unknown> {
  const includePattern = normalizePathGlob(url, options.pathGlob);
  const modifiedSince = normalizeModifiedSince(options.modifiedSince);
  const request: Record<string, unknown> = {
    url,
    depth: options.depth ?? 2,
    limit: options.limit ?? 50,
    render: true,
    formats: ["markdown"],
  };

  if (modifiedSince !== undefined) {
    request.modifiedSince = modifiedSince;
  }

  if (includePattern) {
    request.options = { includePatterns: [includePattern] };
  }

  return request;
}

function normalizeModifiedSince(value: CrawlOptions["modifiedSince"]): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number") {
    return value > 1_000_000_000_000 ? Math.floor(value / 1000) : Math.floor(value);
  }
  if (value instanceof Date) {
    return Math.floor(value.getTime() / 1000);
  }

  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return undefined;
  return Math.floor(parsed / 1000);
}

function normalizePathGlob(baseUrl: string, pathGlob?: string): string | undefined {
  if (!pathGlob) return undefined;
  if (pathGlob.startsWith("http://") || pathGlob.startsWith("https://")) {
    return pathGlob;
  }

  const root = new URL(baseUrl);
  const normalizedPath = pathGlob.startsWith("/") ? pathGlob : `/${pathGlob}`;
  return `${root.origin}${normalizedPath}`;
}

function normalizeCrawlRecord(record: unknown): CrawlResult | null {
  if (!record || typeof record !== "object") return null;
  const candidate = record as Record<string, unknown>;

  const url = firstString(candidate.url, candidate.finalUrl, getNested(candidate, "request.url"));
  const markdown = firstString(
    candidate.markdown,
    getNested(candidate, "content.markdown"),
    getNested(candidate, "response.markdown"),
    getNested(candidate, "result.markdown"),
  );
  const statusCode = firstNumber(
    candidate.statusCode,
    candidate.status_code,
    getNested(candidate, "response.statusCode"),
    getNested(candidate, "response.status"),
  ) ?? (markdown ? 200 : undefined);

  if (!url || !markdown || !statusCode) {
    return null;
  }

  return { url, markdown, statusCode };
}

function validateUrl(url: string): void {
  const error = validateCrawlUrl(url);
  if (error) {
    throw new CrawlRequestError(error);
  }
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
}

function getNested(obj: Record<string, unknown>, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => {
    if (!current || typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[key];
  }, obj);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function parseCloudflareResponse<T>(response: Response): Promise<ParsedCloudflareResponse<T>> {
  const text = await response.text();
  if (!text) {
    return { result: undefined as T };
  }

  try {
    const parsed = JSON.parse(text) as unknown;
    if (isEnvelope(parsed)) {
      return {
        success: parsed.success,
        errors: parsed.errors,
        result: parsed.result as T,
      };
    }
    return { result: parsed as T };
  } catch {
    return { result: text as T };
  }
}

function isEnvelope(value: unknown): value is CloudflareEnvelope<unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return "result" in value || "success" in value || "errors" in value;
}

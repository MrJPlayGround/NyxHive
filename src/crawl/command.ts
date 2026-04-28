import type { CrawlIngestBridge } from "./ingest-bridge.js";
import type { CrawlService } from "./service.js";
import type { CrawlSourceStore } from "./sources.js";
import type { CrawlSource } from "./types.js";

export interface CrawlCommandInput {
  url: string;
  name?: string;
  depth?: number;
  limit?: number;
  scope?: string;
  pathGlob?: string;
  saveSource?: boolean;
  schedule?: string;
  origin?: string;
}

export interface CrawlCommandRuntime {
  service?: CrawlService;
  sources?: CrawlSourceStore;
  ingest?: CrawlIngestBridge;
}

export interface CrawlCommandResult {
  sourceId?: string;
  sourceName: string;
  pagesCrawled: number;
  pagesIngested: number;
  chunksCreated: number;
  chunksSkipped: number;
  errors: string[];
}

export type ParsedCrawlCommand =
  | { ok: true; input: CrawlCommandInput }
  | { ok: false; error: string };

const DEFAULT_SCHEDULE = "0 3 * * 0";

/**
 * Validates a URL is safe for crawling: http(s) only, no localhost/private IPs.
 * Returns null if valid, or an error message string if invalid.
 */
export function validateCrawlUrl(raw: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return `Invalid URL: ${raw}`;
  }

  const scheme = parsed.protocol.toLowerCase();
  if (scheme !== "http:" && scheme !== "https:") {
    return `Unsupported scheme "${scheme.replace(":", "")}". Only http and https are allowed.`;
  }

  const hostname = parsed.hostname.toLowerCase();
  if (isBlockedHost(hostname)) {
    return `Blocked destination: ${hostname}. Crawling localhost and private network addresses is not allowed.`;
  }

  return null;
}

const LOCALHOST_NAMES = new Set(["localhost", "127.0.0.1", "::1", "0.0.0.0", "[::1]"]);

function isBlockedHost(hostname: string): boolean {
  if (LOCALHOST_NAMES.has(hostname)) return true;

  // Strip IPv6 brackets if present
  const bare = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;

  // Check IPv4 private ranges
  const ipv4Match = bare.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const [, a, b] = ipv4Match.map(Number) as [number, number, number, number, number];
    if (a === 10) return true;                          // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true;   // 172.16.0.0/12
    if (a === 192 && b === 168) return true;             // 192.168.0.0/16
    if (a === 169 && b === 254) return true;             // 169.254.0.0/16 (link-local)
    if (a === 127) return true;                          // 127.0.0.0/8
    if (a === 0) return true;                            // 0.0.0.0/8
  }

  return false;
}

export function isCrawlCommand(text: string): boolean {
  const command = text.trim().split(/\s+/, 1)[0]?.toLowerCase();
  return command === "/crawl" || command === "!crawl";
}

export function buildCrawlUsage(prefix = "/crawl"): string {
  return `Usage: ${prefix} <url> [--save] [--name <name>] [--scope <scope>] [--depth <n>] [--limit <n>] [--glob <pattern>] [--schedule "<cron>"]`;
}

export function parseCrawlCommandText(text: string, prefix = "/crawl"): ParsedCrawlCommand {
  const tokens = tokenizeCommand(text);
  if (tokens.length === 0) {
    return { ok: false, error: buildCrawlUsage(prefix) };
  }

  tokens.shift();
  if (tokens.length === 0) {
    return { ok: false, error: buildCrawlUsage(prefix) };
  }

  let url: string | undefined;
  const input: CrawlCommandInput = { url: "" };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (!url && !token.startsWith("-") && !token.includes("=")) {
      url = token;
      continue;
    }

    if (token === "--save" || token === "save") {
      input.saveSource = true;
      continue;
    }

    const inline = parseInlineOption(token);
    if (inline) {
      const applied = applyOption(input, inline.key, inline.value);
      if (applied) continue;
      return { ok: false, error: `Unknown crawl option: ${inline.key}\n${buildCrawlUsage(prefix)}` };
    }

    if (!token.startsWith("--")) {
      return { ok: false, error: `Unexpected crawl argument: ${token}\n${buildCrawlUsage(prefix)}` };
    }

    const key = token.slice(2);
    const next = tokens[i + 1];
    if (next === undefined || next.startsWith("--")) {
      return { ok: false, error: `Missing value for --${key}\n${buildCrawlUsage(prefix)}` };
    }
    i += 1;
    const applied = applyOption(input, key, next);
    if (!applied) {
      return { ok: false, error: `Unknown crawl option: ${key}\n${buildCrawlUsage(prefix)}` };
    }
  }

  if (!url) {
    return { ok: false, error: buildCrawlUsage(prefix) };
  }

  const urlError = validateCrawlUrl(url);
  if (urlError) {
    return { ok: false, error: urlError };
  }
  input.url = new URL(url).toString();

  if (input.depth !== undefined && (!Number.isInteger(input.depth) || input.depth < 1 || input.depth > 10)) {
    return { ok: false, error: "Depth must be an integer between 1 and 10." };
  }
  if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 500)) {
    return { ok: false, error: "Limit must be an integer between 1 and 500." };
  }

  return { ok: true, input };
}

export async function runCrawlCommand(
  input: CrawlCommandInput,
  runtime: CrawlCommandRuntime,
): Promise<CrawlCommandResult> {
  if (!runtime.service || !runtime.ingest) {
    throw new Error("Crawl pipeline not available on this instance. Add CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN to the instance environment.");
  }

  const results = await runtime.service.crawlSite(input.url, {
    depth: input.depth,
    limit: input.limit,
    pathGlob: input.pathGlob,
  });

  const sourceName = input.name ?? deriveCrawlSourceName(input.url);
  const source: CrawlSource = {
    id: "adhoc",
    name: sourceName,
    url: input.url,
    schedule: input.schedule ?? DEFAULT_SCHEDULE,
    depth: input.depth ?? 2,
    pageLimit: input.limit ?? 50,
    pathGlob: input.pathGlob ?? null,
    scope: input.scope ?? "general",
    enabled: true,
    lastCrawlAt: null,
    lastStatus: null,
    lastError: null,
    pagesFound: 0,
    chunksCreated: 0,
    origin: input.origin ?? "command",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  const stats = await runtime.ingest.ingestCrawlResults(results, source);

  let sourceId: string | undefined;
  if (input.saveSource) {
    if (!runtime.sources) {
      throw new Error("Crawl source store not available on this instance.");
    }
    const savedSource = {
      name: sourceName,
      url: input.url,
      schedule: input.schedule ?? DEFAULT_SCHEDULE,
      depth: input.depth ?? 2,
      pageLimit: input.limit ?? 50,
      pathGlob: input.pathGlob ?? null,
      scope: input.scope ?? "general",
      enabled: true,
      origin: input.origin ?? "command",
    };
    sourceId = runtime.sources.addDynamic(savedSource);
    runtime.sources.updateAfterCrawl(sourceId, "completed", {
      pagesFound: results.length,
      chunksCreated: stats.chunksCreated,
    });
  }

  return {
    sourceId,
    sourceName,
    pagesCrawled: results.length,
    pagesIngested: stats.pagesProcessed,
    chunksCreated: stats.chunksCreated,
    chunksSkipped: stats.chunksSkipped,
    errors: stats.errors,
  };
}

export function formatCrawlCommandResult(result: CrawlCommandResult): string {
  const lines = [
    `Crawled ${result.pagesCrawled} page(s); ingested ${result.pagesIngested}; created ${result.chunksCreated} chunk(s); skipped ${result.chunksSkipped}.`,
  ];

  if (result.sourceId) {
    lines.push(`Saved recurring source "${result.sourceName}" (${result.sourceId}).`);
  }
  if (result.errors.length > 0) {
    lines.push(`Errors: ${result.errors.join(" | ")}`);
  }

  return lines.join("\n");
}

export function deriveCrawlSourceName(url: string): string {
  const parsed = new URL(url);
  const path = parsed.pathname
    .replace(/\/+$/g, "")
    .replace(/^\//, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return path ? `${parsed.hostname}-${path}` : parsed.hostname.replace(/[^a-zA-Z0-9]+/g, "-");
}

function applyOption(input: CrawlCommandInput, key: string, rawValue: string): boolean {
  switch (key) {
    case "name":
      input.name = rawValue;
      return true;
    case "scope":
      input.scope = rawValue;
      return true;
    case "depth":
      input.depth = parseInteger(rawValue);
      return true;
    case "limit":
      input.limit = parseInteger(rawValue);
      return true;
    case "glob":
    case "path-glob":
    case "path_glob":
      input.pathGlob = rawValue;
      return true;
    case "schedule":
      input.schedule = rawValue;
      return true;
    case "save":
      input.saveSource = rawValue !== "false";
      return true;
    default:
      return false;
  }
}

function parseInlineOption(token: string): { key: string; value: string } | null {
  const eq = token.indexOf("=");
  if (eq <= 0) return null;
  const key = token.slice(0, eq).replace(/^--/, "");
  const value = token.slice(eq + 1);
  return key ? { key, value } : null;
}

function parseInteger(value: string): number {
  return Number.parseInt(value, 10);
}

function tokenizeCommand(text: string): string[] {
  const tokens: string[] = [];
  const regex = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3] ?? "");
  }
  return tokens;
}

export interface CrawlOptions {
  depth?: number;
  limit?: number;
  pathGlob?: string;
  modifiedSince?: string | number | Date;
}

export interface CrawlResult {
  url: string;
  markdown: string;
  statusCode: number;
}

export interface CrawlSource {
  id: string;
  name: string;
  url: string;
  schedule: string;
  depth: number;
  pageLimit: number;
  pathGlob: string | null;
  scope: string;
  enabled: boolean;
  lastCrawlAt: number | null;
  lastStatus: string | null;
  lastError: string | null;
  pagesFound: number;
  chunksCreated: number;
  origin: string;
  createdAt: number;
  updatedAt: number;
}

export interface CrawlConfigSource {
  name: string;
  url: string;
  schedule: string;
  depth?: number;
  page_limit?: number;
  path_glob?: string;
  scope?: string;
  enabled?: boolean;
}

export interface CrawlSourceInput {
  name: string;
  url: string;
  schedule: string;
  depth?: number;
  pageLimit?: number;
  pathGlob?: string | null;
  scope?: string;
  enabled?: boolean;
  origin: string;
}

export interface CrawlIngestStats {
  pagesProcessed: number;
  chunksCreated: number;
  chunksSkipped: number;
  errors: string[];
}

export interface CrawlConfig {
  enabled?: boolean;
  default_depth?: number;
  default_page_limit?: number;
  timeout_ms?: number;
  sources?: CrawlConfigSource[];
}

export class CrawlAuthError extends Error {
  constructor(message = "Cloudflare crawl authentication failed") {
    super(message);
    this.name = "CrawlAuthError";
  }
}

export class CrawlQuotaError extends Error {
  constructor(message = "Cloudflare crawl quota exceeded") {
    super(message);
    this.name = "CrawlQuotaError";
  }
}

export class CrawlTimeoutError extends Error {
  constructor(message = "Cloudflare crawl timed out") {
    super(message);
    this.name = "CrawlTimeoutError";
  }
}

export class CrawlRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CrawlRequestError";
  }
}

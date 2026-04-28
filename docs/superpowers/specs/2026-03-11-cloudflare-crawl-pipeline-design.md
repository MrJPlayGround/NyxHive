# Cloudflare Crawl Pipeline — Design Spec

**Date:** 2026-03-11
**Status:** Draft
**Author:** Nyx

## Problem

NyxHive has no way to fetch and ingest web content. Agents can discover URLs (via Brave Search, GitHub webhooks) but can't read them. Knowledge building requires manual Obsidian vault updates.

Cloudflare just shipped Browser Rendering `/crawl` and `/markdown` endpoints — async website crawling via API. This gives us structured web content ingestion without running headless browsers.

## Solution

A `src/crawl/` module that wraps Cloudflare's Browser Rendering API and pipes results into the existing knowledge ingestion pipeline. Available to agents as MCP tools and to the scheduler as system tasks.

## Architecture

### Approach: CrawlService + KnowledgeIngestion bridge

Three concerns, cleanly separated:

1. **CrawlService** — stateless Cloudflare API client
2. **Ingestion Bridge** — connects crawl output to existing chunking + embedding pipeline
3. **Source Manager** — SQLite-backed registry of what to crawl and when

```
┌─────────────┐     ┌──────────────┐     ┌──────────────────┐
│ MCP Tools   │────>│ CrawlService │────>│ Ingestion Bridge  │
│ crawl_page  │     │ fetchPage()  │     │ crawl → markdown  │
│ crawl_site  │     │ crawlSite()  │     │ → chunk + embed   │
└─────────────┘     └──────────────┘     └────────┬─────────┘
                                                   │
┌─────────────┐     ┌──────────────┐               v
│ Scheduler   │────>│ Source Mgr   │     ┌──────────────────┐
│ system tasks│     │ CrawlSource  │     │ Knowledge Store   │
│ crawl:run   │     │ Store (SQL)  │     │ (existing)        │
└─────────────┘     └──────────────┘     └──────────────────┘
```

### Why not extend the knowledge module?

Crawl concerns (HTTP API, async job polling, source tracking) are fundamentally different from knowledge concerns (embeddings, search, retention). Separating them means we can swap Cloudflare for another crawler later without touching knowledge code.

## Components

### 1. CrawlService (`src/crawl/service.ts`)

Stateless Cloudflare API client. Two methods:

**`fetchPage(url: string): Promise<string>`**
- Calls `POST /accounts/{id}/browser-rendering/markdown` with the URL
- Returns markdown string
- For agents mid-conversation — fast, synchronous
- Timeout: 30s

**`crawlSite(url: string, options?: CrawlOptions): Promise<CrawlResult[]>`**
- Calls `POST /accounts/{id}/browser-rendering/crawl` with URL and options
- Polls `GET .../crawl/{jobId}` internally until complete
- Returns array of `{ url, markdown, statusCode }`
- Options: `depth` (default 2), `limit` (default 50), `pathGlob`, `modifiedSince`
- Timeout: configurable, default 5 min
- Callers get a simple async call — no job management exposed

**Error handling:**
- 3 retries on 429/5xx with exponential backoff (1s, 2s, 4s)
- Typed errors: `CrawlAuthError`, `CrawlQuotaError`, `CrawlTimeoutError`
- Non-retryable: 400, 401, 403

**Credentials:**
- `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` from instance env
- Validated at CrawlService construction — throws if missing

### 2. Source Manager (`src/crawl/sources.ts`)

SQLite-backed registry of crawl targets.

**Table: `crawl_sources`**

| Column | Type | Description |
|--------|------|-------------|
| id | TEXT PK | UUID |
| name | TEXT UNIQUE | Human label ("bun-docs") |
| url | TEXT | Root URL to crawl |
| schedule | TEXT | Cron expression |
| depth | INTEGER | Max crawl depth (default 2) |
| page_limit | INTEGER | Max pages per crawl (default 50) |
| path_glob | TEXT | URL pattern filter (optional) |
| scope | TEXT | Knowledge scope tag ("reference", "competitor") |
| enabled | INTEGER | 1/0 |
| last_crawl_at | INTEGER | Unix timestamp of last successful crawl |
| last_status | TEXT | "completed" / "failed" |
| last_error | TEXT | Error message if failed |
| pages_found | INTEGER | Pages from last crawl |
| chunks_created | INTEGER | Knowledge chunks from last crawl |
| origin | TEXT | "config" or "proposal:\<id\>" |
| created_at | INTEGER | |
| updated_at | INTEGER | |

**Two source types:**

1. **Config sources** — from `config.toml` `[[crawl.sources]]`. Synced at startup. `origin: "config"`. Cannot be deleted at runtime (only disabled).
2. **Dynamic sources** — created via proposals or agent `crawl_site` calls. `origin: "proposal:<id>"` or `origin: "agent:<name>"`. Can be deleted.

**API:**
- `upsertFromConfig(sources: ConfigCrawlSource[]): void` — sync config sources at startup
- `getEnabled(): CrawlSource[]` — all enabled sources
- `getDue(): CrawlSource[]` — evaluates each source's cron expression against `last_crawl_at` to determine if it should run. This is independent of the scheduler's 4h tick — individual sources have their own schedules (e.g., weekly, daily). The scheduler tick just checks which sources are due.
- `updateAfterCrawl(id, status, stats): void` — update last_crawl_at, pages_found, etc.
- `addDynamic(source): string` — add a proposal/agent-created source
- `remove(id): void` — remove dynamic source (throws if config origin)

### 3. Ingestion Bridge (`src/crawl/ingest-bridge.ts`)

Connects crawl results to the existing knowledge pipeline. Calls `chunkMarkdown()` and `KnowledgeStore.upsertChunk()` directly — does NOT use `ingestFile()`.

**Why not `ingestFile()`?** Two reasons:
1. `ingestFile()` doesn't pass `scope` through to `upsertChunk()` — crawled chunks would all land as `scope: 'global'`
2. `ingestFile()` requires a `vaultPath` for relative path computation — temp files would produce nonsense `source_path` values like `../../tmp/crawl-abc.md` instead of the actual URL

By calling `chunkMarkdown()` + `upsertChunk()` directly, we get full control over `sourcePath` (set to the URL) and `scope` (set from the crawl source config), while still reusing the existing chunking, embedding, and content-hash dedup logic.

**`ingestCrawlResults(results: CrawlResult[], source: CrawlSource): Promise<IngestStats>`**

1. Filters out non-200 pages
2. For each page:
   - Prepends synthetic frontmatter (source, url, scope, crawl_source, crawled_at)
   - Calls `chunkMarkdown(content, url)` to split into sections
   - Generates embeddings in batches (reuses existing embedder)
   - Calls `store.upsertChunk()` for each chunk with:
     - `sourcePath`: the page URL (e.g., `https://docs.bun.sh/api/fetch`)
     - `scope`: from crawl source config (e.g., `"reference"`)
     - `contentHash`: SHA256 of chunk content (existing dedup)
3. Returns `{ pagesProcessed, chunksCreated, chunksSkipped, errors: string[] }`

**Scope tagging:** Each source has a `scope` field. Maps to knowledge store's `scope` column. Agents can search within scope: "search reference docs for X."

**Dedup:** Content-hash based via `upsertChunk()`. Same URL, same content = no-op. Changed content = updated chunk.

### 4. Scheduler Integration

Two new system tasks in `src/scheduler/bootstrap.ts`:

**`crawl:run-sources`** (every 4 hours)
- Gets due sources from SourceManager
- For each: calls CrawlService.crawlSite() with source config
- Passes `modifiedSince: source.last_crawl_at` for incremental crawls
- Pipes results through IngestBridge
- Updates source stats
- Logs results to scheduler task history
- Concurrent limit: 1 crawl at a time (sequential) to respect Cloudflare rate limits

**`crawl:cleanup-stale`** (weekly, runs with `memory:maintenance`)
- Removes knowledge chunks where `source_path` matches crawl sources that have been disabled or deleted
- Chunks from active sources follow normal knowledge retention tiers (critical/active/archive/stale)

### 5. MCP Tools

Two tools in `src/mcp/`:

**`crawl_page`**
- Input: `{ url: string }`
- Output: markdown string
- Calls `CrawlService.fetchPage(url)`
- Use case: agent reads a single page mid-conversation

**`crawl_site`**
- Input: `{ url: string, name?: string, depth?: number, limit?: number, scope?: string, save_source?: boolean }`
- Output: `{ pages_ingested: number, chunks_created: number, source_id?: string }`
- Calls `CrawlService.crawlSite()` → `IngestBridge.ingestCrawlResults()`
- If `save_source: true`, adds to SourceManager as dynamic source for recurring crawls
- Use case: agent wants to ingest a site and optionally set up recurring crawls
- **Latency note:** crawlSite is async and can take up to 5 minutes for large sites. Agents using this tool mid-conversation will block until complete. Best used for small/focused crawls during conversation; large site ingestion should go through scheduled sources.

### 6. Config Schema

New `[crawl]` section in `config.toml`:

```toml
[crawl]
enabled = true
default_depth = 2
default_page_limit = 50
timeout_ms = 300000

[[crawl.sources]]
name = "bun-docs"
url = "https://bun.sh/docs"
schedule = "0 3 * * 0"
depth = 2
scope = "reference"

[[crawl.sources]]
name = "cloudflare-workers"
url = "https://developers.cloudflare.com/workers"
schedule = "0 3 * * 0"
depth = 2
path_glob = "/workers/**"
scope = "reference"
```

**Zod schema** (in `config-schema.ts`):

```typescript
crawl: z.object({
  enabled: z.boolean().default(false),
  default_depth: z.number().default(2),
  default_page_limit: z.number().default(50),
  timeout_ms: z.number().default(300000),
  sources: z.array(z.object({
    name: z.string(),
    url: z.string().url(),
    schedule: z.string(),
    depth: z.number().optional(),
    page_limit: z.number().optional(),
    path_glob: z.string().optional(),
    scope: z.string().default("general"),
    enabled: z.boolean().default(true),
  })).default([]),
}).optional(),
```

**Credentials:** `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` from instance env files. Already configured for both NyxAI and Acme instances.

### 7. File Structure

```
src/crawl/
  service.ts          # Cloudflare API client
  sources.ts          # SQLite source manager
  ingest-bridge.ts    # Crawl results → knowledge pipeline
  types.ts            # Interfaces
  index.ts            # Barrel export
```

**Types (`src/crawl/types.ts`):**
```typescript
interface CrawlOptions {
  depth?: number;
  limit?: number;
  pathGlob?: string;
  modifiedSince?: string; // ISO date
}

interface CrawlResult {
  url: string;
  markdown: string;
  statusCode: number;
}

interface CrawlSource {
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

interface IngestStats {
  pagesProcessed: number;
  chunksCreated: number;
  chunksSkipped: number;
  errors: string[];
}

// Errors
class CrawlAuthError extends Error {}
class CrawlQuotaError extends Error {}
class CrawlTimeoutError extends Error {}
```

**Modified existing files:**
- `src/config-schema.ts` — add `crawl` Zod schema
- `src/types.ts` — add `CrawlConfig` type
- `src/scheduler/bootstrap.ts` — add `crawl:run-sources` and `crawl:cleanup-stale` task definitions
- `src/scheduler/index.ts` — add `executeSystemTask` switch cases for `crawl:run-sources` and `crawl:cleanup-stale`
- `src/mcp/index.ts` — register `crawl_page` and `crawl_site` tools
- `src/index.ts` — instantiate CrawlService + CrawlSourceStore, pass to scheduler and MCP

## Instance Isolation

- Credentials per instance (env files) — already done
- Config sources per instance (each instance's `config.toml`)
- Dynamic sources per instance (each instance's SQLite DB)
- Knowledge chunks per instance (each instance's knowledge store)
- No shared state between instances

## Data Migration

The `crawl_sources` table holds user-configured data (dynamic sources from proposals). Uses `ensureTableSchema` pattern (persistent, with column migration support) — NOT the drop/recreate pattern used for ephemeral scheduler task tables.

## Testing Strategy

**Test files:**
- `src/__tests__/crawl-service.test.ts` — CrawlService with mocked `fetch` (spyOn globalThis.fetch). Tests: fetchPage success/error, crawlSite polling loop, retry on 429/5xx, timeout, auth error, quota error.
- `src/__tests__/crawl-sources.test.ts` — CrawlSourceStore with in-memory SQLite. Tests: upsertFromConfig, getDue cron evaluation, addDynamic, remove (config vs dynamic), updateAfterCrawl stats.
- `src/__tests__/crawl-ingest-bridge.test.ts` — IngestBridge with mocked KnowledgeStore and embedder. Tests: page filtering, chunking, scope/sourcePath passthrough, content-hash dedup, error accumulation.
- `src/__tests__/crawl-integration.test.ts` — End-to-end: config → source manager → mock Cloudflare response → ingestion bridge → verify knowledge chunks exist in SQLite with correct scope and sourcePath.

**No live Cloudflare calls in tests** — mock all HTTP via `spyOn(globalThis, "fetch")`. Remember `mockRestore()` in `afterEach`.

## Non-Goals (v1)

- No UI for managing crawl sources (API/config only)
- No crawl result caching (knowledge store handles dedup)
- No priority queue for crawl jobs (sequential is fine for v1)
- No multi-account Cloudflare support
- No robots.txt client-side checking (Cloudflare handles this)
- No cross-instance rate limit coordination (both instances share one Cloudflare account — low risk for v1 given sequential crawling and typical source counts)

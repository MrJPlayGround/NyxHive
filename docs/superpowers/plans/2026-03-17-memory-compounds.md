# Memory Compounds — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the memory compounding loop — upgrade vault search to semantic, add media ingestion pipeline, enforce prose-as-title convention, and surface knowledge health metrics.

**Architecture:** Four independent workstreams that each improve a layer of the memory stack. The VaultWatcher→KnowledgeStore bridge already exists (`create-hive.ts:479-506`), so vault notes are already auto-ingested. We build on top of this foundation.

**Tech Stack:** TypeScript, Bun, SQLite, OpenRouter embeddings, Whisper (via local binary or API), Hono routes

**Merge note:** Tasks 1, 2, 3, 4, and 7 all modify `server.ts`. Implement on the same branch sequentially to avoid merge conflicts.

**Required imports for server.ts** (add early — multiple tasks need them):
```typescript
import { ingestFile } from "../memory/ingest.js";
import { downloadAudio, transcribeAudio } from "../memory/transcribe.js";
import { extractKnowledge, buildExtractionNote } from "../memory/media-extract.js";
```

---

## Revised Gap Analysis

| Gap | Status | What Exists | What's Missing |
|-----|--------|-------------|----------------|
| VaultWatcher → Knowledge Store | DONE | `create-hive.ts:479-506` — watcher calls `ingestFile()` on change | Nothing — already wired |
| search_obsidian is keyword-only | GAP | Substring match on title+content (`server.ts:596-599`) | No semantic search; `search_knowledge` has embeddings but different UX |
| write_obsidian_note → immediate ingest | GAP | Watcher picks it up after 2s debounce | No immediate embedding on write |
| Brain-ingest pipeline | GAP | Nothing | No path from media → vault note |
| Prose-as-title convention | GAP | `buildObsidianNote()` accepts whatever title is passed | No title refinement or guidance |
| Knowledge health metrics | GAP | `getStats()` exists on KnowledgeStore | Not exposed via MCP tool |

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/mcp/server.ts` | Modify | Upgrade `search_obsidian` to hybrid, add `knowledge_health` tool, add `ingest_media` tool, wire immediate ingest on note write |
| `src/memory/ingest.ts` | Modify | Add `ingestMediaToVault()` function |
| `src/memory/obsidian.ts` | Modify | Add `refineTitleAsClaim()` helper for prose-as-title |
| `src/memory/transcribe.ts` | Create | Whisper transcription wrapper |
| `src/memory/media-extract.ts` | Create | LLM-based structured extraction from transcripts |
| `src/__tests__/search-obsidian-hybrid.test.ts` | Create | Tests for hybrid vault search |
| `src/__tests__/prose-title.test.ts` | Create | Tests for title refinement |
| `src/__tests__/media-extract.test.ts` | Create | Tests for structured extraction |
| `src/__tests__/transcribe.test.ts` | Create | Tests for transcription wrapper |
| `src/__tests__/knowledge-health.test.ts` | Create | Tests for health MCP tool |

---

## Task 1: Upgrade `search_obsidian` to Hybrid Search

**Why:** Currently keyword-only (substring match). If a note is titled "Exponential backoff beats fixed intervals" and an agent searches "retry patterns", it misses. Semantic search via the knowledge store would find it because the embeddings capture meaning, not just keywords.

**Approach:** When both `knowledge` store and `embedder` are available, run semantic search over knowledge chunks filtered to vault source paths, then merge with keyword matches. When embeddings are unavailable, fall back to current keyword-only behavior.

**Files:**
- Modify: `src/mcp/server.ts:581-618`
- Create: `src/__tests__/search-obsidian-hybrid.test.ts`

- [ ] **Step 1: Write failing test for hybrid search**

```typescript
// src/__tests__/search-obsidian-hybrid.test.ts
import { describe, it, expect } from "bun:test";

// We test the hybrid logic by checking that semantic results appear
// alongside keyword results. We'll extract the search logic into a
// testable function.

describe("search_obsidian hybrid", () => {
  it("returns keyword matches when no embedder available", () => {
    // Test current behavior: substring match on title + content
  });

  it("returns semantic matches alongside keyword matches", () => {
    // Test: a query that wouldn't match keyword but would match semantically
    // should appear in results when embedder is available
  });

  it("deduplicates results that appear in both keyword and semantic", () => {
    // Same note shouldn't appear twice
  });

  it("ranks semantic matches by similarity score", () => {
    // Higher similarity = higher in results
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/search-obsidian-hybrid.test.ts`
Expected: FAIL — functions not implemented yet

- [ ] **Step 3: Extract search logic into testable function**

In `src/mcp/server.ts`, extract the inline search logic into a function that can be imported and tested:

```typescript
// Add near top of file or in a separate helper
export interface HybridSearchDeps {
  vaultPath: string;
  knowledge?: KnowledgeStore;
  embedder?: EmbeddingProvider;
}

export interface VaultSearchResult {
  title: string;
  path: string;
  category: string;
  snippet: string;
  score?: number; // semantic similarity (if available)
  match_type: "keyword" | "semantic" | "both";
}

export async function searchObsidianHybrid(
  query: string,
  deps: HybridSearchDeps,
  options?: { limit?: number; category?: string },
): Promise<VaultSearchResult[]> {
  const limit = options?.limit ?? 10;
  const files = listVaultFiles({ path: deps.vaultPath });
  const q = query.toLowerCase();

  // Keyword matches (existing behavior)
  let keywordMatches = files.filter((f) => {
    if (options?.category && f.category !== options.category.toLowerCase()) return false;
    return f.title.toLowerCase().includes(q) || f.content.toLowerCase().includes(q);
  });

  const results = new Map<string, VaultSearchResult>();

  for (const f of keywordMatches.slice(0, limit)) {
    const idx = f.content.toLowerCase().indexOf(q);
    const snippetStart = Math.max(0, idx - 100);
    const snippetEnd = Math.min(f.content.length, idx + query.length + 200);
    results.set(f.path, {
      title: f.title,
      path: f.path,
      category: f.category,
      snippet: f.content.slice(snippetStart, snippetEnd).replace(/\n/g, " ").trim(),
      match_type: "keyword",
    });
  }

  // Semantic matches (when embedder + knowledge store available)
  if (deps.knowledge && deps.embedder) {
    try {
      const embedding = await deps.embedder.embed(query);
      const semanticResults = deps.knowledge.search(embedding, limit * 2, 0.55, undefined, undefined, query);

      // IMPORTANT: filter to vault files only — knowledge store may contain
      // crawled web pages, template knowledge, or inline-ingested content
      const vaultPaths = new Set(files.map(f => f.path));

      for (const chunk of semanticResults) {
        if (!vaultPaths.has(chunk.source_path)) continue; // skip non-vault chunks

        const existing = results.get(chunk.source_path);
        if (existing) {
          existing.match_type = "both";
          existing.score = chunk.similarity;
        } else {
          results.set(chunk.source_path, {
            title: chunk.title,
            path: chunk.source_path,
            category: chunk.category ?? "",
            snippet: chunk.content.slice(0, 300).replace(/\n/g, " ").trim(),
            score: chunk.similarity,
            match_type: "semantic",
          });
        }
      }
    } catch {
      // Embedding failed — fall back to keyword-only results
    }
  }

  // Sort: "both" first, then by score (semantic), then keyword
  const sorted = [...results.values()].sort((a, b) => {
    const typeOrder = { both: 0, semantic: 1, keyword: 2 };
    const typeDiff = typeOrder[a.match_type] - typeOrder[b.match_type];
    if (typeDiff !== 0) return typeDiff;
    return (b.score ?? 0) - (a.score ?? 0);
  });

  return sorted.slice(0, limit);
}
```

- [ ] **Step 4: Update `search_obsidian` MCP tool to use the new function**

Replace the inline implementation in `server.ts:592-617` with a call to `searchObsidianHybrid()`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test src/__tests__/search-obsidian-hybrid.test.ts`
Expected: PASS

- [ ] **Step 6: Run full test suite**

Run: `bun test`
Expected: All pass, no regressions

- [ ] **Step 7: Commit**

```bash
git add src/mcp/server.ts src/__tests__/search-obsidian-hybrid.test.ts
git commit -m "feat: upgrade search_obsidian to hybrid keyword+semantic search"
```

---

## Task 2: Immediate Ingest on `write_obsidian_note`

**Why:** When an agent writes a note via MCP, the VaultWatcher picks it up after a 2s debounce. But during a fast conversation, the agent might write a note and then immediately try to `search_knowledge` for it — and miss because embedding hasn't happened yet. Wire immediate ingestion so written notes are searchable instantly.

**Note on double-processing:** The VaultWatcher will still fire ~2s later and call `ingestFile()` again. This is benign — `ingestFile()` uses content hashing (`contentHash` comparison at line 320 of ingest.ts) to skip unchanged chunks. The second call will be a no-op (`chunksUpdated: 0`). The overhead is minimal (read file + hash compare) and not worth adding a watcher suppression mechanism for.

**Files:**
- Modify: `src/mcp/server.ts:620-652`
- Test: `src/__tests__/obsidian.test.ts` (add test case)

- [ ] **Step 1: Write failing test**

```typescript
// Add to existing obsidian.test.ts or create new test
it("write_obsidian_note triggers immediate ingest when knowledge store available", () => {
  // Write a note, then verify knowledge store received the chunks
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/obsidian.test.ts`

- [ ] **Step 3: Add immediate ingest to write_obsidian_note handler**

After `writeVaultNote()` succeeds, if `deps.knowledge` and `deps.embedder` are available, call `ingestFile()` on the newly written file:

```typescript
// In write_obsidian_note handler, after writeVaultNote():
const relPath = writeVaultNote(deps.vaultPath, category, title, noteContent);
logger.info(`[mcp] Wrote Obsidian note: ${relPath}`);

// Immediate ingest for instant searchability
if (deps.knowledge && deps.embedder) {
  const { join } = await import("path");
  const fullPath = join(deps.vaultPath, relPath);
  try {
    const ingestResult = await ingestFile(fullPath, deps.vaultPath, deps.knowledge, deps.embedder);
    if (ingestResult.chunksUpdated > 0) {
      logger.info(`[mcp] Immediate ingest: ${relPath} (${ingestResult.chunksUpdated} chunks)`);
    }
  } catch (err) {
    logger.warn(`[mcp] Immediate ingest failed for ${relPath}: ${err}`);
    // Non-fatal — watcher will pick it up
  }
}
```

- [ ] **Step 4: Run tests**

Run: `bun test src/__tests__/obsidian.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/mcp/server.ts src/__tests__/obsidian.test.ts
git commit -m "feat: immediate knowledge ingest on write_obsidian_note"
```

---

## Task 3: Prose-as-Title Convention

**Why:** Notes named as claims ("memory graphs beat giant memory files") are self-describing in search results. An agent seeing that title knows instantly if it's relevant — before reading content. Currently `buildObsidianNote()` accepts whatever title the agent passes, which is often category-style ("Memory System", "Auth Config").

**Approach:** Add a lightweight title refinement function that transforms category-style titles into claim-style titles using a simple heuristic (no LLM call — that would be expensive for every note write). Also update the `write_obsidian_note` tool description to guide agents toward prose-as-title.

**Files:**
- Modify: `src/memory/obsidian.ts`
- Modify: `src/mcp/server.ts` (tool description update)
- Create: `src/__tests__/prose-title.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/__tests__/prose-title.test.ts
import { describe, it, expect } from "bun:test";
import { isCategoryStyleTitle } from "../memory/obsidian.js";

describe("isCategoryStyleTitle", () => {
  it("detects noun-only titles as category-style", () => {
    expect(isCategoryStyleTitle("Memory System")).toBe(true);
    expect(isCategoryStyleTitle("Auth Configuration")).toBe(true);
    expect(isCategoryStyleTitle("Deployment Pipeline")).toBe(true);
  });

  it("accepts claim-style titles with verbs", () => {
    expect(isCategoryStyleTitle("SQLite outperforms Postgres for our workload")).toBe(false);
    expect(isCategoryStyleTitle("agents need externalized memory to compound")).toBe(false);
  });

  it("detects verbs even in short titles", () => {
    expect(isCategoryStyleTitle("SQLite wins")).toBe(false);
    expect(isCategoryStyleTitle("retries fail silently")).toBe(false);
  });

  it("flags single-word titles as category-style", () => {
    expect(isCategoryStyleTitle("Auth")).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/prose-title.test.ts`

- [ ] **Step 3: Implement title analysis helpers**

```typescript
// In src/memory/obsidian.ts

const COMMON_VERBS = new Set([
  "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did",
  "will", "would", "could", "should", "may", "might",
  "shall", "can", "need", "must",
  "beat", "beats", "outperform", "outperforms",
  "handle", "handles", "require", "requires",
  "improve", "improves", "reduce", "reduces",
  "enable", "enables", "prevent", "prevents",
  "cause", "causes", "solve", "solves",
  "compound", "compounds", "scale", "scales",
  "fail", "fails", "work", "works",
]);

/** Check if a title is category-style (noun-heavy, no verbs). */
export function isCategoryStyleTitle(title: string): boolean {
  const words = title.toLowerCase().split(/\s+/);
  // Check for verbs first — even short titles like "SQLite wins" are claims
  if (words.some(w => COMMON_VERBS.has(w))) return false;
  // No verbs found — likely category-style
  return true;
}
```

- [ ] **Step 4: Update write_obsidian_note tool description**

In `server.ts`, update the tool description and title field to guide agents:

```typescript
description: "Write a note to the Obsidian vault. Creates proper frontmatter, wiki links, and metadata automatically. IMPORTANT: Use prose-as-title — name notes as claims, not categories. Good: 'SQLite outperforms Postgres for single-node workloads'. Bad: 'Database Comparison'. The title should tell a reader whether the note is relevant before they read the content.",
// ...
title: z.string().describe("Note title as a claim or finding (e.g. 'retry storms cause cascading failures' not 'Retry Patterns')"),
```

- [ ] **Step 5: Run tests**

Run: `bun test src/__tests__/prose-title.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/memory/obsidian.ts src/mcp/server.ts src/__tests__/prose-title.test.ts
git commit -m "feat: prose-as-title convention for vault notes"
```

---

## Task 4: Knowledge Health MCP Tool

**Why:** No visibility into whether the knowledge system is actually compounding or stagnating. Agents (and User) need to see: how many chunks exist, coverage by category, stale vs active ratios, embedding freshness, most/least accessed knowledge.

**Files:**
- Modify: `src/mcp/server.ts`
- Create: `src/__tests__/knowledge-health.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// src/__tests__/knowledge-health.test.ts
import { describe, it, expect } from "bun:test";

describe("knowledge_health MCP tool", () => {
  it("returns stats when knowledge store is available", () => {
    // Mock knowledge store with getStats()
    // Verify response includes total, files, categories, tiers
  });

  it("returns error when knowledge store unavailable", () => {
    // No deps.knowledge → error response
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/knowledge-health.test.ts`

- [ ] **Step 3: Register knowledge_health MCP tool**

Add after the existing tools in `server.ts`:

```typescript
server.registerTool(
  "knowledge_health",
  {
    description: "Get knowledge store health metrics: chunk counts, category distribution, tier breakdown, staleness, top accessed chunks",
    inputSchema: {},
  },
  async () => {
    if (!deps.knowledge) {
      return { content: [{ type: "text" as const, text: "Knowledge store not available" }], isError: true };
    }
    const stats = deps.knowledge.getStats();
    return { content: [{ type: "text" as const, text: JSON.stringify(stats, null, 2) }] };
  },
);
```

- [ ] **Step 4: Run tests**

Run: `bun test src/__tests__/knowledge-health.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/mcp/server.ts src/__tests__/knowledge-health.test.ts
git commit -m "feat: knowledge_health MCP tool for memory system visibility"
```

---

## Task 5: Brain-Ingest — Media Transcription

**Why:** Knowledge often starts as video/audio (YouTube talks, podcasts, voice memos, meetings). There's no automated path from media → vault. This is the most impactful gap — it feeds the compounding loop with external knowledge.

**Approach:** Two-stage pipeline:
1. **Transcribe** — Whisper (local via `whisper.cpp` binary or OpenAI Whisper API via OpenRouter)
2. **Extract** — LLM call to extract structured claims, frameworks, action items from transcript
3. **Write** — Generate Obsidian note with proper frontmatter + wikilinks, write to vault inbox

Stage 1 (this task): transcription wrapper.

**Files:**
- Create: `src/memory/transcribe.ts`
- Create: `src/__tests__/transcribe.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// src/__tests__/transcribe.test.ts
import { describe, it, expect, spyOn } from "bun:test";
import { transcribeAudio, downloadAudio } from "../memory/transcribe.js";

describe("transcribeAudio", () => {
  it("calls whisper binary with correct args", async () => {
    // Spy on Bun.spawn to verify whisper invocation
  });

  it("returns transcript text on success", async () => {
    // Mock whisper output file
  });

  it("throws on whisper failure", async () => {
    // Mock non-zero exit code
  });
});

describe("downloadAudio", () => {
  it("calls yt-dlp for YouTube URLs", async () => {
    // Spy on Bun.spawn to verify yt-dlp invocation
  });

  it("returns local path for local files", async () => {
    // No download needed for local paths
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/transcribe.test.ts`

- [ ] **Step 3: Implement transcription wrapper**

```typescript
// src/memory/transcribe.ts
import { existsSync } from "fs";
import { join, basename } from "path";
import { tmpdir } from "os";
import { logger } from "../utils/logger.js";

export interface TranscribeResult {
  text: string;
  duration_seconds?: number;
  language?: string;
}

/**
 * Download audio from a URL (YouTube, podcast, etc.) using yt-dlp.
 * Returns path to local audio file. For local files, returns the path as-is.
 */
export async function downloadAudio(source: string, outputDir?: string): Promise<string> {
  // Local file — no download needed
  if (existsSync(source)) return source;

  const dir = outputDir ?? join(tmpdir(), "nyxhive-ingest");
  const { mkdirSync } = await import("fs");
  mkdirSync(dir, { recursive: true });

  const outputPath = join(dir, `audio-${Date.now()}.%(ext)s`);

  const proc = Bun.spawn(["yt-dlp", "-x", "--audio-format", "wav", "-o", outputPath, source], {
    stdout: "pipe",
    stderr: "pipe",
  });

  // Read stderr concurrently with awaiting exit to prevent pipe buffer deadlock
  const [exitCode, stderrText] = await Promise.all([
    proc.exited,
    new Response(proc.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`yt-dlp failed (exit ${exitCode}): ${stderrText.slice(0, 500)}`);
  }

  // Find the output file (yt-dlp replaces %(ext)s)
  const { readdirSync } = await import("fs");
  const files = readdirSync(dir).filter(f => f.startsWith(`audio-`));
  const latest = files.sort().pop();
  if (!latest) throw new Error("yt-dlp produced no output file");

  return join(dir, latest);
}

/**
 * Transcribe audio file using whisper.cpp (local) or OpenAI Whisper API.
 * Prefers local whisper binary if available.
 */
export async function transcribeAudio(audioPath: string): Promise<TranscribeResult> {
  if (!existsSync(audioPath)) {
    throw new Error(`Audio file not found: ${audioPath}`);
  }

  // Try local whisper first
  const whisperPath = await findWhisperBinary();
  if (whisperPath) {
    return transcribeLocal(whisperPath, audioPath);
  }

  // Fallback: OpenAI Whisper API via fetch
  return transcribeApi(audioPath);
}

async function findWhisperBinary(): Promise<string | null> {
  // Check common locations
  const candidates = [
    "/usr/local/bin/whisper",
    "/opt/homebrew/bin/whisper",
    join(process.env.HOME ?? "", ".local/bin/whisper"),
  ];

  for (const path of candidates) {
    if (existsSync(path)) return path;
  }

  // Check PATH via which
  const proc = Bun.spawnSync(["which", "whisper"]);
  if (proc.exitCode === 0) {
    return proc.stdout.toString().trim();
  }

  return null;
}

async function transcribeLocal(whisperPath: string, audioPath: string): Promise<TranscribeResult> {
  const outputPath = join(tmpdir(), `whisper-${Date.now()}`);

  const outputDir = tmpdir();
  const proc = Bun.spawn([
    whisperPath,
    audioPath,
    "--model", "base",
    "--output_format", "txt",
    "--output_dir", outputDir,
  ], {
    stdout: "pipe",
    stderr: "pipe",
  });

  // Read stdout/stderr concurrently with awaiting exit to prevent pipe buffer deadlock
  const [exitCode, stdoutText, stderrText] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`Whisper failed (exit ${exitCode}): ${stderrText.slice(0, 500)}`);
  }

  // Read output .txt file — whisper writes to outputDir with the audio file's basename
  const { readFileSync } = await import("fs");
  const expectedOutput = join(outputDir, basename(audioPath).replace(/\.[^.]+$/, ".txt"));

  if (existsSync(expectedOutput)) {
    return { text: readFileSync(expectedOutput, "utf-8").trim() };
  }

  // Fallback: use captured stdout
  if (stdoutText.trim()) {
    return { text: stdoutText.trim() };
  }

  throw new Error(`Whisper produced no output (checked ${expectedOutput})`);
}

async function transcribeApi(audioPath: string): Promise<TranscribeResult> {
  const apiKey = process.env.OPENAI_API_KEY ?? process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    throw new Error("No Whisper binary found and no OPENAI_API_KEY/OPENROUTER_API_KEY set for API transcription");
  }

  const { readFileSync } = await import("fs");
  const audioData = readFileSync(audioPath);
  const fileName = basename(audioPath);

  const formData = new FormData();
  formData.append("file", new Blob([audioData]), fileName);
  formData.append("model", "whisper-1");

  const response = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}` },
    body: formData,
  });

  if (!response.ok) {
    throw new Error(`Whisper API failed (${response.status}): ${await response.text()}`);
  }

  const result = await response.json() as { text: string; duration?: number; language?: string };
  return {
    text: result.text,
    duration_seconds: result.duration,
    language: result.language,
  };
}
```

- [ ] **Step 4: Run tests**

Run: `bun test src/__tests__/transcribe.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/memory/transcribe.ts src/__tests__/transcribe.test.ts
git commit -m "feat: audio transcription wrapper (local whisper + API fallback)"
```

---

## Task 6: Brain-Ingest — Structured Knowledge Extraction

**Why:** A raw transcript is noise — thousands of filler words. We need to extract structured claims, frameworks, action items, and examples that can be embedded and retrieved meaningfully.

**Files:**
- Create: `src/memory/media-extract.ts`
- Create: `src/__tests__/media-extract.test.ts`

- [ ] **Step 1: Write failing test**

```typescript
// src/__tests__/media-extract.test.ts
import { describe, it, expect, spyOn } from "bun:test";
import { extractKnowledge, type ExtractedKnowledge } from "../memory/media-extract.js";

describe("extractKnowledge", () => {
  it("extracts claims from transcript text", async () => {
    // Mock LLM response with structured extraction
  });

  it("builds Obsidian note from extraction result", () => {
    // Verify frontmatter, wikilinks, sections
  });

  it("handles empty transcript gracefully", async () => {
    // Should return empty extraction, not throw
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/media-extract.test.ts`

- [ ] **Step 3: Implement extraction module**

```typescript
// src/memory/media-extract.ts
import { logger } from "../utils/logger.js";

export interface ExtractedKnowledge {
  title: string;           // Prose-as-title claim
  summary: string;         // 2-3 sentence overview
  claims: string[];        // Distinct claims worth preserving
  frameworks: string[];    // Named frameworks or mental models
  techniques: string[];    // Actionable techniques
  examples: string[];      // Concrete examples with context
  tags: string[];          // Suggested tags
  related_concepts: string[]; // Potential wikilink targets
}

const EXTRACTION_PROMPT = `You are a knowledge extraction agent. Given a transcript, extract structured knowledge.

Return a JSON object with these fields:
- title: A prose-as-title claim that captures the core insight (e.g. "memory graphs beat giant memory files" not "Memory Systems")
- summary: 2-3 sentences capturing the key message
- claims: Array of distinct claims worth preserving (12-18 for a long talk)
- frameworks: Named frameworks or mental models mentioned (3-5)
- techniques: Actionable techniques described (5-8)
- examples: Concrete examples with enough context to be useful (2-4)
- tags: Suggested category tags
- related_concepts: Terms that might link to existing knowledge (potential wikilinks)

Be precise. Extract signal, not noise. Each claim should stand alone as a useful piece of knowledge.

TRANSCRIPT:
`;

/**
 * Extract structured knowledge from a transcript using an LLM.
 * Uses a cheap model (haiku-class) to keep costs low.
 */
export async function extractKnowledge(
  transcript: string,
  options?: {
    sourceTitle?: string;
    sourceUrl?: string;
    apiKey?: string;
    model?: string;
  },
): Promise<ExtractedKnowledge> {
  const apiKey = options?.apiKey ?? process.env.OPENROUTER_API_KEY;
  if (!apiKey) throw new Error("No API key for knowledge extraction");

  const model = options?.model ?? "anthropic/claude-haiku-4-5-20251001";

  // Truncate very long transcripts to fit context
  const maxChars = 100_000;
  const truncated = transcript.length > maxChars
    ? transcript.slice(0, maxChars) + "\n[TRUNCATED]"
    : transcript;

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "user", content: EXTRACTION_PROMPT + truncated },
      ],
      response_format: { type: "json_object" },
      max_tokens: 4096,
    }),
  });

  if (!response.ok) {
    throw new Error(`Extraction LLM call failed (${response.status}): ${await response.text()}`);
  }

  const result = await response.json() as {
    choices: Array<{ message: { content: string } }>;
  };

  const content = result.choices?.[0]?.message?.content;
  if (!content) throw new Error("Empty LLM response for knowledge extraction");

  try {
    return JSON.parse(content) as ExtractedKnowledge;
  } catch {
    throw new Error(`Failed to parse extraction JSON: ${content.slice(0, 200)}`);
  }
}

/**
 * Build an Obsidian note from extracted knowledge.
 * Reuses buildObsidianNote() from obsidian.ts for frontmatter/structure,
 * then appends extraction-specific sections.
 */
export function buildExtractionNote(
  extraction: ExtractedKnowledge,
  source: { url?: string; filePath?: string; duration?: number },
): string {
  // NOTE: import { buildObsidianNote } from "./obsidian.js" at top of file

  // Build structured content body
  const sections: string[] = [];

  sections.push(extraction.summary);

  // Source metadata
  const sourceLines: string[] = [];
  if (source.url) sourceLines.push(`- URL: ${source.url}`);
  if (source.filePath) sourceLines.push(`- File: ${source.filePath}`);
  if (source.duration) sourceLines.push(`- Duration: ${Math.round(source.duration / 60)} minutes`);
  if (sourceLines.length > 0) {
    sections.push(`## Source\n\n${sourceLines.join("\n")}`);
  }

  if (extraction.claims.length > 0) {
    sections.push(`## Key Claims\n\n${extraction.claims.map(c => `- ${c}`).join("\n")}`);
  }
  if (extraction.frameworks.length > 0) {
    sections.push(`## Frameworks\n\n${extraction.frameworks.map(f => `- ${f}`).join("\n")}`);
  }
  if (extraction.techniques.length > 0) {
    sections.push(`## Techniques\n\n${extraction.techniques.map(t => `- ${t}`).join("\n")}`);
  }
  if (extraction.examples.length > 0) {
    sections.push(`## Examples\n\n${extraction.examples.map(e => `- ${e}`).join("\n")}`);
  }

  return buildObsidianNote({
    title: extraction.title,
    content: sections.join("\n\n"),
    category: "Knowledge",
    tags: ["ingested", ...extraction.tags],
    relatedNotes: extraction.related_concepts,
    sourceAgent: "brain-ingest",
    properties: {
      ...(source.url ? { source_url: source.url } : {}),
      ...(source.duration ? { duration_seconds: source.duration } : {}),
    },
  });
}
```

- [ ] **Step 4: Run tests**

Run: `bun test src/__tests__/media-extract.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/memory/media-extract.ts src/__tests__/media-extract.test.ts
git commit -m "feat: structured knowledge extraction from transcripts"
```

---

## Task 7: Brain-Ingest — MCP Tool

**Why:** Wire the transcription + extraction + vault write into a single MCP tool that agents can call. Also expose as an HTTP endpoint for CLI/cron use.

**Files:**
- Modify: `src/mcp/server.ts`
- Modify: `src/server/routes/knowledge.ts`

- [ ] **Step 1: Register `ingest_media` MCP tool**

```typescript
server.registerTool(
  "ingest_media",
  {
    description: "Ingest video/audio/transcript into the knowledge vault. Downloads, transcribes, extracts structured knowledge, and writes an Obsidian note. Supports YouTube URLs, local audio/video files, and raw transcript text.",
    inputSchema: {
      source: z.string().describe("YouTube URL, local file path, or raw transcript text"),
      source_type: z.enum(["url", "file", "transcript"]).describe("Type of source"),
      title: z.string().optional().describe("Override title (otherwise auto-generated from content)"),
    },
  },
  async ({ source, source_type, title }) => {
    if (!deps.vaultPath) {
      return { content: [{ type: "text" as const, text: "Vault path not configured" }], isError: true };
    }

    try {
      let transcript: string;
      let sourceUrl: string | undefined;
      let sourceFile: string | undefined;
      let duration: number | undefined;

      if (source_type === "transcript") {
        transcript = source;
      } else {
        // Download if URL
        const audioPath = source_type === "url"
          ? await downloadAudio(source)
          : source;
        sourceUrl = source_type === "url" ? source : undefined;
        sourceFile = source_type === "file" ? source : undefined;

        // Transcribe
        const result = await transcribeAudio(audioPath);
        transcript = result.text;
        duration = result.duration_seconds;
      }

      // Extract structured knowledge
      const extraction = await extractKnowledge(transcript, {
        sourceTitle: title,
      });

      if (title) extraction.title = title;

      // Build and write note
      const noteContent = buildExtractionNote(extraction, {
        url: sourceUrl,
        filePath: sourceFile,
        duration,
      });

      const relPath = writeVaultNote(deps.vaultPath, "Knowledge/ingested", extraction.title, noteContent);
      logger.info(`[mcp] Brain-ingest: ${relPath}`);

      // Immediate ingest
      if (deps.knowledge && deps.embedder) {
        const { join } = await import("path");
        await ingestFile(join(deps.vaultPath, relPath), deps.vaultPath, deps.knowledge, deps.embedder);
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            ok: true,
            path: relPath,
            title: extraction.title,
            claims: extraction.claims.length,
            frameworks: extraction.frameworks.length,
            techniques: extraction.techniques.length,
          }),
        }],
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: `Brain-ingest failed: ${err instanceof Error ? err.message : err}` }],
        isError: true,
      };
    }
  },
);
```

- [ ] **Step 2: Add HTTP endpoint for CLI/cron use**

In `src/server/routes/knowledge.ts`, add a POST `/knowledge/ingest-media` route.

- [ ] **Step 3: Write integration test**

- [ ] **Step 4: Run tests**

Run: `bun test`
Expected: All pass

- [ ] **Step 5: Commit**

```bash
git add src/mcp/server.ts src/server/routes/knowledge.ts src/__tests__/ingest-media.test.ts
git commit -m "feat: ingest_media MCP tool — brain-ingest for NyxHive"
```

---

## Task 8: Final Integration & Full Test Suite

- [ ] **Step 1: Run full test suite**

Run: `bun test`
Expected: All pass, no regressions

- [ ] **Step 2: Run type checker**

Run: `bunx tsc --noEmit`
Expected: Clean

- [ ] **Step 3: Run linter**

Run: `bun run lint`
Expected: Clean

- [ ] **Step 4: Final commit**

```bash
git add -A
git commit -m "chore: memory compounds — integration cleanup"
```

---

## Summary

| Task | What | Impact |
|------|------|--------|
| 1 | Hybrid search_obsidian | Agents find vault notes by meaning, not just keywords |
| 2 | Immediate ingest on write | Notes searchable instantly after write, no 2s delay |
| 3 | Prose-as-title convention | Search results self-describing, better retrieval over time |
| 4 | Knowledge health tool | Visibility into whether memory is compounding or stagnating |
| 5 | Transcription wrapper | Audio/video → text (Whisper local + API fallback) |
| 6 | Knowledge extraction | Transcript → structured claims, frameworks, techniques |
| 7 | ingest_media MCP tool | End-to-end: URL/file → vault note → embeddings |
| 8 | Integration verification | Full suite clean |

**Dependencies:** Tasks 1-4 are independent. Tasks 5→6→7 are sequential. Task 8 is final.

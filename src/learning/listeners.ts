/**
 * Reactive learning listeners — close the feedback loop by auto-learning
 * from proposal rejections and task failures.
 */

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../utils/logger.js";
import type { KnowledgeStore } from "../memory/knowledge.js";
import type { EmbeddingProvider } from "../memory/embeddings.js";
import { buildObsidianNote, detectWikiLinks, extractTags, getVaultNoteTitles } from "../memory/obsidian.js";
import { chunkMarkdown } from "../memory/ingest.js";
import type { NyxHiveConfig } from "../types.js";
import { LEARNING_DEDUP_WINDOW_MS } from "../defaults.js";

/** Redact potential secrets from error messages before persisting to learning store. */
const CREDENTIAL_PATTERNS = [
  // API keys / bearer tokens (generic hex/base64 strings 20+ chars after key-like labels)
  /(?:api[_-]?key|token|secret|password|bearer|authorization)[=:\s]["']?[A-Za-z0-9+/=_-]{20,}/gi,
  // sk-... (OpenAI/Anthropic style)
  /sk-[A-Za-z0-9]{20,}/g,
  // Bearer tokens in quoted strings
  /Bearer\s+[A-Za-z0-9._~+/=-]{20,}/gi,
  // Generic long base64/hex that looks like a credential
  /(?:key|secret|token|password|credential)["']?\s*[:=]\s*["']?[A-Za-z0-9+/=_-]{16,}/gi,
];

function sanitizeErrorForStorage(error: string): string {
  let sanitized = error;
  for (const pattern of CREDENTIAL_PATTERNS) {
    sanitized = sanitized.replace(pattern, (match) => {
      // Keep the label/prefix, redact the value
      const eqIdx = match.search(/[=:\s]["']?[A-Za-z0-9]/);
      if (eqIdx > 0) {
        return `${match.slice(0, eqIdx + 1)}[REDACTED]`;
      }
      return "[REDACTED]";
    });
  }
  return sanitized;
}

interface RejectionEvent {
  proposal_id: string;
  title: string;
  category: string;
  proposed_by: string;
  reason: string;
}

interface FailureEvent {
  message_id: string;
  agent: string;
  error: string;
}

// Dedup tracking for post-mortem — prevent floods from repeated errors
const recentErrorHashes = new Map<string, number>(); // hash → timestamp
const MAX_DAILY_POSTMORTEMS = 10;
let dailyPostmortemCount = 0;
let dailyResetAt = 0;

function hashError(error: string): string {
  return createHash("sha256").update(error.slice(0, 200)).digest("hex").slice(0, 16);
}

function isDuplicateError(error: string): boolean {
  const hash = hashError(error);
  const existing = recentErrorHashes.get(hash);
  const now = Date.now();

  // Clean stale entries (older than 24h)
  for (const [h, ts] of recentErrorHashes) {
    if (now - ts > LEARNING_DEDUP_WINDOW_MS) recentErrorHashes.delete(h);
  }

  if (existing && now - existing < LEARNING_DEDUP_WINDOW_MS) return true;
  recentErrorHashes.set(hash, now);
  return false;
}

function checkDailyLimit(): boolean {
  const now = Date.now();
  if (now - dailyResetAt > LEARNING_DEDUP_WINDOW_MS) {
    dailyPostmortemCount = 0;
    dailyResetAt = now;
  }
  return dailyPostmortemCount < MAX_DAILY_POSTMORTEMS;
}

/** Categories that represent critical decisions — priority 3, never pruned. */
const CRITICAL_CATEGORIES = new Set(["decisions"]);

async function ingestLearning(
  content: string,
  category: string,
  sourceAgent: string,
  knowledge: KnowledgeStore,
  embedder: EmbeddingProvider,
  config?: NyxHiveConfig,
  decisionStatus?: string,
): Promise<void> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const slug = content.slice(0, 40).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "");
  const filename = `${timestamp}-${slug}.md`;
  const title = content.slice(0, 80);
  const priority = CRITICAL_CATEGORIES.has(category) ? 3 : 2;

  const vaultPath = config?.vault?.path;

  if (vaultPath) {
    const existingTitles = getVaultNoteTitles(vaultPath, config?.vault?.skip_dirs);
    const linkedContent = detectWikiLinks(content, existingTitles);
    const tags = extractTags(content, category, existingTitles);
    const markdown = buildObsidianNote({
      title,
      content: linkedContent,
      category,
      tags,
      sourceAgent,
      relatedNotes: [...existingTitles].filter(t =>
        content.toLowerCase().includes(t.toLowerCase()) && t.length >= 3
      ).slice(0, 5),
    });

    const dir = join(vaultPath, "Learnings", category);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const filePath = join(dir, filename);
    writeFileSync(filePath, markdown, "utf-8");
    logger.info(`[learning] Wrote ${filePath}`);

    const sourcePath = `Learnings/${category}/${filename}`;
    const chunks = chunkMarkdown(title, markdown, category, sourcePath);
    for (const chunk of chunks) {
      const embedding = await embedder.embed(chunk.prefixed);
      knowledge.upsertChunk(
        chunk.title, chunk.section, chunk.content, chunk.category,
        chunk.sourcePath, chunk.contentHash, embedding,
        undefined, priority, sourceAgent,
        undefined, undefined,
        decisionStatus,
      );
    }
  } else {
    const markdown = buildObsidianNote({ title, content, category, sourceAgent });
    const sourcePath = `learnings/${category}/${filename}`;
    const chunks = chunkMarkdown(title, markdown, category, sourcePath);
    for (const chunk of chunks) {
      const embedding = await embedder.embed(chunk.prefixed);
      knowledge.upsertChunk(
        chunk.title, chunk.section, chunk.content, chunk.category,
        chunk.sourcePath, chunk.contentHash, embedding,
        undefined, priority, sourceAgent,
        undefined, undefined,
        decisionStatus,
      );
    }
  }
}

interface SSEEvent {
  type: string;
  data: Record<string, unknown>;
  timestamp: number;
}

interface EventSource {
  onEvent(listener: (event: SSEEvent) => void): () => void;
}

/**
 * Register reactive learning listeners on the processor's SSE event stream.
 */
export function registerLearningListeners(
  processor: EventSource,
  knowledge: KnowledgeStore,
  embedder: EmbeddingProvider,
  config?: NyxHiveConfig,
): void {
  processor.onEvent(async (event: SSEEvent) => {
    switch (event.type) {
      // --- Rejection feedback loop ---
      case "proposal:rejected": {
        const data = event.data as unknown as RejectionEvent;
        try {
          const reason = data.reason ?? "No reason provided";
          const content = [
            `# Rejected Proposal: ${data.title ?? "Unknown"}`,
            "",
            `**Proposed by:** ${data.proposed_by ?? "unknown"}`,
            `**Category:** ${data.category ?? "unknown"}`,
            `**Rejection reason:** ${sanitizeErrorForStorage(reason)}`,
            "",
            "This proposal was rejected. Future proposals in this area should account for this feedback.",
          ].join("\n");

          await ingestLearning(content, "rejected-proposals", data.proposed_by, knowledge, embedder, config);
          logger.info(`[learning] Rejection learned: "${data.title}" (${reason.slice(0, 60)})`);
        } catch (err) {
          logger.error(`[learning] Failed to learn from rejection: ${err}`);
        }
        break;
      }

      // --- Implementation pattern learning ---
      case "proposal:completed": {
        const data = event.data as {
          proposal_id: string;
          title: string;
          category: string;
          description: string;
          files_affected: string[];
          executed_by: string;
          response_excerpt: string;
          pr_url: string | null;
        };
        try {
          const content = [
            `# Completed Proposal: ${data.title}`,
            "",
            `**Category:** ${data.category}`,
            `**Executed by:** ${data.executed_by}`,
            `**Files affected:** ${data.files_affected.join(", ") || "none"}`,
            data.pr_url ? `**PR:** ${data.pr_url}` : "",
            "",
            "## What was proposed",
            data.description,
            "",
            "## Execution result (excerpt)",
            data.response_excerpt,
            "",
            "This proposal was successfully executed. Use this as a pattern reference for similar future work.",
          ].filter(Boolean).join("\n");

          await ingestLearning(content, "implementation-patterns", data.executed_by, knowledge, embedder, config);
          logger.info(`[learning] Implementation pattern learned: "${data.title}"`);
        } catch (err) {
          logger.error(`[learning] Failed to learn from proposal completion: ${err}`);
        }
        break;
      }

      // --- Decision record extraction ---
      case "proposal:approved": {
        const data = event.data as {
          proposal_id: string;
          title: string;
          category: string;
          description: string;
          approved_by: string;
          proposed_by: string;
        };
        try {
          const content = [
            `# Decision: ${data.title}`,
            "",
            `**Decision:** Approved proposal "${data.title}" for implementation`,
            `**Category:** ${data.category}`,
            `**Proposed by:** ${data.proposed_by}`,
            `**Approved by:** ${data.approved_by}`,
            `**Date:** ${new Date().toISOString().split("T")[0]}`,
            "",
            "## Rationale",
            data.description,
          ].join("\n");

          await ingestLearning(content, "decisions", data.proposed_by, knowledge, embedder, config, "accepted");
          logger.info(`[learning] Decision recorded: "${data.title}"`);
        } catch (err) {
          logger.error(`[learning] Failed to record decision: ${err}`);
        }
        break;
      }

      // --- Post-mortem auto-learning ---
      case "message:failed": {
        const data = event.data as unknown as FailureEvent;
        try {
          const rawError = (data.error as string) ?? "";

          // Guards: too short, duplicate, or rate limited
          if (rawError.length < 20) return;
          if (isDuplicateError(rawError)) return;
          if (!checkDailyLimit()) return;

          dailyPostmortemCount++;

          // Sanitize error message to prevent credential leakage into learning store
          const error = sanitizeErrorForStorage(rawError);

          const content = [
            `# Task Failure: ${data.agent}`,
            "",
            `**Error:** ${error}`,
            `**Message ID:** ${data.message_id}`,
            `**Timestamp:** ${new Date().toISOString()}`,
            "",
            "This task failed. If encountering similar work, consider the error context above.",
          ].join("\n");

          await ingestLearning(content, "post-mortems", data.agent, knowledge, embedder, config);
          logger.info(`[learning] Post-mortem learned: ${data.agent} — ${error.slice(0, 60)}`);
        } catch (err) {
          logger.error(`[learning] Failed to learn from failure: ${err}`);
        }
        break;
      }
    }
  });

  logger.info("[learning] Reactive listeners registered (rejection + post-mortem)");
}

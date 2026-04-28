/**
 * Periodic learning analysis — scout effectiveness scoring and reporting.
 * Runs on scheduler ticks, not real-time.
 */

import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../utils/logger.js";
import type { ProposalStore, Proposal } from "../proposals/store.js";
import type { KnowledgeStore } from "../memory/knowledge.js";
import type { EmbeddingProvider } from "../memory/embeddings.js";
import { chunkMarkdown } from "../memory/ingest.js";

export interface ScoutTypeStats {
  scoutSource: string;
  total: number;
  approved: number;
  rejected: number;
  expired: number;
  autoExecuted: number;
  pending: number;
  acceptanceRate: number; // 0-100
}

export interface ScoutReport {
  period: string;
  since: number;
  until: number;
  stats: ScoutTypeStats[];
  totalProposed: number;
  totalApproved: number;
  totalRejected: number;
  overallAcceptanceRate: number;
}

/**
 * Generate a scout effectiveness report from proposal data.
 */
export function generateScoutReport(
  proposals: ProposalStore,
  since: number,
  until: number = Date.now(),
): ScoutReport {
  // Get all proposals in the period
  const all = proposals.list();
  const inPeriod = all.filter(p => p.created_at >= since && p.created_at <= until);

  // Group by scout_source
  const bySource = new Map<string, Proposal[]>();
  for (const p of inPeriod) {
    const source = p.scout_source || "manual";
    const arr = bySource.get(source) ?? [];
    arr.push(p);
    bySource.set(source, arr);
  }

  const stats: ScoutTypeStats[] = [];
  let totalApproved = 0;
  let totalRejected = 0;

  for (const [source, proposals] of bySource) {
    const approved = proposals.filter(p => p.status === "approved" || p.status === "completed").length;
    const rejected = proposals.filter(p => p.status === "rejected").length;
    const expired = proposals.filter(p => p.status === "expired").length;
    const autoExecuted = proposals.filter(p => p.autonomy === "auto" && p.status === "completed").length;
    const pending = proposals.filter(p => p.status === "proposed").length;
    const decided = approved + rejected;

    totalApproved += approved;
    totalRejected += rejected;

    stats.push({
      scoutSource: source,
      total: proposals.length,
      approved,
      rejected,
      expired,
      autoExecuted,
      pending,
      acceptanceRate: decided > 0 ? Math.round((approved / decided) * 100) : 0,
    });
  }

  // Sort by total descending
  stats.sort((a, b) => b.total - a.total);

  const totalDecided = totalApproved + totalRejected;

  // Week label
  const d = new Date(since);
  const weekNum = Math.ceil((d.getDate() + new Date(d.getFullYear(), d.getMonth(), 1).getDay()) / 7);
  const period = `${d.getFullYear()}-W${String(weekNum).padStart(2, "0")}`;

  return {
    period,
    since,
    until,
    stats,
    totalProposed: inPeriod.length,
    totalApproved,
    totalRejected,
    overallAcceptanceRate: totalDecided > 0 ? Math.round((totalApproved / totalDecided) * 100) : 0,
  };
}

/**
 * Format a scout report as a readable Markdown string.
 */
export function formatScoutReport(report: ScoutReport): string {
  const lines: string[] = [
    `# Weekly Scout Report (${report.period})`,
    "",
  ];

  if (report.stats.length === 0) {
    lines.push("No proposals in this period.");
    return lines.join("\n");
  }

  // Per-source breakdown
  for (const s of report.stats) {
    const parts = [
      `${s.approved} approved`,
      `${s.rejected} rejected`,
    ];
    if (s.expired > 0) parts.push(`${s.expired} expired`);
    if (s.pending > 0) parts.push(`${s.pending} pending`);
    if (s.autoExecuted > 0) parts.push(`${s.autoExecuted} auto-executed`);
    const warn = s.acceptanceRate < 20 && s.total >= 3 ? " ⚠️" : "";
    lines.push(`**${s.scoutSource}:** ${s.total} proposed, ${parts.join(", ")} (${s.acceptanceRate}%)${warn}`);
  }

  lines.push("");
  lines.push(`**Total:** ${report.totalProposed} proposed, ${report.totalApproved} approved, ${report.totalRejected} rejected → ${report.overallAcceptanceRate}% acceptance`);

  return lines.join("\n");
}

/**
 * Write scout report to vault and ingest into knowledge store.
 */
export async function persistScoutReport(
  report: ScoutReport,
  knowledge: KnowledgeStore,
  embedder: EmbeddingProvider,
  vaultPath?: string,
): Promise<void> {
  const content = formatScoutReport(report);
  const filename = `${report.period}.md`;

  if (vaultPath) {
    const dir = join(vaultPath, "Learnings", "scout-effectiveness");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const filePath = join(dir, filename);
    writeFileSync(filePath, content, "utf-8");
    logger.info(`[learning] Scout report written to ${filePath}`);
  }

  // Ingest for agent querying
  const sourcePath = `Learnings/scout-effectiveness/${filename}`;
  const title = `Scout Effectiveness Report ${report.period}`;
  const chunks = chunkMarkdown(title, content, "scout-effectiveness", sourcePath);
  for (const chunk of chunks) {
    const embedding = await embedder.embed(chunk.prefixed);
    knowledge.upsertChunk(
      chunk.title, chunk.section, chunk.content, chunk.category,
      chunk.sourcePath, chunk.contentHash, embedding,
      undefined, 1, // priority 1 (informational, not boosted)
    );
  }
}

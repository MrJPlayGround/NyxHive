import { logger } from "../utils/logger.js";
import { estimateTokens } from "./tokens.js";

export interface TokenContributor {
  label: string;
  charCount: number;
  tokenEstimate: number;
  source?: string;
  trimmed?: boolean;
}

export interface TokenDisciplineReport {
  scope: string;
  totalTokens: number;
  contextWindow?: number;
  utilizationPct?: number;
  contributors: TokenContributor[];
  warnings: string[];
}

export interface TrimTokenBudgetOptions {
  marker?: string;
  mode?: "exact" | "fast";
}

const DEFAULT_APPROACHING_CONTEXT_PCT = 70;
const DEFAULT_HIGH_CONTEXT_PCT = 85;
const DEFAULT_COST_WASTE_CONTRIBUTOR_PCT = 35;

function formatTokenCount(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(tokens >= 10_000 ? 0 : 1)}k` : String(tokens);
}

function normalizeTokenBudget(maxTokens: number): number {
  return Number.isFinite(maxTokens) ? Math.max(1, Math.floor(maxTokens)) : 1;
}

/**
 * Trim a text envelope to an approximate token budget while preserving both
 * the beginning and end, which usually keeps instructions plus closing markers.
 */
export function trimTextToTokenBudget(
  text: string,
  maxTokens: number,
  options?: TrimTokenBudgetOptions,
): { text: string; tokenEstimate: number; originalTokenEstimate: number; trimmed: boolean } {
  const originalTokenEstimate = estimateTokens(text, { mode: options?.mode ?? "fast" });
  const budget = normalizeTokenBudget(maxTokens);
  if (originalTokenEstimate <= budget) {
    return { text, tokenEstimate: originalTokenEstimate, originalTokenEstimate, trimmed: false };
  }

  const marker = options?.marker ?? "[...trimmed for token budget...]";
  const markerTokens = estimateTokens(marker, { mode: "fast" });
  const availableTokens = Math.max(1, budget - markerTokens);
  const maxChars = Math.max(marker.length + 2, Math.floor(availableTokens * 3.5));
  const headChars = Math.max(1, Math.floor(maxChars * 0.55));
  const tailChars = Math.max(1, maxChars - headChars);
  const trimmedText = `${text.slice(0, headChars).trimEnd()}\n\n${marker}\n\n${text.slice(-tailChars).trimStart()}`;
  const tokenEstimate = estimateTokens(trimmedText, { mode: "fast" });

  return {
    text: trimmedText,
    tokenEstimate,
    originalTokenEstimate,
    trimmed: true,
  };
}

export function measureTokenContributor(
  label: string,
  content: string,
  source?: string,
  trimmed?: boolean,
): TokenContributor {
  return {
    label,
    charCount: content.length,
    tokenEstimate: estimateTokens(content, { mode: "fast" }),
    source,
    trimmed,
  };
}

export function buildTokenDisciplineReport(params: {
  scope: string;
  contributors: TokenContributor[];
  contextWindow?: number;
  approachingPct?: number;
  highPct?: number;
  costWasteContributorPct?: number;
}): TokenDisciplineReport {
  const contributors = params.contributors.filter((part) => part.tokenEstimate > 0 || part.charCount > 0);
  const totalTokens = contributors.reduce((sum, part) => sum + part.tokenEstimate, 0);
  const contextWindow = params.contextWindow && params.contextWindow > 0 ? params.contextWindow : undefined;
  const utilizationPct = contextWindow ? Math.round((totalTokens / contextWindow) * 100) : undefined;
  const warnings: string[] = [];

  const approachingPct = params.approachingPct ?? DEFAULT_APPROACHING_CONTEXT_PCT;
  const highPct = params.highPct ?? DEFAULT_HIGH_CONTEXT_PCT;
  if (contextWindow && utilizationPct !== undefined) {
    if (utilizationPct >= highPct) {
      warnings.push(`${params.scope} is using ${utilizationPct}% of context (${formatTokenCount(totalTokens)}/${formatTokenCount(contextWindow)} tokens); trim prompt/history contributors before the next costly turn.`);
    } else if (utilizationPct >= approachingPct) {
      warnings.push(`${params.scope} is approaching context pressure at ${utilizationPct}% (${formatTokenCount(totalTokens)}/${formatTokenCount(contextWindow)} tokens).`);
    }
  }

  const costWastePct = params.costWasteContributorPct ?? DEFAULT_COST_WASTE_CONTRIBUTOR_PCT;
  if (contextWindow) {
    for (const contributor of contributors) {
      const pct = Math.round((contributor.tokenEstimate / contextWindow) * 100);
      if (pct >= costWastePct) {
        warnings.push(`${params.scope} contributor "${contributor.label}" is ${pct}% of the context window (${formatTokenCount(contributor.tokenEstimate)} tokens); check for cost-waste envelope growth.`);
      }
    }
  }

  for (const contributor of contributors) {
    if (contributor.trimmed) {
      warnings.push(`${params.scope} contributor "${contributor.label}" was trimmed to ${formatTokenCount(contributor.tokenEstimate)} tokens.`);
    }
  }

  return {
    scope: params.scope,
    totalTokens,
    contextWindow,
    utilizationPct,
    contributors,
    warnings,
  };
}

export function logTokenDisciplineWarnings(report: TokenDisciplineReport): void {
  for (const warning of report.warnings) {
    logger.warn(`[token-discipline] ${warning}`);
  }
}

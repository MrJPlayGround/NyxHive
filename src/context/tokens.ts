import type { StoredMessage } from "../memory/store.js";
import { logger } from "../utils/logger.js";

let encoder: { encode: (text: string) => number[] } | null = null;
const LARGE_TEXT_HEURISTIC_THRESHOLD = 8_000;
const EXACT_TOKEN_CACHE_MAX_ENTRIES = 2_048;
const exactTokenCache = new Map<string, number>();

try {
  const { encodingForModel } = await import("js-tiktoken");
  encoder = encodingForModel("gpt-4o");
} catch (err) {
  logger.warn(`[tokens] Failed to load tiktoken, falling back to heuristic: ${err}`);
}

export type TokenEstimateMode = "exact" | "fast";

export interface TokenEstimateOptions {
  mode?: TokenEstimateMode;
}

function heuristicTokens(text: string): number {
  return Math.ceil(text.length / 3.5);
}

function readExactCache(text: string): number | undefined {
  if (text.length >= LARGE_TEXT_HEURISTIC_THRESHOLD) return undefined;
  const cached = exactTokenCache.get(text);
  if (cached === undefined) return undefined;
  exactTokenCache.delete(text);
  exactTokenCache.set(text, cached);
  return cached;
}

function writeExactCache(text: string, tokens: number): number {
  if (text.length >= LARGE_TEXT_HEURISTIC_THRESHOLD) return tokens;
  if (exactTokenCache.has(text)) exactTokenCache.delete(text);
  exactTokenCache.set(text, tokens);
  if (exactTokenCache.size > EXACT_TOKEN_CACHE_MAX_ENTRIES) {
    const oldestKey = exactTokenCache.keys().next().value;
    if (oldestKey !== undefined) exactTokenCache.delete(oldestKey);
  }
  return tokens;
}

/**
 * Count tokens using cl100k_base tokenizer with heuristic fallback.
 */
export function estimateTokens(text: string, options?: TokenEstimateOptions): number {
  if (!text) return 0;
  const cached = readExactCache(text);
  if (cached !== undefined) return cached;

  const useHeuristic = !encoder || (options?.mode === "fast" && text.length >= LARGE_TEXT_HEURISTIC_THRESHOLD);
  if (useHeuristic) return heuristicTokens(text);

  const activeEncoder = encoder!;
  return writeExactCache(text, activeEncoder.encode(text).length);
}

/**
 * Token count for a stored message.
 * Always estimates from content since stored tokens_out reflects CLI output tokens
 * (including tool calls), not the actual content tokens injected into history.
 */
export function messageTokens(msg: StoredMessage, options?: TokenEstimateOptions): number {
  return estimateTokens(msg.content, options);
}

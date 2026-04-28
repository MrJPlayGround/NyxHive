import type { ConversationMessage } from "../agents/invoke.js";

export interface BtwCachedContext {
  systemPrompt: string;
  conversationHistory: ConversationMessage[];
  agentKey: string;
  conversationId: string;
}

interface CacheEntry {
  context: BtwCachedContext;
  createdAt: number;
}

export class BtwContextCache {
  private cache = new Map<string, CacheEntry>();

  set(messageId: string, context: BtwCachedContext): void {
    this.cache.set(messageId, { context, createdAt: Date.now() });
  }

  get(messageId: string): BtwCachedContext | null {
    const entry = this.cache.get(messageId);
    return entry?.context ?? null;
  }

  evict(messageId: string): void {
    this.cache.delete(messageId);
  }

  prune(maxAgeMs: number): number {
    const cutoff = Date.now() - maxAgeMs;
    let pruned = 0;
    for (const [key, entry] of this.cache) {
      if (entry.createdAt < cutoff) {
        this.cache.delete(key);
        pruned++;
      }
    }
    return pruned;
  }

  get size(): number {
    return this.cache.size;
  }
}

export class BtwRateLimiter {
  private windows = new Map<string, number[]>();

  constructor(
    private maxPerWindow = 5,
    private windowMs = 60_000,
  ) {}

  check(source: string): boolean {
    const now = Date.now();
    const cutoff = now - this.windowMs;
    const timestamps = (this.windows.get(source) ?? []).filter((t) => t > cutoff);

    if (timestamps.length >= this.maxPerWindow) {
      this.windows.set(source, timestamps);
      return false;
    }

    timestamps.push(now);
    this.windows.set(source, timestamps);
    return true;
  }
}

/**
 * Build the message array for a BTW inference call.
 * Caps conversation history at maxMessages and appends progress context.
 */
export function buildBtwMessages(
  cached: BtwCachedContext,
  question: string,
  progress: { activity?: string; text?: string },
  maxMessages = 20,
): ConversationMessage[] {
  const history = cached.conversationHistory.slice(-maxMessages);

  const progressParts: string[] = [];
  if (progress.activity) progressParts.push(`Agent is currently: ${progress.activity}`);
  if (progress.text) progressParts.push(`Progress so far: ${progress.text.slice(0, 2000)}`);

  const contextNote = progressParts.length > 0
    ? `[${progressParts.join(". ")}]\n\n`
    : "";

  return [
    ...history,
    { role: "user" as const, content: `${contextNote}${question}` },
  ];
}

/**
 * Conversational Memory Service
 *
 * Unified search across conversation history, graph memory, and knowledge embeddings.
 * Provides cross-session recall, memory injection into new conversations,
 * and pre-summarization memory flushing.
 */

import { logger } from "../utils/logger.js";
import type { MemoryStore, StoredMessage, MessageSearchResult, StoredMemory } from "./store.js";
import type { GraphMemory } from "./graph.js";
import type { KnowledgeStore, KnowledgeChunk } from "./knowledge.js";
import type { EmbeddingProvider } from "./embeddings.js";
import type { ProviderRouter } from "../providers/router.js";
import type { MemoryType, MemoryNode } from "../types.js";

// --- Types ---

export interface ConversationMemoryResult {
  /** Formatted context block for injection into system prompt */
  contextBlock: string | null;
  /** Structured results for MCP tool responses */
  results: MemorySearchHit[];
  /** Number of sources searched */
  sourcesSearched: number;
}

export interface MemorySearchHit {
  content: string;
  source: "message" | "graph" | "knowledge" | "memory";
  relevance: number; // 0-1, higher is more relevant
  type?: string;     // memory type (fact, decision, preference, etc.)
  channel?: string;
  timestamp?: number;
  conversationId?: string;
}

export interface ConversationMemoryDeps {
  memory?: MemoryStore;
  graph?: GraphMemory;
  knowledge?: KnowledgeStore;
  embedder?: EmbeddingProvider;
}

// --- Constants ---

const MAX_GRAPH_RESULTS = 15;
const MAX_MESSAGE_RESULTS = 10;
const MAX_KNOWLEDGE_RESULTS = 5;
const MAX_MEMORY_RESULTS = 5;
const MEMORY_INJECT_MAX_CHARS = 2000;
const MEMORY_INJECT_MAX_NODES = 8;

// --- Unified Search ---

/**
 * Search across all memory sources for content relevant to the query.
 * Combines: message FTS, graph memory FTS, knowledge vector search, and memories FTS.
 * Results are deduplicated and ranked by relevance.
 */
export async function searchConversationMemory(
  deps: ConversationMemoryDeps,
  query: string,
  options?: {
    maxResults?: number;
    types?: MemoryType[];
    conversationId?: string;
    includeMessages?: boolean;
  },
): Promise<ConversationMemoryResult> {
  const maxResults = options?.maxResults ?? 15;
  const includeMessages = options?.includeMessages !== false;
  const hits: MemorySearchHit[] = [];
  let sourcesSearched = 0;

  // 1. Graph memory FTS — structured facts, decisions, preferences
  if (deps.graph) {
    sourcesSearched++;
    try {
      const nodes = deps.graph.search(query, options?.types, MAX_GRAPH_RESULTS);
      for (const node of nodes) {
        // Boost importance-based relevance
        const relevance = Math.min(1, 0.6 + node.importance * 0.4);
        hits.push({
          content: node.content,
          source: "graph",
          relevance,
          type: node.type,
          timestamp: node.created_at,
          conversationId: node.source_conversation ?? undefined,
        });
      }
    } catch (err) {
      logger.debug(`[conv-memory] Graph search failed: ${err}`);
    }
  }

  // 2. Knowledge vector search — conversation memories embedded with semantic similarity
  if (deps.knowledge && deps.embedder) {
    sourcesSearched++;
    try {
      const embedding = await deps.embedder.embed(query);
      const chunks = deps.knowledge.search(
        embedding,
        MAX_KNOWLEDGE_RESULTS,
        0.60,     // lower threshold for memory recall vs knowledge injection
        undefined,
        undefined,
        query,
      );
      for (const chunk of chunks) {
        // Only include conversation-sourced chunks
        if (chunk.source_path?.startsWith("conversation://") || chunk.category === "conversation-memory") {
          hits.push({
            content: chunk.content,
            source: "knowledge",
            relevance: chunk.similarity ?? 0.7,
            type: chunk.category ?? undefined,
            timestamp: undefined,
          });
        }
      }
    } catch (err) {
      logger.debug(`[conv-memory] Knowledge search failed: ${err}`);
    }
  }

  // 3. Memories FTS — free-form memory entries
  if (deps.memory) {
    sourcesSearched++;
    try {
      const memories = deps.memory.searchMemories(query, MAX_MEMORY_RESULTS);
      for (const mem of memories) {
        hits.push({
          content: mem.content,
          source: "memory",
          relevance: 0.6,
          type: mem.category ?? undefined,
          timestamp: mem.created_at,
        });
      }
    } catch (err) {
      logger.debug(`[conv-memory] Memory FTS failed: ${err}`);
    }
  }

  // 4. Message FTS — full-text search across conversation history
  if (includeMessages && deps.memory) {
    sourcesSearched++;
    try {
      const messages = deps.memory.searchMessages(query, MAX_MESSAGE_RESULTS);
      for (const msg of messages) {
        hits.push({
          content: msg.content.slice(0, 500),
          source: "message",
          relevance: 0.5,
          channel: msg.channel,
          timestamp: msg.created_at,
          conversationId: msg.conversation_id,
        });
      }
    } catch (err) {
      logger.debug(`[conv-memory] Message FTS failed: ${err}`);
    }
  }

  // Deduplicate by content similarity (exact substring match)
  const deduped = deduplicateHits(hits);

  // Sort by relevance descending, then recency
  deduped.sort((a, b) => {
    if (Math.abs(a.relevance - b.relevance) > 0.1) return b.relevance - a.relevance;
    return (b.timestamp ?? 0) - (a.timestamp ?? 0);
  });

  const topResults = deduped.slice(0, maxResults);

  // Format context block
  const contextBlock = formatContextBlock(topResults);

  return { contextBlock, results: topResults, sourcesSearched };
}

// --- Memory Injection ---

/**
 * Build a memory context block for injection into an agent's system prompt.
 * Selects the most important and relevant graph memories for the given conversation.
 * Used automatically when building context for a conversation turn.
 */
export function buildMemoryInjection(
  deps: ConversationMemoryDeps,
  conversationId: string,
  channel: string,
): string | null {
  if (!deps.graph) return null;

  const parts: string[] = [];
  let totalChars = 0;

  // Get high-importance memories first (decisions, preferences, identity)
  const priorityTypes: MemoryType[] = ["decision", "preference", "identity", "goal"];
  const priorityNodes = new Set<number>();

  for (const type of priorityTypes) {
    const nodes = deps.graph.getByType(type, 5);
    for (const node of nodes) {
      if (totalChars >= MEMORY_INJECT_MAX_CHARS) break;
      if (priorityNodes.size >= MEMORY_INJECT_MAX_NODES) break;
      if (node.importance < 0.4) continue;

      const line = `[${node.type}] ${node.content}`;
      parts.push(line);
      totalChars += line.length;
      priorityNodes.add(node.id);

      // Touch node to update access pattern
      deps.graph.touchNode(node.id);
    }
  }

  // Fill remaining space with recent high-importance nodes of any type
  if (totalChars < MEMORY_INJECT_MAX_CHARS && parts.length < MEMORY_INJECT_MAX_NODES) {
    const recent = deps.graph.listNodes(20);
    for (const node of recent) {
      if (totalChars >= MEMORY_INJECT_MAX_CHARS) break;
      if (parts.length >= MEMORY_INJECT_MAX_NODES) break;
      if (priorityNodes.has(node.id)) continue;
      if (node.importance < 0.5) continue;

      const line = `[${node.type}] ${node.content}`;
      parts.push(line);
      totalChars += line.length;
    }
  }

  // Get conversation-specific memories if available
  if (conversationId) {
    try {
      const convMemories = deps.graph.getByConversation(conversationId, 5);
      for (const node of convMemories) {
        if (totalChars >= MEMORY_INJECT_MAX_CHARS) break;
        if (parts.length >= MEMORY_INJECT_MAX_NODES + 3) break; // allow a few extra for conv-specific
        if (priorityNodes.has(node.id)) continue;

        const line = `[${node.type}] ${node.content}`;
        if (!parts.includes(line)) {
          parts.push(line);
          totalChars += line.length;
        }
      }
    } catch {
      // getByConversation may not exist yet — graceful degradation
    }
  }

  if (parts.length === 0) return null;

  return `[Relevant Knowledge]\n${parts.join("\n")}`;
}

// --- Pre-Summarization Memory Flush ---

/**
 * Extract and persist important facts from messages about to be trimmed.
 * Called before conversation summarization to prevent context loss.
 * Uses the same extraction pipeline as regular memory extraction but with
 * a focus on preserving decisions, preferences, and open items.
 */
export async function flushMemoryBeforeSummarization(
  deps: ConversationMemoryDeps,
  router: ProviderRouter,
  conversationId: string,
  channel: string,
  messagesToTrim: StoredMessage[],
): Promise<number> {
  if (!deps.graph || messagesToTrim.length === 0) return 0;

  // Build a focused transcript from the messages about to be removed
  const transcript = messagesToTrim
    .map((m) => `${m.role}: ${m.content.slice(0, 400)}`)
    .join("\n");

  const existingMemories = deps.graph.getExistingSummary(30);

  try {
    const { extractMemories } = await import("./extract.js");
    const extracted = await extractMemories(transcript, existingMemories, router);

    let persisted = 0;
    for (const mem of extracted) {
      const nodeId = deps.graph.addNodeDedup(
        mem.type,
        mem.content,
        { conversationId, channel },
        // Boost importance for pre-summarization saves — these are about to be lost
        Math.min(1, mem.importance + 0.1),
      );
      if (nodeId !== null) persisted++;
    }

    if (persisted > 0) {
      logger.info(`[conv-memory] Pre-summarization flush: saved ${persisted}/${extracted.length} memories from ${messagesToTrim.length} messages in ${conversationId}`);
    }

    return persisted;
  } catch (err) {
    logger.warn(`[conv-memory] Pre-summarization flush failed for ${conversationId}: ${err}`);
    return 0;
  }
}

// --- Helpers ---

function deduplicateHits(hits: MemorySearchHit[]): MemorySearchHit[] {
  const seen = new Set<string>();
  const result: MemorySearchHit[] = [];

  for (const hit of hits) {
    // Normalize for dedup: lowercase, trim, first 100 chars
    const key = hit.content.toLowerCase().trim().slice(0, 100);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(hit);
  }

  return result;
}

function formatContextBlock(hits: MemorySearchHit[]): string | null {
  if (hits.length === 0) return null;

  const lines = hits.map((hit) => {
    const source = hit.source === "graph" ? (hit.type ?? "memory") : hit.source;
    const timeStr = hit.timestamp
      ? ` (${new Date(hit.timestamp).toISOString().split("T")[0]})`
      : "";
    return `[${source}${timeStr}] ${hit.content.slice(0, 300)}`;
  });

  return `[Conversation Memory]\n${lines.join("\n")}`;
}

import { logger } from "../utils/logger.js";
import type { GraphMemory } from "../memory/graph.js";
import type { KnowledgeStore } from "../memory/knowledge.js";
import type { EmbeddingProvider } from "../memory/embeddings.js";
import type { ProviderRouter } from "../providers/router.js";

// --- Semantic dedup helpers ---

export interface SemanticMatch {
  nodeId: number | null;
  similarity: number;
}

export interface KnowledgeBridgeMemory {
  type: string;
  content: string;
  importance: number;
  source: "llm" | "heuristic" | "pattern";
}

export interface KnowledgeBridgePlanEntry {
  text: string;
  type: string;
  content: string;
  hash: string;
  section: string;
  sourcePath: string;
  priority: number;
}

export function shouldSkipMemoryExtraction(channel: string, sender: string): boolean {
  const normalizedChannel = channel.trim().toLowerCase();
  const normalizedSender = sender.trim().toLowerCase();
  return normalizedChannel === "system"
    || normalizedSender === "system"
    || normalizedSender.startsWith("scheduler:")
    || normalizedSender.startsWith("proposal-");
}

export async function buildKnowledgeBridgePlan(
  memories: KnowledgeBridgeMemory[],
  existingHashes: Map<string, string>,
  convId: string,
): Promise<KnowledgeBridgePlanEntry[]> {
  if (memories.length === 0) return [];

  const { createHash } = await import("node:crypto");
  const sourcePath = `conversation://${convId}`;
  const seenKeys = new Set<string>();
  const plan: KnowledgeBridgePlanEntry[] = [];

  for (const mem of memories) {
    const hash = createHash("md5").update(mem.content).digest("hex");
    const section = `${mem.type}:${hash.slice(0, 8)}`;
    const key = `${sourcePath}::${section}::0`;
    if (seenKeys.has(key) || existingHashes.has(key)) {
      continue;
    }
    seenKeys.add(key);
    plan.push({
      text: `[${mem.type}] ${mem.content}`,
      type: mem.type,
      content: mem.content,
      hash,
      section,
      sourcePath,
      priority: mem.importance >= 0.8 ? 2 : 1,
    });
  }

  return plan;
}

/**
 * Search the knowledge store for semantically similar content.
 * Returns the graph node ID of the best match and its similarity score.
 * Falls back to { nodeId: null, similarity: 0 } on failure or no match.
 */
export async function findSemanticMatch(
  content: string,
  knowledgeStore: KnowledgeStore | undefined,
  embedder: EmbeddingProvider | undefined,
  graphMemory: GraphMemory,
): Promise<SemanticMatch> {
  if (!knowledgeStore || !embedder) return { nodeId: null, similarity: 0 };
  try {
    const embedding = await embedder.embed(content);
    const results = knowledgeStore.search(embedding, 5, 0.75, undefined, undefined, content);
    for (const result of results) {
      // Map the knowledge chunk back to its graph node via content match.
      // The top semantic result may point at a stale/orphaned chunk; keep walking
      // until we find one that still maps back into graph memory.
      const graphNodes = graphMemory.findByContent([result.content]);
      if (graphNodes.length > 0) {
        return { nodeId: graphNodes[0].id, similarity: result.similarity ?? 0 };
      }
    }
  } catch { /* embedding failure — proceed with standalone insert */ }
  return { nodeId: null, similarity: 0 };
}

/**
 * Handle a semantic match result:
 * - similarity >= 0.88: bump existing node's mention count, return true (skip insertion)
 * - similarity 0.75-0.88: add "related_to" edge to existing node, return false (still insert)
 * - no match: return false (insert as normal)
 */
export function handleSemanticMatch(
  match: SemanticMatch,
  newNodeId: number | null,
  graph: GraphMemory,
): boolean {
  if (!match.nodeId) return false;
  if (match.similarity >= 0.88) {
    graph.bumpMentionCount(match.nodeId);
    return true; // signal: skip insertion
  }
  if (match.similarity >= 0.75 && newNodeId) {
    graph.addEdge(newNodeId, match.nodeId, "related_to");
    return false;
  }
  return false;
}

// --- Cross-conversation linking ---

const STOP_WORDS = new Set([
  "the", "and", "for", "are", "but", "not", "you", "all", "can", "had", "her",
  "was", "one", "our", "out", "has", "have", "from", "this", "that", "with",
  "they", "been", "said", "each", "which", "their", "will", "other", "about",
  "many", "then", "them", "these", "some", "would", "make", "like", "into",
  "time", "very", "when", "come", "could", "more", "than", "been", "just",
  "also", "what", "does", "should", "using", "used", "file", "added", "updated",
]);

/**
 * Extract 3-4 significant keywords from content for FTS matching.
 * Picks the longest non-stopword tokens.
 */
export function extractKeywords(content: string): string | null {
  const words = content
    .replace(/[^a-zA-Z0-9_-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOP_WORDS.has(w.toLowerCase()))
    .map((w) => w.toLowerCase());

  // Deduplicate
  const unique = [...new Set(words)];
  if (unique.length === 0) return null;

  // Pick top 4 longest words (more distinctive)
  unique.sort((a, b) => b.length - a.length);
  const top = unique.slice(0, 4);

  // FTS5 OR query — quote each term
  return top.map((w) => `"${w}"`).join(" OR ");
}

/**
 * After extracting memories, search the graph for similar nodes from OTHER
 * conversations and create "related_to" edges between them.
 * Enables "you hit this same issue 2 weeks ago in a different thread."
 */
export function crossLinkMemories(
  graph: GraphMemory,
  convId: string,
  newNodeIds: number[],
): void {
  for (const nodeId of newNodeIds) {
    const node = graph.getNode(nodeId);
    if (!node) continue;

    const keywords = extractKeywords(node.content);
    if (!keywords) continue;

    try {
      const crossMatches = graph.searchAcrossConversations(convId, keywords, 3);
      for (const match of crossMatches) {
        graph.addEdge(nodeId, match.id, "related_to");
        graph.bumpMentionCount(nodeId);
        graph.bumpMentionCount(match.id);
      }
    } catch {
      // FTS query failures are non-fatal
    }
  }
}

export interface MemoryExtractionDeps {
  graphMemory?: GraphMemory;
  knowledge?: KnowledgeStore;
  embedder?: EmbeddingProvider;
  router?: ProviderRouter;
  /** Rate limiter map — processor owns this, passed by reference so mutations persist */
  lastExtractionAt: Map<string, number>;
}

/**
 * Extract and persist memories from a completed conversation turn.
 * Rate limited to 1 extraction per conversation per 5 minutes.
 * Only runs for top-level user messages (not scheduler/system tasks).
 */
export async function extractAndPersistMemories(
  deps: MemoryExtractionDeps,
  convId: string,
  agentKey: string,
  userMessage: string,
  assistantResponse: string,
  channel: string,
  sender: string,
): Promise<void> {
  const graphMemory = deps.graphMemory;
  const router = deps.router;
  if (!graphMemory || !router) return;

  if (shouldSkipMemoryExtraction(channel, sender)) return;

  // Rate limit: 1 extraction per conversation per 5 minutes
  const now = Date.now();
  const lastExtract = deps.lastExtractionAt.get(convId) ?? 0;
  if (now - lastExtract < 5 * 60 * 1000) return;

  // Mark rate limit immediately — even if extraction finds nothing, the LLM call
  // was already spent. Without this, zero-result extractions don't rate-limit,
  // causing redundant LLM calls on every subsequent message.
  deps.lastExtractionAt.set(convId, now);

  try {
    // Track all newly created node IDs for cross-conversation linking
    const newNodeIds: number[] = [];

    // Phase 1: Heuristic auto-extraction (cheap, no LLM calls, deduped)
    const { autoExtract } = await import("../memory/auto-extractor.js");
    const autoNodes = autoExtract(assistantResponse);
    let autoInserted = 0;
    for (const node of autoNodes) {
      // Semantic dedup: check knowledge store for similar existing memories
      const match = await findSemanticMatch(node.content, deps.knowledge, deps.embedder, graphMemory);
      if (match.similarity >= 0.88) {
        handleSemanticMatch(match, null, graphMemory);
        continue; // skip insertion — bumped existing node
      }
      const newId = graphMemory.addNodeDedup(node.type, node.content, { conversationId: convId, channel }, node.importance);
      if (newId !== null) {
        newNodeIds.push(newId);
        // Near-match: link to related existing node
        if (match.similarity >= 0.75) {
          handleSemanticMatch(match, newId, graphMemory);
        }
        autoInserted++;
      }
    }
    if (autoInserted > 0) {
      logger.info(`[processor] Auto-extracted ${autoInserted}/${autoNodes.length} nodes from ${convId} (${autoNodes.length - autoInserted} deduped)`);
    }

    // Phase 4: Learning triggers — cross-conversation pattern extraction (deduped)
    const { extractLearningTriggers } = await import("../memory/learning-triggers.js");
    const learnedPatterns = extractLearningTriggers(assistantResponse, agentKey);
    let patternsInserted = 0;
    for (const pattern of learnedPatterns) {
      // Semantic dedup: check knowledge store for similar existing memories
      const match = await findSemanticMatch(pattern.content, deps.knowledge, deps.embedder, graphMemory);
      if (match.similarity >= 0.88) {
        handleSemanticMatch(match, null, graphMemory);
        continue; // skip insertion — bumped existing node
      }
      const newId = graphMemory.addNodeDedup(pattern.type, pattern.content, { conversationId: convId, channel }, pattern.importance);
      if (newId !== null) {
        newNodeIds.push(newId);
        if (match.similarity >= 0.75) {
          handleSemanticMatch(match, newId, graphMemory);
        }
        patternsInserted++;
      }
    }
    if (patternsInserted > 0) {
      logger.info(`[processor] Learning triggers: extracted ${patternsInserted} patterns from ${agentKey} in ${convId}`);
    }

    // Phase 2: LLM-based extraction (deeper semantic understanding)
    const { extractMemories } = await import("../memory/extract.js");

    const transcript = `User: ${userMessage}\n\nAssistant: ${assistantResponse}`;
    const existing = graphMemory.getExistingSummary(30);

    const memories = await extractMemories(transcript, existing, router);

    for (const mem of memories) {
      // Semantic dedup: check knowledge store for similar existing memories
      const match = await findSemanticMatch(mem.content, deps.knowledge, deps.embedder, graphMemory);
      if (match.similarity >= 0.88) {
        handleSemanticMatch(match, null, graphMemory);
        continue; // skip insertion — bumped existing node
      }

      // Check for updates (superseding existing memories)
      if (mem.updates) {
        const similar = graphMemory.findSimilar(mem.type, mem.updates, 3);
        const newId = graphMemory.addNode(mem.type, mem.content, { conversationId: convId, channel }, mem.importance);
        newNodeIds.push(newId);
        for (const old of similar) {
          graphMemory.addEdge(newId, old.id, "updates");
        }
        if (match.similarity >= 0.75) {
          handleSemanticMatch(match, newId, graphMemory);
        }
      } else {
        const newId = graphMemory.addNodeDedup(mem.type, mem.content, { conversationId: convId, channel }, mem.importance);
        if (newId !== null) {
          newNodeIds.push(newId);
          if (match.similarity >= 0.75) {
            handleSemanticMatch(match, newId, graphMemory);
          }
        }
      }
    }

    const totalExtracted = autoInserted + patternsInserted + memories.length;
    if (totalExtracted > 0) {
      logger.info(`[processor] Extracted ${totalExtracted} total memories from ${convId} (${autoInserted} heuristic, ${patternsInserted} patterns, ${memories.length} LLM)`);

      // Bridge: embed extracted memories into KnowledgeStore for semantic retrieval
      if (deps.knowledge && deps.embedder) {
        await bridgeToKnowledgeStore(deps.knowledge, deps.embedder, memories, autoNodes, learnedPatterns, convId, agentKey);
      }
    }

    // Cross-conversation linking: connect new nodes to similar nodes from other conversations
    if (newNodeIds.length > 0) {
      crossLinkMemories(graphMemory, convId, newNodeIds);
    }
  } catch (err) {
    logger.warn(`[processor] Memory extraction failed for ${convId}: ${err}`);
  }
}

/**
 * Embed extracted conversation memories into KnowledgeStore so they're
 * retrievable via semantic search (search_knowledge MCP tool).
 * Groups all new memories into a single batch embed call for efficiency.
 */
async function bridgeToKnowledgeStore(
  knowledge: KnowledgeStore,
  embedder: EmbeddingProvider,
  llmMemories: Array<{ type: string; content: string; importance: number }>,
  autoMemories: Array<{ type: string; content: string; importance: number }>,
  patternMemories: Array<{ type: string; content: string; importance: number }>,
  convId: string,
  agentKey: string,
): Promise<void> {
  // Collect all unique memories to embed
  const allMemories: KnowledgeBridgeMemory[] = [
    ...llmMemories.map((m): KnowledgeBridgeMemory => ({ ...m, source: "llm" })),
    ...autoMemories.map((m): KnowledgeBridgeMemory => ({ ...m, source: "heuristic" })),
    ...patternMemories.map((m): KnowledgeBridgeMemory => ({ ...m, source: "pattern" })),
  ];

  if (allMemories.length === 0) return;

  const existingHashes = knowledge.getExistingHashes();
  const plan = await buildKnowledgeBridgePlan(allMemories, existingHashes, convId);
  if (plan.length === 0) return;

  try {
    const texts = plan.map((entry) => entry.text);
    const embeddings = await embedder.embedBatch(texts);

    for (let i = 0; i < plan.length; i++) {
      const entry = plan[i];
      const embedding = embeddings[i];
      if (!embedding) {
        logger.warn(`[memory-bridge] Missing embedding ${i + 1}/${plan.length} for ${entry.sourcePath}#${entry.section}`);
        continue;
      }

      knowledge.upsertChunk(
        "conversation-memory",
        entry.section,
        entry.content,
        entry.type,
        entry.sourcePath,
        entry.hash,
        embedding,
        "global",
        entry.priority,
        agentKey,
      );
    }

    logger.info(`[memory-bridge] Embedded ${plan.length} conversation memories into knowledge store from ${convId}`);
  } catch (err) {
    logger.warn(`[memory-bridge] Failed to bridge memories to knowledge store: ${err}`);
  }
}

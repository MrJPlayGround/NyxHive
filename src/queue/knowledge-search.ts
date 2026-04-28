import { logger } from "../utils/logger.js";
import type { KnowledgeStore, KnowledgeChunk, KnowledgeTaskContext } from "../memory/knowledge.js";
import type { EmbeddingProvider } from "../memory/embeddings.js";
import type { GraphMemory } from "../memory/graph.js";
import type { EdgeType } from "../types.js";
import type { MemoryStore } from "../memory/store.js";
import type { ChunkTrace, GraphExpansionTrace, MemoryLane, RetrievalTrace } from "../memory/retrieval-trace.js";
import { buildKnowledgeArtifactSourceUri, hashContextSource } from "../memory/retrieval-trace.js";

export interface RemoteInstance {
  url: string;
  api_key_env: string;
}

export interface KnowledgeSearchDeps {
  knowledge?: KnowledgeStore;
  embedder?: EmbeddingProvider;
  graph?: GraphMemory;
  memory?: MemoryStore;
  remotes?: Record<string, RemoteInstance>;
}

export interface GraphExpansionResult {
  nodeId: number;
  content: string;
  type: string;
  importance: number;
  edgeType: EdgeType;
  hopDistance: 1 | 2;
  isContradiction: boolean;
  /** Relevance weight based on hop distance: 1.0 for hop-1, 0.4 for hop-2 */
  _hopWeight: number;
}

const SHORT_MSG_THRESHOLD = 80;
const EMBED_TIMEOUT_MS = 10_000;
const BASE_THRESHOLD = 0.50;
const RELEVANCE_GATE = 0.72;
const SIBLING_GATE = 0.55;
/** If the top result is below this, inject nothing rather than noise. */
const CONFIDENCE_FLOOR = 0.65;

function buildKnowledgeQuery(message: string, conversationContext?: string): { query: string; enriched: boolean } {
  if (message.length < SHORT_MSG_THRESHOLD && conversationContext) {
    return {
      query: `${conversationContext.slice(0, 300)}\n\n${message}`,
      enriched: true,
    };
  }
  return { query: message, enriched: false };
}

function createEmptyTrace(query: string, enriched: boolean): RetrievalTrace {
  return {
    query,
    enriched,
    candidateCount: 0,
    passedGateCount: 0,
    injectedCount: 0,
    chunks: [],
    graphNodesAdded: 0,
    durationMs: 0,
    timestamp: Date.now(),
  };
}

function expandWithGraphContextDetailed(
  graph: GraphMemory | undefined,
  knowledgeChunks: Array<{ chunkId: number; content: string }>,
  maxResults = 15,
): { results: GraphExpansionResult[]; byChunk: Map<number, GraphExpansionTrace[]> } {
  if (!graph || knowledgeChunks.length === 0) return { results: [], byChunk: new Map() };

  const seedContent = new Set(knowledgeChunks.map((chunk) => chunk.content.toLowerCase()));
  const resultMap = new Map<number, GraphExpansionResult>();
  const byChunk = new Map<number, GraphExpansionTrace[]>();

  const registerExpansion = (
    chunkId: number,
    nodeId: number,
    content: string,
    type: string,
    importance: number,
    edgeType: EdgeType,
    hopDistance: 1 | 2,
  ): void => {
    const traces = byChunk.get(chunkId) ?? [];
    if (!traces.some((trace) => trace.nodeId === nodeId)) {
      traces.push({ nodeId, content, edgeType, hopDistance, memoryLane: "graph_memory" });
      byChunk.set(chunkId, traces);
    }

    if (resultMap.has(nodeId) || seedContent.has(content.toLowerCase())) return;
    resultMap.set(nodeId, {
      nodeId,
      content,
      type,
      importance,
      edgeType,
      hopDistance,
      isContradiction: edgeType === "contradicts",
      _hopWeight: hopDistance === 1 ? 1.0 : 0.4,
    });
  };

  for (const chunk of knowledgeChunks) {
    const matchedNodes = graph.findByContent([chunk.content]);
    if (matchedNodes.length === 0) continue;

    const localSeenIds = new Set<number>(matchedNodes.map((node) => node.id));
    const localSeenContent = new Set<string>([chunk.content.toLowerCase()]);
    const supersededIds = new Set<number>();
    const hop1Ids: number[] = [];

    for (const node of matchedNodes) {
      const related = graph.getRelated(node.id);
      for (const { node: relNode, edge } of related) {
        if (edge === "supersedes") {
          supersededIds.add(relNode.id);
          continue;
        }
        if (localSeenIds.has(relNode.id) || localSeenContent.has(relNode.content.toLowerCase())) continue;
        localSeenIds.add(relNode.id);
        localSeenContent.add(relNode.content.toLowerCase());
        hop1Ids.push(relNode.id);
        registerExpansion(chunk.chunkId, relNode.id, relNode.content, relNode.type, relNode.importance, edge, 1);
      }
    }

    if (hop1Ids.length >= 10) continue;
    for (const hop1Id of hop1Ids) {
      if (resultMap.size >= maxResults) break;
      const related = graph.getRelated(hop1Id);
      for (const { node: relNode, edge } of related) {
        if (resultMap.size >= maxResults) break;
        if (edge === "supersedes" || supersededIds.has(relNode.id)) continue;
        if (relNode.importance <= 0.3) continue;
        if (localSeenIds.has(relNode.id) || localSeenContent.has(relNode.content.toLowerCase())) continue;
        localSeenIds.add(relNode.id);
        localSeenContent.add(relNode.content.toLowerCase());
        registerExpansion(chunk.chunkId, relNode.id, relNode.content, relNode.type, relNode.importance, edge, 2);
      }
    }
  }

  const results = Array.from(resultMap.values())
    .sort((a, b) => {
      if (a.isContradiction !== b.isContradiction) return a.isContradiction ? -1 : 1;
      return b.importance - a.importance;
    })
    .slice(0, maxResults);

  return { results, byChunk };
}

export function expandWithGraphContext(
  graph: GraphMemory | undefined,
  knowledgeContents: string[],
  maxResults = 15,
): GraphExpansionResult[] {
  return expandWithGraphContextDetailed(
    graph,
    knowledgeContents.map((content, index) => ({ chunkId: index, content })),
    maxResults,
  ).results;
}

export interface KnowledgeSearchResult {
  context: string | null;
  /** IDs of injected chunks, for post-response feedback tracking. */
  chunkIds: number[];
  /** Content snippets keyed by chunk ID, for reference detection. */
  chunkSnippets: Map<number, string>;
  trace: RetrievalTrace;
}

function formatKnowledgeChunk(
  chunk: KnowledgeChunk,
  overview?: string | null,
): string {
  const link = chunk.section ? `[[${chunk.title}#${chunk.section}]]` : `[[${chunk.title}]]`;
  const cat = chunk.category ? ` -- ${chunk.category}` : "";
  const agent = chunk.source_agent ? ` (from ${chunk.source_agent})` : "";
  const status = chunk.decision_status ? ` [${chunk.decision_status}]` : "";
  const parts = [`[Source: ${link}${cat}${agent}${status}]`];
  if (overview) {
    parts.push(`[Overview]\n${overview.slice(0, 500)}`);
  }
  parts.push(chunk.content.slice(0, 400));
  return parts.join("\n");
}

function finalizeTrace(trace: RetrievalTrace, startedAt: number): RetrievalTrace {
  trace.passedGateCount = trace.chunks.filter((chunk) => chunk.passedGate).length;
  trace.injectedCount = trace.chunks.filter((chunk) => chunk.injected).length;
  trace.memoryLanesInjected = collectInjectedLanes(trace);
  trace.durationMs = Math.round(performance.now() - startedAt);
  return trace;
}

function collectInjectedLanes(trace: RetrievalTrace): MemoryLane[] {
  const lanes = new Set<MemoryLane>();
  for (const chunk of trace.chunks) {
    if (chunk.injected && chunk.memoryLane) lanes.add(chunk.memoryLane);
    if (chunk.graphExpansion?.length) lanes.add("graph_memory");
  }
  if (trace.graphNodesAdded > 0) lanes.add("graph_memory");
  return Array.from(lanes);
}

function ensureTraceEntry(
  traceMap: Map<number, ChunkTrace>,
  chunk: KnowledgeChunk,
  similarity: number,
  retrievalSource: "vector_search" | "path_tree_expansion",
): ChunkTrace {
  const existing = traceMap.get(chunk.id);
  if (existing) return existing;
  const entry: ChunkTrace = {
    chunkId: chunk.id,
    title: chunk.title,
    section: chunk.section ?? undefined,
    similarity,
    passedGate: false,
    injected: false,
    retrievalSource,
    memoryLane: "knowledge_chunk",
  };
  traceMap.set(chunk.id, entry);
  return entry;
}

/**
 * Search knowledge store for context relevant to a message.
 * When conversationContext is provided and the message is short/ambiguous,
 * enriches the embedding query to improve retrieval on follow-up messages.
 */
export async function searchKnowledge(
  deps: KnowledgeSearchDeps,
  message: string,
  conversationContext?: string,
  taskContext?: KnowledgeTaskContext,
): Promise<string | null> {
  const result = await searchKnowledgeWithChunks(deps, message, conversationContext, taskContext);
  return result.context;
}

/**
 * Search knowledge with chunk tracking for feedback loop.
 * Returns both formatted context and chunk metadata.
 */
export async function searchKnowledgeWithChunks(
  deps: KnowledgeSearchDeps,
  message: string,
  conversationContext?: string,
  taskContext?: KnowledgeTaskContext,
): Promise<KnowledgeSearchResult> {
  const { query, enriched } = buildKnowledgeQuery(message, conversationContext);
  const startedAt = performance.now();
  const trace = createEmptyTrace(query, enriched);
  const empty: KnowledgeSearchResult = { context: null, chunkIds: [], chunkSnippets: new Map(), trace };
  if (!deps.knowledge || !deps.embedder) {
    return { ...empty, trace: finalizeTrace(trace, startedAt) };
  }

  try {
    const embedding = await Promise.race([
      deps.embedder.embed(query),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Embedding timed out after 10s")), EMBED_TIMEOUT_MS),
      ),
    ]);
    const search = typeof (deps.knowledge as KnowledgeStore & { searchDetailed?: unknown }).searchDetailed === "function"
      ? deps.knowledge.searchDetailed(embedding, 3, BASE_THRESHOLD, undefined, undefined, query, taskContext)
      : (() => {
          const results = deps.knowledge!.search(embedding, 3, BASE_THRESHOLD, undefined, undefined, query, taskContext);
          return {
            results,
            stats: {
              strategy: "full_scan" as const,
              scannedCount: results.length,
              rerankedCount: results.length,
            },
          };
        })();
    const results = search.results;
    trace.candidateCount = search.stats.rerankedCount;
    trace.scannedCount = search.stats.scannedCount;
    trace.rerankedCount = search.stats.rerankedCount;
    trace.strategy = search.stats.strategy;
    if (results.length === 0) {
      return { ...empty, trace: finalizeTrace(trace, startedAt) };
    }

    // Confidence floor: if best result is too low, inject nothing rather than noise
    const topScore = results[0]?.similarity ?? 0;
    if (topScore < CONFIDENCE_FLOOR) {
      logger.debug(`[knowledge] Confidence floor: top result ${topScore.toFixed(3)} < ${CONFIDENCE_FLOOR}, skipping injection`);
      return { ...empty, trace: finalizeTrace(trace, startedAt) };
    }

    const traceMap = new Map<number, ChunkTrace>();
    for (const result of results) {
      const entry = ensureTraceEntry(traceMap, result, result.similarity ?? 0, "vector_search");
      if ((result.similarity ?? 0) >= RELEVANCE_GATE) {
        entry.passedGate = true;
      } else {
        entry.cutReason = "gate";
      }
    }

    const relevant = results.filter((result) => (result.similarity ?? 0) >= RELEVANCE_GATE);
    const filtered = results.filter((result) => (result.similarity ?? 0) < RELEVANCE_GATE);
    if (filtered.length > 0) {
      logger.debug(
        `[knowledge] Injection gate: ${relevant.length} passed, ${filtered.length} filtered (top filtered: ${filtered[0]?.similarity?.toFixed(3) ?? "?"}, gate: ${RELEVANCE_GATE})`,
      );
    }

    // Federation: query remote instances when local results are thin
    if (relevant.length < 2 && deps.remotes) {
      const remoteChunks = await queryRemoteKnowledge(query, deps.remotes);
      if (remoteChunks.length > 0) {
        logger.info(`[knowledge] Federation: ${remoteChunks.length} chunks from remote instances`);
        for (const chunk of remoteChunks) {
          // Treat remote chunks as passing the gate (they were pre-filtered by the remote)
          relevant.push(chunk);
          ensureTraceEntry(traceMap, chunk, chunk.similarity ?? 0.7, "vector_search");
        }
      }
    }

    if (relevant.length === 0) {
      trace.chunks = Array.from(traceMap.values());
      if (results[0]?.similarity !== undefined) {
        logger.debug(`[knowledge] ${results.length} results below relevance gate (top: ${results[0].similarity.toFixed(3)})`);
      }
      return { ...empty, trace: finalizeTrace(trace, startedAt) };
    }

    const injectedChunks = new Map<number, KnowledgeChunk>();
    for (const chunk of relevant) injectedChunks.set(chunk.id, chunk);

    const grouped = new Map<string, KnowledgeChunk[]>();
    for (const chunk of relevant) {
      const groupKey = `${chunk.source_path}::${chunk.title}`;
      const list = grouped.get(groupKey) ?? [];
      list.push(chunk);
      grouped.set(groupKey, list);
    }

    const siblingSeeds = Array.from(grouped.values())
      .filter((siblingsOfTitle) => siblingsOfTitle.length >= 2)
      .map((siblingsOfTitle) => siblingsOfTitle
        .slice()
        .sort((a, b) => (b.similarity ?? 0) - (a.similarity ?? 0))[0]);
    const siblingMatches = typeof (deps.knowledge as KnowledgeStore & { getSiblingMatches?: unknown }).getSiblingMatches === "function"
      ? deps.knowledge.getSiblingMatches(
          embedding,
          siblingSeeds.map((seed) => seed.id),
          3,
        )
      : new Map<number, Array<KnowledgeChunk & { similarity: number }>>();

    for (const seed of siblingSeeds) {
      const siblings = siblingMatches.get(seed.id) ?? [];
      for (const sibling of siblings) {
        const siblingSimilarity = sibling.similarity ?? 0;
        const siblingEntry = ensureTraceEntry(traceMap, sibling, siblingSimilarity, "path_tree_expansion");
        if (injectedChunks.has(sibling.id)) {
          siblingEntry.passedGate = true;
          siblingEntry.injected = true;
          siblingEntry.cutReason = undefined;
          continue;
        }
        if (siblingSimilarity >= SIBLING_GATE) {
          siblingEntry.passedGate = true;
          injectedChunks.set(sibling.id, { ...sibling, similarity: siblingSimilarity });
        } else {
          siblingEntry.cutReason = "gate";
        }
      }
    }

    const chunkIds: number[] = [];
    const chunkSnippets = new Map<number, string>();
    const formattedChunks: string[] = [];
    const injectedList = Array.from(injectedChunks.values());

    for (const chunk of injectedList) {
      const traceEntry = ensureTraceEntry(
        traceMap,
        chunk,
        chunk.similarity ?? 0,
        traceMap.get(chunk.id)?.retrievalSource ?? "vector_search",
      );
      traceEntry.passedGate = true;
      traceEntry.injected = true;
      traceEntry.cutReason = undefined;
      chunkIds.push(chunk.id);
      chunkSnippets.set(chunk.id, chunk.content.slice(0, 200));

      const sourceUri = buildKnowledgeArtifactSourceUri(chunk.id);
      const sourceHash = hashContextSource(chunk.content);
      const artifact = deps.memory?.getContextArtifact(sourceUri);
      const overview = artifact
        && artifact.is_stale !== 1
        && artifact.source_hash === sourceHash
        ? artifact.l1_overview
        : null;

      if (!overview && deps.memory?.touchContextArtifactSource({
        sourceUri,
        sourceType: "knowledge_chunk",
        sourceKind: "imported_docs",
        sourceLabel: chunk.section ? `${chunk.title}#${chunk.section}` : chunk.title,
        sourceHash,
      })) {
        deps.memory.enqueueContextArtifactJob({
          sourceUri,
          sourceType: "knowledge_chunk",
          sourceKind: "imported_docs",
          sourceLabel: chunk.section ? `${chunk.title}#${chunk.section}` : chunk.title,
          content: chunk.content,
          priority: 1,
        });
      }

      formattedChunks.push(formatKnowledgeChunk(chunk, overview));
    }

    const graphExpansion = expandWithGraphContextDetailed(
      deps.graph,
      injectedList.map((chunk) => ({ chunkId: chunk.id, content: chunk.content.slice(0, 400) })),
    );

    for (const [chunkId, expansions] of graphExpansion.byChunk) {
      const chunkTrace = traceMap.get(chunkId);
      if (chunkTrace && expansions.length > 0) {
        chunkTrace.graphExpansion = expansions;
      }
    }

    const graphLines = graphExpansion.results.map((result) => {
      const prefix = result.isContradiction ? "[WARNING — contradicts retrieved knowledge]" : `[Related ${result.type}]`;
      return `${prefix}\n${result.content}`;
    });

    trace.graphNodesAdded = graphExpansion.results.length;
    trace.chunks = Array.from(traceMap.values())
      .sort((a, b) => b.similarity - a.similarity);

    const context = graphLines.length > 0
      ? `${formattedChunks.join("\n\n")}\n\n${graphLines.join("\n\n")}`
      : formattedChunks.join("\n\n");

    return {
      context,
      chunkIds,
      chunkSnippets,
      trace: finalizeTrace(trace, startedAt),
    };
  } catch (err) {
    logger.warn(`[processor] Knowledge search with chunks failed: ${err}`);
    return { ...empty, trace: finalizeTrace(trace, startedAt) };
  }
}

/**
 * Post-response feedback: check which injected chunks were referenced by the agent.
 * Boosts confidence of used chunks, slightly decays ignored ones.
 */
export function applyRetrievalFeedback(
  knowledge: KnowledgeStore,
  chunkSnippets: Map<number, string>,
  response: string,
): void {
  if (chunkSnippets.size === 0) return;

  const responseLower = response.toLowerCase();
  let used = 0;
  let ignored = 0;

  for (const [chunkId, snippet] of chunkSnippets) {
    // Extract meaningful keywords from the snippet (4+ char words)
    const words = snippet.toLowerCase().split(/\s+/).filter(w => w.length >= 4);
    // Check if at least 30% of keywords appear in the response
    const matchCount = words.filter(w => responseLower.includes(w)).length;
    const matchRatio = words.length > 0 ? matchCount / words.length : 0;

    if (matchRatio >= 0.3) {
      knowledge.nudgeConfidence(chunkId, 0.02); // Small boost
      used++;
    } else {
      knowledge.nudgeConfidence(chunkId, -0.01); // Tiny decay
      ignored++;
    }
  }

  if (used > 0 || ignored > 0) {
    logger.debug(`[knowledge] Retrieval feedback: ${used} used, ${ignored} ignored`);
  }
}

/**
 * Merge parent (broad) and task-specific knowledge contexts.
 * Deduplicates by source link and caps total at 2000 chars.
 */
export function mergeKnowledgeContext(parent: string | null, task: string | null): string | null {
  if (!parent && !task) return null;
  if (!parent) return task;
  if (!task) return parent;

  // Deduplicate by source link — each chunk starts with [Source: ...]
  const seen = new Set<string>();
  const chunks: string[] = [];

  for (const ctx of [parent, task]) {
    for (const chunk of ctx.split("\n\n")) {
      const sourceMatch = chunk.match(/\[Source:\s*([^\]]+)\]/);
      const key = sourceMatch?.[1] ?? chunk.slice(0, 80);
      if (!seen.has(key)) {
        seen.add(key);
        chunks.push(chunk);
      }
    }
  }

  const merged = chunks.join("\n\n");
  return merged.length > 2000 ? merged.slice(0, 2000) : merged;
}

/**
 * Query remote NyxHive instances for shareable knowledge chunks.
 * Fails silently per-remote — unavailable remotes don't block local results.
 */
async function queryRemoteKnowledge(
  query: string,
  remotes: Record<string, RemoteInstance>,
): Promise<KnowledgeChunk[]> {
  const results: KnowledgeChunk[] = [];
  const seenHashes = new Set<string>();

  const promises = Object.entries(remotes).map(async ([_name, remote]) => {
    const apiKey = process.env[remote.api_key_env];
    if (!apiKey) return;

    try {
      const res = await fetch(`${remote.url}/api/knowledge/federated-search`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ query, limit: 3 }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return;
      const data = await res.json() as { results: KnowledgeChunk[]; instance: string };
      for (const chunk of data.results) {
        if (seenHashes.has(chunk.content_hash)) continue;
        seenHashes.add(chunk.content_hash);
        chunk.source_path = `[${data.instance}] ${chunk.source_path}`;
        results.push(chunk);
      }
    } catch {
      // Silent — remote unavailable is not an error
    }
  });

  await Promise.all(promises);
  return results;
}

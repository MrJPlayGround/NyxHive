import { createHash } from "node:crypto";

export type ChunkCutReason = "token_budget" | "gate" | "dedup";
export type AssemblyCutReason = "token_budget" | "disabled" | "empty";
export type RetrievalSource = "vector_search" | "path_tree_expansion";
export type MemoryLane =
  | "conversation_recent"
  | "conversation_summary"
  | "durable_user_preference"
  | "graph_memory"
  | "knowledge_chunk"
  | "compiled_digest"
  | "procedural_memory"
  | "routing_history"
  | "outcome_pattern"
  | "context_artifact";
export type ContextArtifactSourceType = "knowledge_chunk" | "thread_archive" | "repo_doc";
export type ContextSourceKind =
  | "live_transcript"
  | "imported_chat"
  | "imported_docs"
  | "manual_notes"
  | "extracted_graph_fact"
  | "summary_artifact"
  | "retrieval_artifact";
export type MemoryBeliefType =
  | "user_stated_fact"
  | "inferred_preference"
  | "assistant_observation"
  | "workflow_procedure"
  | "temporary_context"
  | "durable_context"
  | "superseded_fact"
  | "uncertain_belief";
export type MemoryCurrentness = "current" | "stale" | "superseded" | "expired" | "uncertain";
export type MemorySourceReliability = "user_confirmed" | "user_stated" | "assistant_inferred" | "system_observed" | "imported";

export interface GraphExpansionTrace {
  nodeId: number;
  content: string;
  edgeType: string;
  hopDistance: 1 | 2;
  memoryLane?: MemoryLane;
}

export interface ChunkTrace {
  chunkId: number;
  title: string;
  section?: string;
  similarity: number;
  passedGate: boolean;
  injected: boolean;
  cutReason?: ChunkCutReason;
  retrievalSource?: RetrievalSource;
  memoryLane?: MemoryLane;
  currentness?: MemoryCurrentness;
  confidence?: number;
  sourceReliability?: MemorySourceReliability;
  trustReason?: string;
  graphExpansion?: GraphExpansionTrace[];
}

export interface RetrievalTrace {
  query: string;
  enriched: boolean;
  candidateCount: number;
  scannedCount?: number;
  rerankedCount?: number;
  strategy?: "full_scan" | "fts_prefilter" | "fts_prefilter_with_full_scan_fallback";
  passedGateCount: number;
  injectedCount: number;
  chunks: ChunkTrace[];
  graphNodesAdded: number;
  memoryLanesInjected?: MemoryLane[];
  durationMs: number;
  timestamp: number;
}

export interface AssemblyPart {
  label: string;
  charCount: number;
  tokenEstimate: number;
  source?: string;
  injected: boolean;
  cutReason?: AssemblyCutReason;
}

export interface AssemblyTrace {
  agentKey: string;
  mode: "sdk" | "cli";
  runtimeMode?: import("../runtime/mode.js").RuntimeMode;
  productRuntimeMode?: import("../runtime/mode.js").ProductRuntimeMode;
  promptProfile?: import("../runtime/mode.js").PromptProfile;
  totalTokens: number;
  parts: AssemblyPart[];
  knowledgeTrace?: RetrievalTrace;
  memoryLanesInjected?: MemoryLane[];
  diagnostics?: {
    policySectionCount: number;
    soulTokenShare: number;
    policyTokenShare: number;
    policyToSoulRatio: number;
    memoryLaneCount: number;
    proceduralMemoryInjected: boolean;
    injectedParts: string[];
    excludedParts: string[];
    sectionTokenTotals: Record<string, number>;
  };
}

export interface BuildSystemPromptResult {
  prompt: string;
  trace: AssemblyTrace;
}

export interface ContextArtifactRecord {
  id: number;
  source_uri: string;
  source_type: ContextArtifactSourceType;
  source_kind: ContextSourceKind;
  source_label: string | null;
  import_batch_id: string | null;
  source_hash: string;
  l0_abstract: string | null;
  l1_overview: string | null;
  l0_vector: Buffer | null;
  generated_at: number | null;
  generation_model: string | null;
  is_stale: number;
}

export interface ArtifactJob {
  sourceUri: string;
  sourceType: ContextArtifactSourceType;
  sourceKind?: ContextSourceKind;
  sourceLabel?: string | null;
  importBatchId?: string | null;
  content: string;
  priority: number;
}

export interface ArtifactQueueSink {
  enqueue(job: ArtifactJob): void;
}

export function estimateTokens(content: string): number {
  return content.length === 0 ? 0 : Math.ceil(content.length / 4);
}

export function hashContextSource(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function buildKnowledgeArtifactSourceUri(chunkId: number): string {
  return `knowledge:chunk:${chunkId}`;
}

export function buildThreadArtifactSourceUri(conversationId: string): string {
  return `thread:archive:${conversationId}`;
}

export function defaultContextSourceKind(sourceType: ContextArtifactSourceType): ContextSourceKind {
  switch (sourceType) {
    case "thread_archive":
      return "summary_artifact";
    case "knowledge_chunk":
    case "repo_doc":
      return "imported_docs";
  }
}

export function parseKnowledgeArtifactSourceUri(sourceUri: string): number | null {
  const match = /^knowledge:chunk:(\d+)$/.exec(sourceUri);
  if (!match) return null;
  const chunkId = Number(match[1]);
  return Number.isInteger(chunkId) && chunkId > 0 ? chunkId : null;
}

export function parseThreadArtifactSourceUri(sourceUri: string): string | null {
  const match = /^thread:archive:(.+)$/.exec(sourceUri);
  if (!match) return null;
  return match[1] || null;
}

export function mergeRetrievalTraces(
  traces: Array<RetrievalTrace | undefined | null>,
  queryOverride?: string,
): RetrievalTrace | undefined {
  const valid = traces.filter((trace): trace is RetrievalTrace => !!trace);
  if (valid.length === 0) return undefined;

  const chunks: ChunkTrace[] = [];
  const seen = new Set<string>();
  for (const trace of valid) {
    for (const chunk of trace.chunks) {
      const key = `${chunk.chunkId}:${chunk.retrievalSource ?? "vector_search"}`;
      if (seen.has(key)) continue;
      seen.add(key);
      chunks.push(chunk);
    }
  }

  const memoryLanesInjected = Array.from(new Set(
    valid.flatMap((trace) => trace.memoryLanesInjected ?? [])
      .concat(chunks.filter((chunk) => chunk.injected && chunk.memoryLane).map((chunk) => chunk.memoryLane!)),
  ));

  return {
    query: queryOverride ?? valid.map((trace) => trace.query).filter(Boolean).join(" | "),
    enriched: valid.some((trace) => trace.enriched),
    candidateCount: valid.reduce((sum, trace) => sum + trace.candidateCount, 0),
    scannedCount: valid.reduce((sum, trace) => sum + (trace.scannedCount ?? trace.candidateCount), 0),
    rerankedCount: valid.reduce((sum, trace) => sum + (trace.rerankedCount ?? trace.candidateCount), 0),
    strategy: valid[0]?.strategy,
    passedGateCount: valid.reduce((sum, trace) => sum + trace.passedGateCount, 0),
    injectedCount: chunks.filter((chunk) => chunk.injected).length,
    chunks,
    graphNodesAdded: valid.reduce((sum, trace) => sum + trace.graphNodesAdded, 0),
    memoryLanesInjected,
    durationMs: valid.reduce((sum, trace) => sum + trace.durationMs, 0),
    timestamp: Math.max(...valid.map((trace) => trace.timestamp)),
  };
}

import type { RuntimeMode } from "../runtime/mode.js";
import type { MemoryLane, RetrievalTrace } from "./retrieval-trace.js";

export interface MemoryLaneContract {
  lane: MemoryLane;
  durable: boolean;
  mutable: boolean;
  promptInjected: boolean;
  searchableOnly: boolean;
  precedence: number;
  authority: "live_context" | "durable_truth" | "summary" | "evidence" | "procedure" | "telemetry";
  represents: "truth" | "hint" | "summary" | "procedure" | "artifact";
  conversational: "allowed" | "selective" | "blocked";
}

export const MEMORY_LANE_CONTRACTS: Record<MemoryLane, MemoryLaneContract> = {
  conversation_recent: {
    lane: "conversation_recent",
    durable: false,
    mutable: true,
    promptInjected: true,
    searchableOnly: false,
    precedence: 1,
    authority: "live_context",
    represents: "truth",
    conversational: "allowed",
  },
  durable_user_preference: {
    lane: "durable_user_preference",
    durable: true,
    mutable: true,
    promptInjected: true,
    searchableOnly: false,
    precedence: 2,
    authority: "durable_truth",
    represents: "truth",
    conversational: "allowed",
  },
  conversation_summary: {
    lane: "conversation_summary",
    durable: true,
    mutable: true,
    promptInjected: true,
    searchableOnly: false,
    precedence: 3,
    authority: "summary",
    represents: "summary",
    conversational: "selective",
  },
  graph_memory: {
    lane: "graph_memory",
    durable: true,
    mutable: true,
    promptInjected: true,
    searchableOnly: false,
    precedence: 4,
    authority: "durable_truth",
    represents: "hint",
    conversational: "selective",
  },
  compiled_digest: {
    lane: "compiled_digest",
    durable: true,
    mutable: true,
    promptInjected: true,
    searchableOnly: false,
    precedence: 5,
    authority: "summary",
    represents: "summary",
    conversational: "selective",
  },
  knowledge_chunk: {
    lane: "knowledge_chunk",
    durable: true,
    mutable: true,
    promptInjected: true,
    searchableOnly: false,
    precedence: 6,
    authority: "evidence",
    represents: "artifact",
    conversational: "selective",
  },
  procedural_memory: {
    lane: "procedural_memory",
    durable: true,
    mutable: true,
    promptInjected: true,
    searchableOnly: false,
    precedence: 8,
    authority: "procedure",
    represents: "procedure",
    conversational: "blocked",
  },
  routing_history: {
    lane: "routing_history",
    durable: true,
    mutable: true,
    promptInjected: false,
    searchableOnly: true,
    precedence: 9,
    authority: "telemetry",
    represents: "hint",
    conversational: "blocked",
  },
  outcome_pattern: {
    lane: "outcome_pattern",
    durable: true,
    mutable: true,
    promptInjected: true,
    searchableOnly: false,
    precedence: 10,
    authority: "telemetry",
    represents: "hint",
    conversational: "blocked",
  },
  context_artifact: {
    lane: "context_artifact",
    durable: true,
    mutable: true,
    promptInjected: true,
    searchableOnly: false,
    precedence: 7,
    authority: "evidence",
    represents: "artifact",
    conversational: "selective",
  },
};

export function describeMemoryLaneAuthorities(lanes: MemoryLane[]): Array<{
  lane: MemoryLane;
  authority: MemoryLaneContract["authority"];
  represents: MemoryLaneContract["represents"];
  conversational: MemoryLaneContract["conversational"];
}> {
  return sortMemoryLanesByPrecedence(Array.from(new Set(lanes)))
    .map((lane) => {
      const contract = MEMORY_LANE_CONTRACTS[lane];
      return {
        lane,
        authority: contract.authority,
        represents: contract.represents,
        conversational: contract.conversational,
      };
    });
}

const CONVERSATION_ALLOWED = new Set<MemoryLane>([
  "conversation_recent",
  "durable_user_preference",
  "conversation_summary",
  "graph_memory",
  "compiled_digest",
  "knowledge_chunk",
  "context_artifact",
]);

const HYBRID_ALLOWED = new Set<MemoryLane>([
  ...CONVERSATION_ALLOWED,
]);

export function getAllowedMemoryLanes(runtimeMode: RuntimeMode): Set<MemoryLane> {
  if (runtimeMode === "conversation") return new Set(CONVERSATION_ALLOWED);
  if (runtimeMode === "hybrid") return new Set(HYBRID_ALLOWED);
  return new Set(Object.keys(MEMORY_LANE_CONTRACTS) as MemoryLane[]);
}

export function sortMemoryLanesByPrecedence(lanes: MemoryLane[]): MemoryLane[] {
  return [...lanes].sort((a, b) => MEMORY_LANE_CONTRACTS[a].precedence - MEMORY_LANE_CONTRACTS[b].precedence);
}

export function filterMemoryLanesForRuntime(lanes: MemoryLane[] | undefined, runtimeMode: RuntimeMode): MemoryLane[] {
  const allowed = getAllowedMemoryLanes(runtimeMode);
  return sortMemoryLanesByPrecedence(Array.from(new Set(lanes ?? [])).filter((lane) => allowed.has(lane)));
}

function shouldInjectChunkForRuntime(chunk: RetrievalTrace["chunks"][number], runtimeMode: RuntimeMode, allowed: Set<MemoryLane>): boolean {
  if (chunk.memoryLane && !allowed.has(chunk.memoryLane)) return false;
  if (runtimeMode !== "conversation") return true;

  if (chunk.currentness && chunk.currentness !== "current" && chunk.currentness !== "uncertain") return false;
  if (
    chunk.memoryLane
    && MEMORY_LANE_CONTRACTS[chunk.memoryLane]?.conversational === "selective"
    && chunk.confidence !== undefined
    && chunk.confidence < 0.55
  ) {
    return false;
  }

  return true;
}

export function filterRetrievalTraceForRuntime(trace: RetrievalTrace, runtimeMode: RuntimeMode): RetrievalTrace {
  const allowed = getAllowedMemoryLanes(runtimeMode);
  const chunkLaneCounts = new Map<MemoryLane, number>();
  for (const chunk of trace.chunks) {
    if (!chunk.memoryLane) continue;
    chunkLaneCounts.set(chunk.memoryLane, (chunkLaneCounts.get(chunk.memoryLane) ?? 0) + 1);
  }

  const chunks = trace.chunks.map((chunk) => {
    const chunkAllowed = shouldInjectChunkForRuntime(chunk, runtimeMode, allowed);
    const graphExpansion = chunk.graphExpansion?.filter((expansion) => !expansion.memoryLane || allowed.has(expansion.memoryLane));
    return {
      ...chunk,
      injected: chunk.injected && chunkAllowed,
      cutReason: chunk.injected && !chunkAllowed ? "gate" as const : chunk.cutReason,
      graphExpansion,
    };
  });
  const injectedChunkLanes = new Set(
    chunks
      .filter((chunk) => chunk.injected && chunk.memoryLane)
      .map((chunk) => chunk.memoryLane!),
  );
  const memoryLanesInjected = filterMemoryLanesForRuntime(trace.memoryLanesInjected, runtimeMode)
    .filter((lane) => !chunkLaneCounts.has(lane) || injectedChunkLanes.has(lane));
  return {
    ...trace,
    chunks,
    injectedCount: chunks.filter((chunk) => chunk.injected).length,
    graphNodesAdded: chunks.reduce((sum, chunk) => sum + (chunk.graphExpansion?.length ?? 0), 0),
    memoryLanesInjected,
  };
}

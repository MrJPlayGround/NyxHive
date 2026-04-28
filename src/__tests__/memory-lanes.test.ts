import { describe, expect, test } from "bun:test";
import {
  describeMemoryLaneAuthorities,
  filterMemoryLanesForRuntime,
  filterRetrievalTraceForRuntime,
  MEMORY_LANE_CONTRACTS,
  sortMemoryLanesByPrecedence,
} from "../memory/lanes.js";
import type { RetrievalTrace } from "../memory/retrieval-trace.js";

describe("memory lane contracts", () => {
  test("defines explicit semantics for every supported lane", () => {
    expect(Object.keys(MEMORY_LANE_CONTRACTS).sort()).toEqual([
      "compiled_digest",
      "context_artifact",
      "conversation_recent",
      "conversation_summary",
      "durable_user_preference",
      "graph_memory",
      "knowledge_chunk",
      "outcome_pattern",
      "procedural_memory",
      "routing_history",
    ]);
    expect(MEMORY_LANE_CONTRACTS.routing_history.promptInjected).toBe(false);
    expect(MEMORY_LANE_CONTRACTS.procedural_memory.conversational).toBe("blocked");
  });

  test("sorts lanes by conversational precedence", () => {
    expect(sortMemoryLanesByPrecedence(["context_artifact", "outcome_pattern", "knowledge_chunk", "conversation_recent", "durable_user_preference"]))
      .toEqual(["conversation_recent", "durable_user_preference", "knowledge_chunk", "context_artifact", "outcome_pattern"]);
  });

  test("blocks procedural and routing lanes from conversation traces", () => {
    const trace: RetrievalTrace = {
      query: "hello",
      enriched: false,
      candidateCount: 2,
      passedGateCount: 2,
      injectedCount: 2,
      graphNodesAdded: 0,
      durationMs: 1,
      timestamp: Date.now(),
      memoryLanesInjected: ["knowledge_chunk", "procedural_memory", "routing_history"],
      chunks: [
        { chunkId: 1, title: "Doc", similarity: 0.9, passedGate: true, injected: true, memoryLane: "knowledge_chunk" },
        { chunkId: 2, title: "Procedure", similarity: 0.9, passedGate: true, injected: true, memoryLane: "procedural_memory" },
      ],
    };

    const filtered = filterRetrievalTraceForRuntime(trace, "conversation");
    expect(filtered.memoryLanesInjected).toEqual(["knowledge_chunk"]);
    expect(filtered.injectedCount).toBe(1);
    expect(filtered.chunks[1].injected).toBe(false);
    expect(filtered.chunks[1].cutReason).toBe("gate");
  });

  test("hybrid mode now matches conversation-safe lanes and blocks procedural debris", () => {
    expect(filterMemoryLanesForRuntime(["procedural_memory", "outcome_pattern", "knowledge_chunk"], "hybrid"))
      .toEqual(["knowledge_chunk"]);
  });

  test("conversation mode gates stale and weak retrieval chunks", () => {
    const trace: RetrievalTrace = {
      query: "tone",
      enriched: false,
      candidateCount: 3,
      passedGateCount: 3,
      injectedCount: 3,
      graphNodesAdded: 0,
      durationMs: 1,
      timestamp: Date.now(),
      memoryLanesInjected: ["knowledge_chunk", "graph_memory", "durable_user_preference"],
      chunks: [
        { chunkId: 1, title: "Current explicit preference", similarity: 0.9, passedGate: true, injected: true, memoryLane: "durable_user_preference", currentness: "current", confidence: 0.9 },
        { chunkId: 2, title: "Stale graph abstraction", similarity: 0.9, passedGate: true, injected: true, memoryLane: "graph_memory", currentness: "stale", confidence: 0.9 },
        { chunkId: 3, title: "Weak knowledge match", similarity: 0.9, passedGate: true, injected: true, memoryLane: "knowledge_chunk", currentness: "current", confidence: 0.4 },
      ],
    };

    const filtered = filterRetrievalTraceForRuntime(trace, "conversation");
    expect(filtered.injectedCount).toBe(1);
    expect(filtered.chunks[0].injected).toBe(true);
    expect(filtered.chunks[1]).toMatchObject({ injected: false, cutReason: "gate" });
    expect(filtered.chunks[2]).toMatchObject({ injected: false, cutReason: "gate" });
    expect(filtered.memoryLanesInjected).toEqual(["durable_user_preference"]);
  });

  test("describes authority for injected lanes without blurring evidence and procedure", () => {
    expect(
      describeMemoryLaneAuthorities([
        "durable_user_preference",
        "knowledge_chunk",
        "procedural_memory",
      ]),
    ).toEqual([
      {
        lane: "durable_user_preference",
        authority: "durable_truth",
        represents: "truth",
        conversational: "allowed",
      },
      {
        lane: "knowledge_chunk",
        authority: "evidence",
        represents: "artifact",
        conversational: "selective",
      },
      {
        lane: "procedural_memory",
        authority: "procedure",
        represents: "procedure",
        conversational: "blocked",
      },
    ]);
  });
});

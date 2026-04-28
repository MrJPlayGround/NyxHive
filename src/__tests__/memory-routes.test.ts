import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Hono } from "hono";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GraphMemory } from "../memory/graph.js";
import { KnowledgeStore } from "../memory/knowledge.js";
import { hashContextSource } from "../memory/retrieval-trace.js";
import { MemoryStore } from "../memory/store.js";
import { graphMemoryRoutes, memoryRoutes } from "../server/routes/memory.js";
import { memoryBankRoutes } from "../server/routes/memory-bank.js";
import type { AuthEnv } from "../auth/types.js";

describe("memory routes", () => {
  let tmpDir: string;
  let memory: MemoryStore;
  let graph: GraphMemory;
  let knowledge: KnowledgeStore;
  let app: Hono<AuthEnv>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nyxhive-memory-routes-"));
    memory = new MemoryStore(tmpDir);
    graph = new GraphMemory(memory.getDb());
    knowledge = new KnowledgeStore(tmpDir, "memory-routes-test", 4);
    app = new Hono<AuthEnv>();
    app.use("/*", async (c, next) => {
      c.set("auth" as never, { type: "api_key", role: "owner" } as never);
      return next();
    });
    app.route("/api/memory", memoryRoutes(memory));
    app.route("/api/memory/graph", graphMemoryRoutes(graph));
    app.route("/api/memory-bank", memoryBankRoutes(graph, memory, knowledge));
  });

  afterEach(() => {
    knowledge.close();
    memory.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns parsed context traces", async () => {
    memory.saveContextTrace("conv-1", "nyx", {
      agentKey: "nyx",
      mode: "sdk",
      totalTokens: 128,
      memoryLanesInjected: ["durable_user_preference", "knowledge_chunk"],
      parts: [{ label: "knowledge", charCount: 40, tokenEstimate: 10, injected: true }],
    });

    const res = await app.request("/api/memory/context/traces?conversation_id=conv-1");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.traces).toHaveLength(1);
    expect(body.traces[0].conversation_id).toBe("conv-1");
    expect(body.traces[0].trace.totalTokens).toBe(128);
    expect(body.traces[0].trace.memoryLaneAuthorities).toEqual([
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
    ]);
  });

  it("returns conversation quality summary from context traces", async () => {
    memory.ensureConversation("conv-quality", "gateway", "thread-1");
    memory.saveMessage("conv-quality", "user", "what do you think?", null, null, 0, 0, 0);
    memory.saveContextTrace("conv-quality", "nyx", {
      agentKey: "nyx",
      mode: "cli",
      runtimeMode: "conversation",
      promptProfile: "conversation_light",
      totalTokens: 128,
      memoryLanesInjected: ["knowledge_chunk"],
      parts: [
        { label: "soul", charCount: 100, tokenEstimate: 25, injected: true },
        { label: "execution_policy", charCount: 20, tokenEstimate: 5, injected: true, source: "conversation" },
      ],
      diagnostics: {
        policySectionCount: 2,
        soulTokenShare: 0.5,
        policyTokenShare: 0.1,
        policyToSoulRatio: 0.2,
        memoryLaneCount: 1,
        proceduralMemoryInjected: false,
        injectedParts: ["soul", "execution_policy"],
        excludedParts: [],
        sectionTokenTotals: {},
      },
    });
    memory.saveMessage("conv-quality", "assistant", "I think this is the right direction.", null, null, 0, 0, 0);

    const res = await app.request("/api/memory/context/quality?limit=10");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.summary.total).toBe(1);
    expect(body.summary.byRuntimeMode.conversation).toBe(1);
    expect(body.samples[0].sampleKind).toBe("reflective");
    expect(body.samples[0].evaluationFamily).toBe("conversational_quality");
    expect(body.samples[0].memoryLanes).toEqual(["knowledge_chunk"]);
  });

  it("returns transcript calibration triage from context traces", async () => {
    memory.ensureConversation("conv-transcript-review", "gateway", "thread-1");
    memory.saveMessage("conv-transcript-review", "user", "I'm wiped. short version?", null, null, 0, 0, 0);
    memory.saveContextTrace("conv-transcript-review", "nyx", {
      agentKey: "nyx",
      mode: "cli",
      runtimeMode: "conversation",
      promptProfile: "conversation_light",
      totalTokens: 128,
      memoryLanesInjected: [],
      parts: [
        { label: "soul", charCount: 100, tokenEstimate: 25, injected: true },
        { label: "execution_policy", charCount: 20, tokenEstimate: 5, injected: true, source: "conversation" },
      ],
      diagnostics: {
        policySectionCount: 1,
        soulTokenShare: 0.8,
        policyTokenShare: 0.2,
        policyToSoulRatio: 0.25,
        memoryLaneCount: 0,
        proceduralMemoryInjected: false,
        injectedParts: ["soul", "execution_policy"],
        excludedParts: [],
        sectionTokenTotals: {},
      },
    });
    memory.saveMessage("conv-transcript-review", "assistant", "**Summary:**\n- Too much structure.\n- Still too much.", null, null, 0, 0, 0);

    const res = await app.request("/api/memory/context/transcript-review?limit=10");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reviewSet[0].category).toBe("low_energy");
    expect(body.clusters[0].issueFamily).toBe("overstructure");
    expect(body.tuningTargets[0].likelyResponsibleComponent).toBe("conversation reply-shape guidance");
  });

  it("returns typed memory trust inspection", async () => {
    const oldId = memory.saveMemory("User prefers JavaScript", { category: "preference", confidence: 0.5 });
    memory.saveMemory("User prefers TypeScript", {
      category: "preference",
      confidence: 0.95,
      userConfirmed: true,
      supersedesId: oldId,
    });

    const res = await app.request("/api/memory/trust");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.memories).toHaveLength(2);
    expect(body.memories.some((entry: any) => entry.currentness === "superseded" && entry.trust.currentness === "superseded")).toBe(true);
    expect(body.memories.some((entry: any) => entry.source_reliability === "user_confirmed" && entry.trust.trusted === true)).toBe(true);
  });

  it("returns context artifacts with statuses and stats", async () => {
    memory.ensureConversation("conv-1", "discord", "chan-1");
    memory.saveConversationSummary("conv-1", "Fresh summary");
    memory.saveContextArtifact({
      sourceUri: "knowledge:chunk:7",
      sourceType: "knowledge_chunk",
      sourceKind: "imported_docs",
      sourceLabel: "Stable Doc#Chunk",
      importBatchId: "batch-routes",
      sourceHash: hashContextSource("Stable chunk"),
      l0Abstract: "Stable abstract",
      l1Overview: "- Stable overview",
      generationModel: "anthropic/claude-sonnet-4-6",
    });

    const res = await app.request("/api/memory/context/artifacts");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.stats.total).toBe(2);
    expect(body.stats.stale).toBe(1);
    expect(body.stats.ready).toBe(1);
    expect(body.stats.by_kind.imported_docs).toBe(1);
    expect(body.stats.by_kind.summary_artifact).toBe(1);
    expect(body.artifacts.some((artifact: any) => artifact.status === "stale")).toBe(true);
    expect(body.artifacts.some((artifact: any) => artifact.status === "ready")).toBe(true);

    const filteredRes = await app.request("/api/memory/context/artifacts?source_kind=imported_docs&import_batch_id=batch-routes");
    const filteredBody = await filteredRes.json();
    expect(filteredRes.status).toBe(200);
    expect(filteredBody.artifacts).toHaveLength(1);
    expect(filteredBody.artifacts[0].source_label).toBe("Stable Doc#Chunk");
  });

  it("lists graph root nodes across all memory types", async () => {
    graph.addNode("fact", "Base fact", undefined, 0.2);
    graph.addNode("error", "Critical failure", undefined, 0.9);

    const res = await app.request("/api/memory/graph");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.total).toBe(2);
    expect(body.nodes).toHaveLength(2);
    expect(body.nodes.some((node: any) => node.type === "error")).toBe(true);
    expect(body.nodes.some((node: any) => node.type === "fact")).toBe(true);
  });

  it("paginates knowledge items without loading the full chunk list", async () => {
    const embedding = new Float32Array([1, 0, 0, 0]);
    knowledge.upsertChunk("First", null, "first content", "notes", "/first.md", "h1", embedding);
    knowledge.upsertChunk("Second", null, "second content", "notes", "/second.md", "h2", embedding);
    knowledge.upsertChunk("Third", null, "third content", "notes", "/third.md", "h3", embedding);

    const res = await app.request("/api/memory-bank/knowledge?limit=1&offset=1");
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.total).toBe(3);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].title).toBe("Second");
  });
});

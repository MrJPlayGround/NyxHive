import { describe, it, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { KnowledgeStore } from "../memory/knowledge.js";
import { MemoryStore } from "../memory/store.js";
import { ArtifactQueue } from "../queue/artifact-queue.js";

const cleanupDirs: string[] = [];
const cleanupStores: MemoryStore[] = [];
const cleanupKnowledge: KnowledgeStore[] = [];

afterEach(() => {
  for (const store of cleanupStores.splice(0)) {
    try { store.close(); } catch { /* ignore */ }
  }
  for (const knowledge of cleanupKnowledge.splice(0)) {
    try { knowledge.close(); } catch { /* ignore */ }
  }
  for (const dir of cleanupDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("ArtifactQueue", () => {
  it("generates and persists artifacts without blocking callers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nyxhive-artifact-queue-"));
    cleanupDirs.push(dir);
    const memory = new MemoryStore(dir);
    cleanupStores.push(memory);
    const router = {
      isAvailable: () => true,
      route: () => ({ provider: "anthropic", model: "claude-sonnet-4-6" }),
      complete: async ({ messages }: { messages: Array<{ content: string }> }) => ({
        content: messages[0]!.content.includes("bullet points")
          ? "- Step one\n- Step two"
          : "Condensed summary",
      }),
    } as any;
    const embedder = {
      embed: async () => new Float32Array([1, 0, 0, 0]),
      embedBatch: async () => [new Float32Array([1, 0, 0, 0])],
      dimensions: 4,
    };

    const queue = new ArtifactQueue(memory, undefined, router, embedder);
    queue.enqueue({
      sourceUri: "knowledge:chunk:1",
      sourceType: "knowledge_chunk",
      content: "Important content to summarize",
      priority: 1,
    });

    await queue.processTick();

    const artifact = memory.getContextArtifact("knowledge:chunk:1");
    expect(artifact?.l0_abstract).toBe("Condensed summary");
    expect(artifact?.l1_overview).toContain("Step one");
    expect(artifact?.generation_model).toBe("anthropic/claude-sonnet-4-6");
    expect(artifact?.is_stale).toBe(0);
  });

  it("recovers pending knowledge artifact jobs from storage after restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nyxhive-artifact-recovery-"));
    cleanupDirs.push(dir);
    const memory = new MemoryStore(dir);
    const knowledge = new KnowledgeStore(dir, "memory", 4);
    cleanupStores.push(memory);
    cleanupKnowledge.push(knowledge);
    knowledge.setContextMetadataStore(memory);

    knowledge.upsertChunk(
      "Architecture",
      "Context",
      "Important content to summarize",
      "docs",
      "/docs/architecture.md",
      "hash-1",
      new Float32Array([1, 0, 0, 0]),
    );

    const router = {
      isAvailable: () => true,
      route: () => ({ provider: "anthropic", model: "claude-sonnet-4-6" }),
      complete: async ({ messages }: { messages: Array<{ content: string }> }) => ({
        content: messages[0]!.content.includes("bullet points")
          ? "- Recovery step\n- Recovery done"
          : "Recovered summary",
      }),
    } as any;
    const embedder = {
      embed: async () => new Float32Array([1, 0, 0, 0]),
      embedBatch: async () => [new Float32Array([1, 0, 0, 0])],
      dimensions: 4,
    };

    const queue = new ArtifactQueue(memory, knowledge, router, embedder);
    expect(memory.listPendingContextArtifacts()).toHaveLength(1);

    const recovered = await queue.recoverPendingJobs();
    expect(recovered).toBe(1);
    expect(queue.pendingCount()).toBe(1);

    await queue.processTick();

    const artifact = memory.listContextArtifacts()[0];
    expect(artifact?.l0_abstract).toBe("Recovered summary");
    expect(artifact?.is_stale).toBe(0);
  });
});

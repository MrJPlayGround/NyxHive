import { logger } from "../utils/logger.js";
import type { ProviderRouter } from "../providers/router.js";
import type { EmbeddingProvider } from "../memory/embeddings.js";
import type { MemoryStore } from "../memory/store.js";
import type { KnowledgeStore } from "../memory/knowledge.js";
import type { ArtifactJob, ArtifactQueueSink } from "../memory/retrieval-trace.js";
import {
  hashContextSource,
  parseKnowledgeArtifactSourceUri,
  parseThreadArtifactSourceUri,
} from "../memory/retrieval-trace.js";
import type { ProviderName } from "../providers/types.js";

interface QueuedArtifactJob extends ArtifactJob {
  enqueuedAt: number;
}

export class ArtifactQueue implements ArtifactQueueSink {
  private jobs = new Map<string, QueuedArtifactJob>();
  private timer?: ReturnType<typeof setInterval>;

  constructor(
    private memory: MemoryStore,
    private knowledge?: KnowledgeStore,
    private router?: ProviderRouter,
    private embedder?: EmbeddingProvider,
    private intervalMs = 30_000,
    private batchSize = 3,
  ) {}

  start(): void {
    if (this.timer) return;
    this.recoverPendingJobs().catch((err) => {
      logger.warn(`[artifacts] Recovery failed: ${err}`);
    });
    this.timer = setInterval(() => {
      this.processTick().catch((err) => logger.warn(`[artifacts] Tick failed: ${err}`));
    }, this.intervalMs);
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  enqueue(job: ArtifactJob): void {
    const existing = this.jobs.get(job.sourceUri);
    if (existing) {
      this.jobs.set(job.sourceUri, {
        ...existing,
        ...job,
        priority: Math.min(existing.priority, job.priority),
      });
      return;
    }

    this.jobs.set(job.sourceUri, {
      ...job,
      enqueuedAt: Date.now(),
    });
  }

  pendingCount(): number {
    return this.jobs.size;
  }

  async recoverPendingJobs(limit = 100): Promise<number> {
    const pending = this.memory.listPendingContextArtifacts(limit);
    let recovered = 0;

    for (const artifact of pending) {
      const job = this.rebuildJob(artifact.source_uri, artifact.source_type, artifact.source_hash);
      if (!job) continue;
      this.enqueue(job);
      recovered++;
    }

    if (recovered > 0) {
      logger.info(`[artifacts] Recovered ${recovered} pending artifact jobs from storage`);
    }

    return recovered;
  }

  async processTick(): Promise<void> {
    if (!this.router || !this.router.isAvailable()) return;
    if (this.jobs.size === 0) return;

    const batch = Array.from(this.jobs.values())
      .sort((a, b) => a.priority - b.priority || a.enqueuedAt - b.enqueuedAt)
      .slice(0, this.batchSize);

    for (const job of batch) {
      this.jobs.delete(job.sourceUri);
      await this.processJob(job);
    }
  }

  private async processJob(job: QueuedArtifactJob): Promise<void> {
    const sourceHash = hashContextSource(job.content);
    const current = this.memory.getContextArtifact(job.sourceUri);
    if (current && current.source_hash !== sourceHash) {
      return;
    }

    const route = this.router!.route("summarization");
    const generationModel = `${route.provider}/${route.model}`;

    try {
      const [l0Abstract, l1Overview] = await Promise.all([
        this.generateArtifactText(
          `Summarize this content in 1-2 sentences using noun phrases. Keep it dense and concrete.\n\n${job.content.slice(0, 6000)}`,
          route.provider,
          route.model,
          160,
        ),
        this.generateArtifactText(
          `Write a navigable overview in 3-5 bullet points. Each bullet should help an agent decide what detail to inspect next.\n\n${job.content.slice(0, 8000)}`,
          route.provider,
          route.model,
          420,
        ),
      ]);

      const l0Vector = this.embedder && l0Abstract
        ? await this.embedder.embed(l0Abstract)
        : null;

      this.memory.saveContextArtifact({
        sourceUri: job.sourceUri,
        sourceType: job.sourceType,
        sourceKind: job.sourceKind,
        sourceLabel: job.sourceLabel,
        importBatchId: job.importBatchId,
        sourceHash,
        l0Abstract,
        l1Overview,
        l0Vector,
        generationModel,
      });
    } catch (err) {
      logger.warn(`[artifacts] Failed to generate ${job.sourceUri}: ${err}`);
    }
  }

  private rebuildJob(
    sourceUri: string,
    sourceType: ArtifactJob["sourceType"],
    sourceHash: string,
  ): ArtifactJob | null {
    if (sourceType === "knowledge_chunk") {
      const chunkId = parseKnowledgeArtifactSourceUri(sourceUri);
      if (!chunkId || !this.knowledge) return null;
      const chunk = this.knowledge.getChunkById(chunkId);
      if (!chunk) return null;
      if (hashContextSource(chunk.content) !== sourceHash) return null;
      return {
        sourceUri,
        sourceType,
        sourceKind: "imported_docs",
        sourceLabel: chunk.section ? `${chunk.title}#${chunk.section}` : chunk.title,
        content: chunk.content,
        priority: 2,
      };
    }

    if (sourceType === "thread_archive") {
      const conversationId = parseThreadArtifactSourceUri(sourceUri);
      if (!conversationId) return null;
      const summary = this.memory.getConversationSummary(conversationId);
      if (!summary) return null;
      if (hashContextSource(summary) !== sourceHash) return null;
      return {
        sourceUri,
        sourceType,
        sourceKind: "summary_artifact",
        sourceLabel: conversationId,
        content: summary,
        priority: 1,
      };
    }

    return null;
  }

  private async generateArtifactText(
    prompt: string,
    provider: ProviderName,
    model: string,
    maxTokens: number,
  ): Promise<string | null> {
    const response = await this.router!.complete(
      {
        messages: [{ role: "user", content: prompt }],
        maxTokens,
        temperature: 0.2,
      },
      provider,
      model,
    );

    const content = response.content.trim();
    return content.length > 0 ? content : null;
  }
}

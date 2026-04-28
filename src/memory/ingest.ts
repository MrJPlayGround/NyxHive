import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { logger } from "../utils/logger.js";
import type { EmbeddingProvider } from "./embeddings.js";
import type { KnowledgeStore } from "./knowledge.js";
import { listVaultFiles, type VaultConfig } from "./vault.js";
import { parseFrontmatter, resolveWikiLinks, processCallouts, } from "./obsidian.js";

export interface Chunk {
  title: string;
  section: string;
  content: string;
  category: string;
  sourcePath: string;
  contentHash: string;
  prefixed: string;  // "title > section: content" for embedding
  chunkIndex: number;
  tags?: string[];
  priority?: number;
}

export interface IngestResult {
  totalFiles: number;
  totalChunks: number;
  newChunks: number;
  updatedChunks: number;
  skippedChunks: number;
  deletedFiles: number;
}

const MAX_CHUNK_SIZE = 1200;
const MIN_CHUNK_SIZE = 80;

export function chunkMarkdown(title: string, content: string, category: string, sourcePath: string): Chunk[] {
  // Parse frontmatter instead of stripping
  const { frontmatter, body: rawBody } = parseFrontmatter(content);

  // Skip archived/superseded notes
  if (frontmatter?.status === "archived" || frontmatter?.status === "superseded") {
    return [];
  }

  // Use frontmatter title if available
  const effectiveTitle = (frontmatter?.title as string) ?? title;
  const effectiveCategory = (frontmatter?.category as string) ?? category;
  const fmTags = Array.isArray(frontmatter?.tags) ? frontmatter.tags as string[] : undefined;

  // Map frontmatter importance to priority
  let fmPriority: number | undefined;
  if (frontmatter?.importance === "high") fmPriority = 3;
  else if (frontmatter?.importance === "low") fmPriority = 1;

  // Process callouts and resolve wiki links for embedding text
  const body = rawBody;

  // Build aliases prefix for embedding (helps search hit on alternative names)
  const aliasPrefix = Array.isArray(frontmatter?.aliases) && frontmatter.aliases.length > 0
    ? `(${(frontmatter.aliases as string[]).join(", ")}) `
    : "";

  const chunks: Chunk[] = [];
  let chunkIndex = 0;
  const sections = body.split(/^(?=##\s)/m);

  for (const raw of sections) {
    const trimmed = raw.trim();
    if (trimmed.length < MIN_CHUNK_SIZE) continue;

    // Extract section name from heading
    let section = effectiveTitle;
    let sectionContent = trimmed;

    const headingMatch = trimmed.match(/^##\s+(.+)/);
    if (headingMatch) {
      section = headingMatch[1].trim();
      sectionContent = trimmed.slice(headingMatch[0].length).trim();
    }

    if (sectionContent.length < MIN_CHUNK_SIZE) continue;

    // Process content for embedding: resolve wiki links + process callouts
    const embeddingContent = resolveWikiLinks(processCallouts(sectionContent));

    // Split large sections by paragraphs
    if (sectionContent.length > MAX_CHUNK_SIZE) {
      const paragraphs = sectionContent.split(/\n\n+/);
      const embeddingParagraphs = embeddingContent.split(/\n\n+/);
      let buffer = "";
      let embedBuffer = "";
      let partIdx = 0;

      for (let pi = 0; pi < paragraphs.length; pi++) {
        const para = paragraphs[pi];
        const embedPara = embeddingParagraphs[pi] ?? para;

        if (buffer.length + para.length + 2 > MAX_CHUNK_SIZE && buffer.length >= MIN_CHUNK_SIZE) {
          const partSection = `${section} (part ${++partIdx})`;
          const hash = contentHash(buffer);
          chunks.push({
            title: effectiveTitle,
            section: partSection,
            content: buffer,
            category: effectiveCategory,
            sourcePath,
            contentHash: hash,
            prefixed: `${aliasPrefix}${effectiveTitle} > ${partSection}: ${embedBuffer}`,
            chunkIndex: chunkIndex++,
            tags: fmTags,
            priority: fmPriority,
          });
          buffer = "";
          embedBuffer = "";
        }
        buffer += (buffer ? "\n\n" : "") + para;
        embedBuffer += (embedBuffer ? "\n\n" : "") + embedPara;
      }

      // Flush remaining buffer
      if (buffer.length >= MIN_CHUNK_SIZE) {
        const partSection = partIdx > 0 ? `${section} (part ${++partIdx})` : section;
        const hash = contentHash(buffer);
        chunks.push({
          title: effectiveTitle,
          section: partSection,
          content: buffer,
          category: effectiveCategory,
          sourcePath,
          contentHash: hash,
          prefixed: `${aliasPrefix}${effectiveTitle} > ${partSection}: ${embedBuffer}`,
          chunkIndex: chunkIndex++,
          tags: fmTags,
          priority: fmPriority,
        });
      }
    } else {
      const hash = contentHash(sectionContent);
      chunks.push({
        title: effectiveTitle,
        section,
        content: sectionContent,
        category: effectiveCategory,
        sourcePath,
        contentHash: hash,
        prefixed: `${aliasPrefix}${effectiveTitle} > ${section}: ${embeddingContent}`,
        chunkIndex: chunkIndex++,
        tags: fmTags,
        priority: fmPriority,
      });
    }
  }

  return chunks;
}

function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

export async function ingestVault(
  vaultConfig: VaultConfig,
  store: KnowledgeStore,
  embedder: EmbeddingProvider,
): Promise<IngestResult> {
  const result: IngestResult = {
    totalFiles: 0,
    totalChunks: 0,
    newChunks: 0,
    updatedChunks: 0,
    skippedChunks: 0,
    deletedFiles: 0,
  };

  // Step 1: List vault files
  const files = listVaultFiles(vaultConfig);
  result.totalFiles = files.length;
  logger.info(`[ingest] Found ${files.length} files in vault`);

  // Step 2: Get existing hashes for dedup
  const existingHashes = store.getExistingHashes();

  // Step 3: Chunk all files
  const allChunks: Chunk[] = [];
  for (const file of files) {
    const chunks = chunkMarkdown(file.title, file.content, file.category, file.path);
    allChunks.push(...chunks);
  }
  result.totalChunks = allChunks.length;
  logger.info(`[ingest] ${allChunks.length} chunks from ${files.length} files`);

  // Step 4: Filter out unchanged chunks
  const toEmbed: Chunk[] = [];
  for (const chunk of allChunks) {
    const key = `${chunk.sourcePath}::${chunk.section ?? "_ROOT_"}::${chunk.chunkIndex}`;
    const existingHash = existingHashes.get(key);

    if (existingHash === chunk.contentHash) {
      result.skippedChunks++;
    } else {
      toEmbed.push(chunk);
      if (existingHash) {
        result.updatedChunks++;
      } else {
        result.newChunks++;
      }
    }
  }

  logger.info(`[ingest] ${toEmbed.length} chunks to embed (${result.skippedChunks} unchanged)`);

  // Step 5: Embed and upsert in batches
  if (toEmbed.length > 0) {
    const batchSize = 50;
    for (let i = 0; i < toEmbed.length; i += batchSize) {
      const batch = toEmbed.slice(i, i + batchSize);
      const texts = batch.map((c) => c.prefixed);

      logger.info(`[ingest] Embedding batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(toEmbed.length / batchSize)}`);
      const embeddings = await embedder.embedBatch(texts);

      for (let j = 0; j < batch.length; j++) {
        const chunk = batch[j];
        store.upsertChunk(
          chunk.title,
          chunk.section,
          chunk.content,
          chunk.category,
          chunk.sourcePath,
          chunk.contentHash,
          embeddings[j],
          undefined,
          chunk.priority,
          undefined,
          chunk.chunkIndex,
        );
      }
    }
  }

  // Step 6: Clean up chunks from deleted files
  const currentPaths = new Set(files.map((f) => f.path));
  const storedPaths = store.getAllSourcePaths();

  for (const storedPath of storedPaths) {
    if (!currentPaths.has(storedPath)) {
      store.deleteBySourcePath(storedPath);
      result.deletedFiles++;
    }
  }

  if (result.deletedFiles > 0) {
    logger.info(`[ingest] Cleaned up chunks from ${result.deletedFiles} deleted files`);
  }

  return result;
}

// Single-file incremental ingestion (for file watcher)
export interface IngestFileResult {
  chunksUpdated: number;
  chunksSkipped: number;
}

export async function ingestFile(
  filePath: string,
  vaultPath: string,
  store: KnowledgeStore,
  embedder: EmbeddingProvider,
): Promise<IngestFileResult> {
  const { relative, basename } = await import("node:path");
  const result: IngestFileResult = { chunksUpdated: 0, chunksSkipped: 0 };

  // Skip macOS resource fork files (._* files)
  const fileName = basename(filePath);
  if (fileName.startsWith("._")) return result;

  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    return result;
  }

  if (content.trim().length < 20) return result;

  const relPath = relative(vaultPath, filePath);
  const title = basename(filePath, ".md");
  const topDir = relPath.includes("/") ? relPath.split("/")[0] : "root";
  const category = topDir.toLowerCase();

  // Parse frontmatter and skip archived
  const { frontmatter } = parseFrontmatter(content);
  if (frontmatter?.status === "archived" || frontmatter?.status === "superseded") {
    // Remove existing chunks for this file
    store.deleteBySourcePath(relPath);
    return result;
  }

  const chunks = chunkMarkdown(title, content, category, relPath);
  const existingHashes = store.getExistingHashes();

  // Track which sections exist in the new version
  const newSections = new Set(chunks.map(c => `${c.sourcePath}::${c.section ?? "_ROOT_"}::${c.chunkIndex}`));

  // Delete chunks for sections that no longer exist
  const allStored = [...existingHashes.keys()].filter(k => k.startsWith(`${relPath}::`));
  for (const key of allStored) {
    if (!newSections.has(key)) {
      const _section = key.split("::")[1];
      store.deleteBySourcePath(relPath); // Will delete all, but we re-upsert below
      break;
    }
  }

  // Embed and upsert changed chunks
  for (const chunk of chunks) {
    const key = `${chunk.sourcePath}::${chunk.section ?? "_ROOT_"}::${chunk.chunkIndex}`;
    const existingHash = existingHashes.get(key);

    if (existingHash === chunk.contentHash) {
      result.chunksSkipped++;
      continue;
    }

    const embedding = await embedder.embed(chunk.prefixed);
    store.upsertChunk(
      chunk.title, chunk.section, chunk.content, chunk.category,
      chunk.sourcePath, chunk.contentHash, embedding,
      undefined, chunk.priority, undefined, chunk.chunkIndex,
    );
    result.chunksUpdated++;
  }

  return result;
}

// Template-aware ingestion with priority rules and scope isolation
export interface TemplateIngestOptions {
  vaultPath: string;
  scope: string;
  exclude?: string[];
  priorityRules?: Array<{ pattern: string; priority: number }>;
}

export interface TemplateIngestResult extends IngestResult {
  priorityCounts: { core: number; high: number; normal: number };
}

export async function ingestTemplateKnowledge(
  store: KnowledgeStore,
  embedder: EmbeddingProvider,
  options: TemplateIngestOptions,
): Promise<TemplateIngestResult> {
  const { vaultPath, scope, exclude, priorityRules } = options;

  const vaultConfig: VaultConfig = {
    path: vaultPath,
    skipDirs: exclude?.filter(p => !p.includes("*")).map(p => p.replace(/\/$/, "").replace(/\/\*\*$/, "")),
  };

  const allFiles = listVaultFiles(vaultConfig);

  // Apply glob exclude patterns using Bun.Glob
  const files = exclude?.length
    ? allFiles.filter(f => !exclude.some(pattern => new Bun.Glob(pattern).match(f.path)))
    : allFiles;

  const result: TemplateIngestResult = {
    totalFiles: files.length,
    totalChunks: 0,
    newChunks: 0,
    updatedChunks: 0,
    skippedChunks: 0,
    deletedFiles: 0,
    priorityCounts: { core: 0, high: 0, normal: 0 },
  };

  logger.info(`[ingest:${scope}] Found ${files.length} files in vault (${allFiles.length - files.length} excluded)`);

  const existingHashes = store.getExistingHashes();

  // Chunk all files with priority assignment
  const allChunks: Array<Chunk & { priority: number }> = [];
  for (const file of files) {
    const chunks = chunkMarkdown(file.title, file.content, file.category, file.path);
    const priority = getPriority(file.path, priorityRules);

    if (priority === 3) result.priorityCounts.core += chunks.length;
    else if (priority === 2) result.priorityCounts.high += chunks.length;
    else result.priorityCounts.normal += chunks.length;

    for (const chunk of chunks) {
      allChunks.push({ ...chunk, priority });
    }
  }
  result.totalChunks = allChunks.length;
  logger.info(`[ingest:${scope}] ${allChunks.length} chunks (${result.priorityCounts.core} core, ${result.priorityCounts.high} high, ${result.priorityCounts.normal} normal)`);

  // Filter unchanged
  const toEmbed: Array<Chunk & { priority: number }> = [];
  for (const chunk of allChunks) {
    const key = `${chunk.sourcePath}::${chunk.section ?? "_ROOT_"}::${chunk.chunkIndex}`;
    const existingHash = existingHashes.get(key);

    if (existingHash === chunk.contentHash) {
      result.skippedChunks++;
    } else {
      toEmbed.push(chunk);
      if (existingHash) result.updatedChunks++;
      else result.newChunks++;
    }
  }

  logger.info(`[ingest:${scope}] ${toEmbed.length} chunks to embed (${result.skippedChunks} unchanged)`);

  // Embed and upsert in batches
  if (toEmbed.length > 0) {
    const batchSize = 50;
    for (let i = 0; i < toEmbed.length; i += batchSize) {
      const batch = toEmbed.slice(i, i + batchSize);
      const texts = batch.map(c => c.prefixed);

      logger.info(`[ingest:${scope}] Embedding batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(toEmbed.length / batchSize)}`);
      const embeddings = await embedder.embedBatch(texts);

      for (let j = 0; j < batch.length; j++) {
        const chunk = batch[j];
        store.upsertChunk(
          chunk.title,
          chunk.section,
          chunk.content,
          chunk.category,
          chunk.sourcePath,
          chunk.contentHash,
          embeddings[j],
          scope,
          chunk.priority,
          undefined,
          chunk.chunkIndex,
        );
      }
    }
  }

  return result;
}

function getPriority(
  filePath: string,
  rules?: Array<{ pattern: string; priority: number }>,
): number {
  if (!rules?.length) return 1;
  let highest = 1;
  for (const rule of rules) {
    if (new Bun.Glob(rule.pattern).match(filePath) && rule.priority > highest) {
      highest = rule.priority;
    }
  }
  return highest;
}

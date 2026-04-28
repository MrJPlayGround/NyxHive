import { listVaultFiles } from "../memory/vault.js";
import type { KnowledgeStore } from "../memory/knowledge.js";
import type { EmbeddingProvider } from "../memory/embeddings.js";
import type { VaultFile } from "../memory/vault.js";

export interface HybridSearchDeps {
  vaultPath: string;
  knowledge?: KnowledgeStore;
  embedder?: EmbeddingProvider;
  /** Override for testing — replaces listVaultFiles call */
  _listFiles?: (config: { path: string }) => VaultFile[];
}

export interface VaultSearchResult {
  title: string;
  path: string;
  category: string;
  snippet: string;
  score?: number;
  match_type: "keyword" | "semantic" | "both";
}

export async function searchObsidianHybrid(
  query: string,
  deps: HybridSearchDeps,
  options?: { limit?: number; category?: string },
): Promise<VaultSearchResult[]> {
  const limit = options?.limit ?? 10;
  const lister = deps._listFiles ?? listVaultFiles;
  const files = lister({ path: deps.vaultPath });
  const q = query.toLowerCase();

  // Keyword matches (existing behavior)
  const keywordMatches = files.filter((f) => {
    if (options?.category && f.category !== options.category.toLowerCase()) return false;
    return f.title.toLowerCase().includes(q) || f.content.toLowerCase().includes(q);
  });

  const results = new Map<string, VaultSearchResult>();

  for (const f of keywordMatches.slice(0, limit)) {
    const idx = f.content.toLowerCase().indexOf(q);
    const snippetStart = Math.max(0, idx - 100);
    const snippetEnd = Math.min(f.content.length, idx + query.length + 200);
    results.set(f.path, {
      title: f.title,
      path: f.path,
      category: f.category,
      snippet: f.content.slice(snippetStart, snippetEnd).replace(/\n/g, " ").trim(),
      match_type: "keyword",
    });
  }

  // Semantic matches (when embedder + knowledge store available)
  if (deps.knowledge && deps.embedder) {
    try {
      const embedding = await deps.embedder.embed(query);
      const semanticResults = deps.knowledge.search(embedding, limit * 2, 0.55, undefined, undefined, query);

      // IMPORTANT: filter to vault files only — knowledge store may contain
      // crawled web pages, template knowledge, or inline-ingested content
      const vaultPaths = new Set(files.map((f) => f.path));

      for (const chunk of semanticResults) {
        if (!vaultPaths.has(chunk.source_path)) continue;

        const existing = results.get(chunk.source_path);
        if (existing) {
          existing.match_type = "both";
          existing.score = chunk.similarity;
        } else {
          results.set(chunk.source_path, {
            title: chunk.title,
            path: chunk.source_path,
            category: chunk.category ?? "",
            snippet: chunk.content.slice(0, 300).replace(/\n/g, " ").trim(),
            score: chunk.similarity,
            match_type: "semantic",
          });
        }
      }
    } catch {
      // Embedding failed — fall back to keyword-only results
    }
  }

  // Sort: "both" first, then by score (semantic), then keyword
  const sorted = [...results.values()].sort((a, b) => {
    const typeOrder = { both: 0, semantic: 1, keyword: 2 };
    const typeDiff = typeOrder[a.match_type] - typeOrder[b.match_type];
    if (typeDiff !== 0) return typeDiff;
    return (b.score ?? 0) - (a.score ?? 0);
  });

  return sorted.slice(0, limit);
}

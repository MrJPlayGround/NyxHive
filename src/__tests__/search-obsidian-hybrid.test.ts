import { describe, it, expect } from "bun:test";
import { searchObsidianHybrid } from "../mcp/search-obsidian.js";
import type { VaultFile } from "../memory/vault.js";
import type { KnowledgeChunk } from "../memory/knowledge.js";

// --- Stubs ---

function makeVaultFile(overrides: Partial<VaultFile> & { path: string; title: string }): VaultFile {
  return {
    category: "notes",
    content: "",
    ...overrides,
  };
}

function makeChunk(overrides: Partial<KnowledgeChunk> & { source_path: string; title: string }): KnowledgeChunk {
  return {
    id: 1,
    section: null,
    content: "semantic content",
    category: "notes",
    content_hash: "abc",
    similarity: 0.8,
    ...overrides,
  };
}

function makeEmbedder(vector = [1, 0, 0, 0]) {
  return {
    embed: async (_text: string) => new Float32Array(vector),
    embedBatch: async (texts: string[]) => texts.map(() => new Float32Array(vector)),
    dimensions: vector.length,
  };
}

function makeKnowledgeStore(chunks: KnowledgeChunk[]) {
  return {
    search: (_embedding: Float32Array, _limit: number, _threshold: number) => chunks,
  };
}

// --- Tests ---

describe("searchObsidianHybrid", () => {
  const fakeFiles: VaultFile[] = [
    makeVaultFile({
      path: "Notes/alpha.md",
      title: "alpha",
      category: "notes",
      content: "This note is about alpha testing strategies and alpha metrics.",
    }),
    makeVaultFile({
      path: "Notes/beta.md",
      title: "beta",
      category: "notes",
      content: "Beta release notes for the project.",
    }),
    makeVaultFile({
      path: "Arch/gamma.md",
      title: "gamma",
      category: "arch",
      content: "Gamma architecture design with alpha references.",
    }),
  ];

  const listFiles = (_config: { path: string }) => fakeFiles;

  it("returns keyword-only results when no embedder available", async () => {
    const results = await searchObsidianHybrid(
      "alpha",
      { vaultPath: "/fake", _listFiles: listFiles },
    );

    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.match_type).toBe("keyword");
      expect(r.score).toBeUndefined();
    }
    const paths = results.map((r) => r.path);
    expect(paths).toContain("Notes/alpha.md");
    expect(paths).toContain("Arch/gamma.md");
    expect(paths).not.toContain("Notes/beta.md");
  });

  it("returns keyword-only results when no knowledge store available", async () => {
    const results = await searchObsidianHybrid(
      "alpha",
      { vaultPath: "/fake", embedder: makeEmbedder(), _listFiles: listFiles },
    );

    for (const r of results) {
      expect(r.match_type).toBe("keyword");
    }
  });

  it("semantic results appear alongside keyword results", async () => {
    const semanticChunk = makeChunk({
      source_path: "Notes/beta.md",
      title: "beta",
      content: "Beta release notes for the project.",
      similarity: 0.85,
    });

    const results = await searchObsidianHybrid(
      "alpha",
      {
        vaultPath: "/fake",
        embedder: makeEmbedder(),
        knowledge: makeKnowledgeStore([semanticChunk]) as never,
        _listFiles: listFiles,
      },
    );

    const matchTypes = new Set(results.map((r) => r.match_type));
    expect(matchTypes.has("keyword")).toBe(true);
    expect(matchTypes.has("semantic")).toBe(true);

    const betaResult = results.find((r) => r.path === "Notes/beta.md");
    expect(betaResult).toBeDefined();
    expect(betaResult?.match_type).toBe("semantic");
    expect(betaResult?.score).toBe(0.85);
  });

  it("deduplicates: upgrades to 'both' when a note matches keyword and semantic", async () => {
    const semanticChunk = makeChunk({
      source_path: "Notes/alpha.md",
      title: "alpha",
      content: "This note is about alpha testing strategies.",
      similarity: 0.9,
    });

    const results = await searchObsidianHybrid(
      "alpha",
      {
        vaultPath: "/fake",
        embedder: makeEmbedder(),
        knowledge: makeKnowledgeStore([semanticChunk]) as never,
        _listFiles: listFiles,
      },
    );

    const alphaResult = results.find((r) => r.path === "Notes/alpha.md");
    expect(alphaResult).toBeDefined();
    expect(alphaResult?.match_type).toBe("both");
    expect(alphaResult?.score).toBe(0.9);

    // should appear only once
    const alphaCount = results.filter((r) => r.path === "Notes/alpha.md").length;
    expect(alphaCount).toBe(1);
  });

  it("sorts: both first, then semantic by score, then keyword", async () => {
    const chunks: KnowledgeChunk[] = [
      makeChunk({ source_path: "Notes/alpha.md", title: "alpha", similarity: 0.9 }),
      makeChunk({ source_path: "Notes/beta.md", title: "beta", similarity: 0.75, id: 2 }),
    ];

    const results = await searchObsidianHybrid(
      "alpha",
      {
        vaultPath: "/fake",
        embedder: makeEmbedder(),
        knowledge: makeKnowledgeStore(chunks) as never,
        _listFiles: listFiles,
      },
    );

    // alpha.md is keyword + semantic => "both"
    // beta.md is semantic only
    // gamma.md is keyword only
    expect(results[0].match_type).toBe("both");
    expect(results[1].match_type).toBe("semantic");
    expect(results[2].match_type).toBe("keyword");
  });

  it("filters by category when specified", async () => {
    const results = await searchObsidianHybrid(
      "alpha",
      { vaultPath: "/fake", _listFiles: listFiles },
      { category: "arch" },
    );

    expect(results.length).toBe(1);
    expect(results[0].path).toBe("Arch/gamma.md");
    expect(results[0].category).toBe("arch");
  });

  it("respects limit", async () => {
    const results = await searchObsidianHybrid(
      "alpha",
      { vaultPath: "/fake", _listFiles: listFiles },
      { limit: 1 },
    );

    expect(results.length).toBe(1);
  });

  it("filters out non-vault paths from semantic results", async () => {
    const webChunk = makeChunk({
      source_path: "https://example.com/some-page",
      title: "External page",
      similarity: 0.95,
    });

    const results = await searchObsidianHybrid(
      "alpha",
      {
        vaultPath: "/fake",
        embedder: makeEmbedder(),
        knowledge: makeKnowledgeStore([webChunk]) as never,
        _listFiles: listFiles,
      },
    );

    const externalResult = results.find((r) => r.path === "https://example.com/some-page");
    expect(externalResult).toBeUndefined();
  });

  it("falls back to keyword-only when embedding throws", async () => {
    const faultyEmbedder = {
      embed: async (_text: string): Promise<Float32Array> => { throw new Error("embedding API down"); },
      embedBatch: async (_texts: string[]): Promise<Float32Array[]> => { throw new Error("embedding API down"); },
      dimensions: 4,
    };

    const results = await searchObsidianHybrid(
      "alpha",
      {
        vaultPath: "/fake",
        embedder: faultyEmbedder,
        knowledge: makeKnowledgeStore([]) as never,
        _listFiles: listFiles,
      },
    );

    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      expect(r.match_type).toBe("keyword");
    }
  });
});

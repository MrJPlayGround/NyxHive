import { describe, it, expect } from "bun:test";
import { buildExtractionNote, extractKnowledge } from "../memory/media-extract.js";
import type { ExtractedKnowledge } from "../memory/media-extract.js";

const SAMPLE_EXTRACTION: ExtractedKnowledge = {
  title: "memory graphs beat giant memory files",
  summary: "Structured graph-based memory outperforms flat file storage for AI agents. The key insight is that relationships between concepts matter as much as the concepts themselves. Queryable graphs enable targeted retrieval without scanning everything.",
  claims: [
    "Flat memory files become unusable past a few hundred entries",
    "Graph edges capture relationships that plain text loses",
    "Semantic search over embeddings is faster than full-file scans",
    "Memory decay improves signal quality over time",
  ],
  frameworks: [
    "Graph Memory Model",
    "Decay-weighted Retrieval",
    "Layered Context Windows",
  ],
  techniques: [
    "Embed claims as nodes, relationships as typed edges",
    "Apply exponential decay to old memories",
    "Query by semantic similarity before token budget",
  ],
  examples: [
    "NyxHive's routing store logs delegation outcomes and computes per-agent success rates",
    "Obsidian vault as a human-readable knowledge graph with wiki links",
  ],
  tags: ["memory", "agents", "knowledge-graph"],
  related_concepts: ["Knowledge Graph", "Semantic Search", "Embedding Store"],
};

describe("extractKnowledge", () => {
  it("throws when no API key is available", async () => {
    const orig = process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_API_KEY;

    await expect(
      extractKnowledge("some transcript", { apiKey: undefined }),
    ).rejects.toThrow("No API key for knowledge extraction");

    process.env.OPENROUTER_API_KEY = orig;
  });
});

describe("buildExtractionNote", () => {
  it("includes title in H1 heading", () => {
    const note = buildExtractionNote(SAMPLE_EXTRACTION, {});
    expect(note).toContain("# memory graphs beat giant memory files");
  });

  it("includes title in frontmatter", () => {
    const note = buildExtractionNote(SAMPLE_EXTRACTION, {});
    expect(note).toContain("title: memory graphs beat giant memory files");
  });

  it("includes ingested tag plus custom tags", () => {
    const note = buildExtractionNote(SAMPLE_EXTRACTION, {});
    expect(note).toContain("  - ingested");
    expect(note).toContain("  - memory");
    expect(note).toContain("  - agents");
    expect(note).toContain("  - knowledge-graph");
  });

  it("sets source agent to brain-ingest", () => {
    const note = buildExtractionNote(SAMPLE_EXTRACTION, {});
    expect(note).toContain("source: brain-ingest");
  });

  it("includes summary in content body", () => {
    const note = buildExtractionNote(SAMPLE_EXTRACTION, {});
    expect(note).toContain("Structured graph-based memory outperforms flat file storage");
  });

  it("generates Key Claims section", () => {
    const note = buildExtractionNote(SAMPLE_EXTRACTION, {});
    expect(note).toContain("## Key Claims");
    expect(note).toContain("- Flat memory files become unusable past a few hundred entries");
    expect(note).toContain("- Graph edges capture relationships that plain text loses");
  });

  it("generates Frameworks section", () => {
    const note = buildExtractionNote(SAMPLE_EXTRACTION, {});
    expect(note).toContain("## Frameworks");
    expect(note).toContain("- Graph Memory Model");
    expect(note).toContain("- Decay-weighted Retrieval");
  });

  it("generates Techniques section", () => {
    const note = buildExtractionNote(SAMPLE_EXTRACTION, {});
    expect(note).toContain("## Techniques");
    expect(note).toContain("- Embed claims as nodes, relationships as typed edges");
  });

  it("generates Examples section", () => {
    const note = buildExtractionNote(SAMPLE_EXTRACTION, {});
    expect(note).toContain("## Examples");
    expect(note).toContain("- NyxHive's routing store logs delegation outcomes");
  });

  it("related concepts become wiki links in Context section", () => {
    const note = buildExtractionNote(SAMPLE_EXTRACTION, {});
    expect(note).toContain("[[Knowledge Graph]]");
    expect(note).toContain("[[Semantic Search]]");
    expect(note).toContain("[[Embedding Store]]");
  });

  it("includes Source section with URL when provided", () => {
    const note = buildExtractionNote(SAMPLE_EXTRACTION, {
      url: "https://example.com/talk",
    });
    expect(note).toContain("## Source");
    expect(note).toContain("- URL: https://example.com/talk");
  });

  it("includes source_url in frontmatter properties when URL provided", () => {
    const note = buildExtractionNote(SAMPLE_EXTRACTION, {
      url: "https://example.com/talk",
    });
    expect(note).toContain("source_url");
  });

  it("includes file path in Source section when provided", () => {
    const note = buildExtractionNote(SAMPLE_EXTRACTION, {
      filePath: "/tmp/transcript.txt",
    });
    expect(note).toContain("## Source");
    expect(note).toContain("- File: /tmp/transcript.txt");
  });

  it("includes duration in Source section when provided", () => {
    const note = buildExtractionNote(SAMPLE_EXTRACTION, {
      duration: 3720, // 62 minutes
    });
    expect(note).toContain("## Source");
    expect(note).toContain("- Duration: 62 minutes");
  });

  it("includes duration_seconds in frontmatter when provided", () => {
    const note = buildExtractionNote(SAMPLE_EXTRACTION, { duration: 3600 });
    expect(note).toContain("duration_seconds: 3600");
  });

  it("omits Source section when no source info provided", () => {
    const note = buildExtractionNote(SAMPLE_EXTRACTION, {});
    expect(note).not.toContain("## Source");
  });

  it("omits Key Claims section when claims array is empty", () => {
    const extraction = { ...SAMPLE_EXTRACTION, claims: [] };
    const note = buildExtractionNote(extraction, {});
    expect(note).not.toContain("## Key Claims");
  });

  it("omits Frameworks section when frameworks array is empty", () => {
    const extraction = { ...SAMPLE_EXTRACTION, frameworks: [] };
    const note = buildExtractionNote(extraction, {});
    expect(note).not.toContain("## Frameworks");
  });

  it("omits Techniques section when techniques array is empty", () => {
    const extraction = { ...SAMPLE_EXTRACTION, techniques: [] };
    const note = buildExtractionNote(extraction, {});
    expect(note).not.toContain("## Techniques");
  });

  it("omits Examples section when examples array is empty", () => {
    const extraction = { ...SAMPLE_EXTRACTION, examples: [] };
    const note = buildExtractionNote(extraction, {});
    expect(note).not.toContain("## Examples");
  });

  it("sets category to Knowledge in frontmatter", () => {
    const note = buildExtractionNote(SAMPLE_EXTRACTION, {});
    expect(note).toContain("category: Knowledge");
  });

  it("generates valid frontmatter delimiters", () => {
    const note = buildExtractionNote(SAMPLE_EXTRACTION, {});
    const fmStart = note.indexOf("---");
    const fmEnd = note.indexOf("---", fmStart + 3);
    expect(fmStart).toBe(0);
    expect(fmEnd).toBeGreaterThan(3);
  });

  it("handles all source fields together", () => {
    const note = buildExtractionNote(SAMPLE_EXTRACTION, {
      url: "https://example.com/video",
      filePath: "/tmp/video.mp4",
      duration: 1800,
    });
    expect(note).toContain("- URL: https://example.com/video");
    expect(note).toContain("- File: /tmp/video.mp4");
    expect(note).toContain("- Duration: 30 minutes");
  });
});

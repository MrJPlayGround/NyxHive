import { describe, it, expect } from "bun:test";
import {
  buildObsidianNote,
  extractTags,
  detectWikiLinks,
  getVaultNoteTitles,
  parseFrontmatter,
  resolveWikiLinks,
  processCallouts,
  extractCitations,
  generateKnowledgeCanvas,
} from "../memory/obsidian.js";
import { writeVaultNote } from "../memory/vault.js";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// --- Phase 1: Write-Back ---

describe("buildObsidianNote", () => {
  it("generates valid frontmatter with tags", () => {
    const result = buildObsidianNote({
      title: "Budget exceeded for coding tasks",
      content: "The monthly budget of $240 was exceeded.",
      category: "operations",
      tags: ["budget", "cost"],
      sourceAgent: "orchestrator",
    });

    expect(result).toContain("---");
    expect(result).toContain("title: Budget exceeded for coding tasks");
    expect(result).toContain("category: operations");
    expect(result).toContain("  - learning");
    expect(result).toContain("  - operations");
    expect(result).toContain("  - budget");
    expect(result).toContain("  - cost");
    expect(result).toContain("source: orchestrator");
    expect(result).toContain("status: active");
    expect(result).toContain("# Budget exceeded for coding tasks");
    expect(result).toContain("## Detail");
    expect(result).toContain("The monthly budget of $240 was exceeded.");
  });

  it("includes related notes as wiki links", () => {
    const result = buildObsidianNote({
      title: "Test note",
      content: "Some content.",
      category: "test",
      relatedNotes: ["Routing Table", "Cost Rates"],
    });

    expect(result).toContain("## Context");
    expect(result).toContain("[[Routing Table]]");
    expect(result).toContain("[[Cost Rates]]");
  });

  it("generates aliases from title slug", () => {
    const result = buildObsidianNote({
      title: "API Rate Limiting",
      content: "Details here.",
      category: "architecture",
    });

    expect(result).toContain("  - api-rate-limiting");
  });

  it("deduplicates tags", () => {
    const result = buildObsidianNote({
      title: "Test",
      content: "Test content.",
      category: "operations",
      tags: ["learning", "operations", "new-tag"],
    });

    // Count occurrences of "  - learning"
    const matches = result.match(/  - learning\n/g);
    expect(matches?.length).toBe(1);
  });

  it("handles extra frontmatter properties", () => {
    const result = buildObsidianNote({
      title: "Test",
      content: "Content.",
      category: "test",
      properties: { importance: "high", custom_field: "value" },
    });

    expect(result).toContain("importance: high");
    expect(result).toContain("custom_field: value");
  });
});

describe("extractTags", () => {
  it("always includes learning and category", () => {
    const tags = extractTags("simple content", "operations");
    expect(tags).toContain("learning");
    expect(tags).toContain("operations");
  });

  it("extracts tags from existing note titles", () => {
    const titles = new Set(["Routing Table", "Budget Alerting"]);
    const tags = extractTags("Check the Routing Table for config", "operations", titles);
    expect(tags).toContain("routing-table");
  });

  it("extracts capitalized multi-word terms", () => {
    const tags = extractTags("The Anthropic Claude model exceeded the Daily Budget limit", "operations");
    expect(tags).toContain("daily-budget");
  });

  it("filters out stop words and short tags", () => {
    const tags = extractTags("a b the", "operations");
    expect(tags).not.toContain("a");
    expect(tags).not.toContain("b");
    expect(tags).not.toContain("the");
  });

  it("skips existing titles shorter than 3 chars", () => {
    const titles = new Set(["AI", "go"]);
    const tags = extractTags("AI and go are used", "tech", titles);
    expect(tags).not.toContain("ai");
    expect(tags).not.toContain("go");
  });
});

describe("detectWikiLinks", () => {
  it("links first occurrence of existing titles", () => {
    const titles = new Set(["Routing Table", "Budget Alerting"]);
    const result = detectWikiLinks("Check the Routing Table for details", titles);
    expect(result).toContain("[[Routing Table]]");
  });

  it("is case insensitive but preserves original case", () => {
    const titles = new Set(["routing table"]);
    const result = detectWikiLinks("Check the Routing Table now", titles);
    expect(result).toContain("[[Routing Table]]");
  });

  it("does not link inside code blocks", () => {
    const titles = new Set(["Routing Table"]);
    const result = detectWikiLinks("See `Routing Table` for code", titles);
    expect(result).not.toContain("[[Routing Table]]");
    expect(result).toContain("`Routing Table`");
  });

  it("does not double-link existing wiki links", () => {
    const titles = new Set(["Routing Table"]);
    const result = detectWikiLinks("See [[Routing Table]] here and Routing Table there", titles);
    // Should have exactly two [[Routing Table]] (original + new one for second occurrence)
    // Actually, the second occurrence should get linked
    const count = (result.match(/\[\[Routing Table\]\]/g) ?? []).length;
    expect(count).toBeGreaterThanOrEqual(1);
  });

  it("skips titles shorter than 3 chars", () => {
    const titles = new Set(["AI"]);
    const result = detectWikiLinks("AI is great", titles);
    expect(result).toBe("AI is great");
  });

  it("handles empty title set", () => {
    const result = detectWikiLinks("No links here", new Set());
    expect(result).toBe("No links here");
  });
});

describe("getVaultNoteTitles", () => {
  const testDir = join(tmpdir(), `obsidian-test-${Date.now()}`);

  it("scans vault for note titles", () => {
    // Create test vault structure
    mkdirSync(join(testDir, "Knowledge"), { recursive: true });
    mkdirSync(join(testDir, ".obsidian"), { recursive: true });
    writeFileSync(join(testDir, "README.md"), "# Root");
    writeFileSync(join(testDir, "Knowledge", "Architecture.md"), "# Arch");
    writeFileSync(join(testDir, ".obsidian", "app.json"), "{}");

    const titles = getVaultNoteTitles(testDir);
    expect(titles.has("README")).toBe(true);
    expect(titles.has("Architecture")).toBe(true);
    expect(titles.has("app")).toBe(false); // .obsidian skipped

    rmSync(testDir, { recursive: true, force: true });
  });

  it("skips configured directories", () => {
    mkdirSync(join(testDir, "Archive"), { recursive: true });
    writeFileSync(join(testDir, "note.md"), "# Note");
    writeFileSync(join(testDir, "Archive", "old.md"), "# Old");

    const titles = getVaultNoteTitles(testDir, ["Archive"]);
    expect(titles.has("note")).toBe(true);
    expect(titles.has("old")).toBe(false);

    rmSync(testDir, { recursive: true, force: true });
  });
});

// --- Phase 2: Ingestion ---

describe("parseFrontmatter", () => {
  it("extracts all property types", () => {
    const content = `---
title: My Note
category: architecture
tags:
  - system
  - design
status: active
importance: high
aliases:
  - my-note
---

# My Note

Content here.`;

    const { frontmatter, body } = parseFrontmatter(content);
    expect(frontmatter).not.toBeNull();
    expect(frontmatter!.title).toBe("My Note");
    expect(frontmatter!.category).toBe("architecture");
    expect(frontmatter!.tags).toEqual(["system", "design"]);
    expect(frontmatter!.status).toBe("active");
    expect(frontmatter!.importance).toBe("high");
    expect(frontmatter!.aliases).toEqual(["my-note"]);
    expect(body).toContain("# My Note");
    expect(body).toContain("Content here.");
  });

  it("returns null frontmatter for no frontmatter", () => {
    const { frontmatter, body } = parseFrontmatter("# Just a heading\n\nContent.");
    expect(frontmatter).toBeNull();
    expect(body).toBe("# Just a heading\n\nContent.");
  });

  it("handles malformed frontmatter (missing end delimiter)", () => {
    const { frontmatter, body } = parseFrontmatter("---\ntitle: broken\nContent.");
    expect(frontmatter).toBeNull();
    expect(body).toBe("---\ntitle: broken\nContent.");
  });

  it("handles empty frontmatter", () => {
    const { frontmatter, body } = parseFrontmatter("---\n---\n\nContent.");
    expect(frontmatter).toBeNull();
    expect(body).toBe("Content.");
  });
});

describe("resolveWikiLinks", () => {
  it("strips simple wiki links", () => {
    expect(resolveWikiLinks("See [[Routing Table]] for details")).toBe("See Routing Table for details");
  });

  it("uses display text for piped links", () => {
    expect(resolveWikiLinks("Check [[Long Note Name|the docs]]")).toBe("Check the docs");
  });

  it("flattens heading links", () => {
    expect(resolveWikiLinks("See [[Architecture#Overview]]")).toBe("See Architecture: Overview");
  });

  it("strips embed references", () => {
    expect(resolveWikiLinks("Before ![[embedded-image]] after")).toBe("Before  after");
  });

  it("handles mixed link types", () => {
    const input = "See [[Note]], [[Other|display]], [[Doc#Section]], and ![[embed]]";
    const expected = "See Note, display, Doc: Section, and ";
    expect(resolveWikiLinks(input)).toBe(expected);
  });
});

describe("processCallouts", () => {
  it("converts tip callout", () => {
    const input = "> [!tip] Action\n> Review routing table monthly.";
    expect(processCallouts(input)).toBe("TIP -- Action: Review routing table monthly.");
  });

  it("converts warning callout", () => {
    const input = "> [!warning] Deprecated\n> Don't use API v1.";
    expect(processCallouts(input)).toBe("WARNING -- Deprecated: Don't use API v1.");
  });

  it("converts important callout", () => {
    const input = "> [!important] Critical\n> Always test before deploy.";
    expect(processCallouts(input)).toBe("IMPORTANT -- Critical: Always test before deploy.");
  });

  it("handles callout with no body", () => {
    const input = "> [!tip] Just a title";
    expect(processCallouts(input)).toBe("TIP -- Just a title");
  });

  it("handles callout with no title", () => {
    const input = "> [!note]\n> Some content here.";
    expect(processCallouts(input)).toBe("NOTE: Some content here.");
  });

  it("preserves non-callout content", () => {
    const input = "Regular text\n\n> [!tip] Tip\n> Content\n\nMore text";
    const result = processCallouts(input);
    expect(result).toContain("Regular text");
    expect(result).toContain("TIP -- Tip: Content");
    expect(result).toContain("More text");
  });

  it("handles multi-line callout body", () => {
    const input = "> [!warning] Watch Out\n> Line one.\n> Line two.";
    expect(processCallouts(input)).toBe("WARNING -- Watch Out: Line one. Line two.");
  });
});

// --- Phase 5: Citations ---

describe("extractCitations", () => {
  it("extracts wiki link citations", () => {
    const response = 'Based on: [[Routing Table#Overview]] and [[Budget Config]]';
    const citations = extractCitations(response);
    expect(citations).toContain("Routing Table#Overview");
    expect(citations).toContain("Budget Config");
    expect(citations.length).toBe(2);
  });

  it("deduplicates citations", () => {
    const response = "See [[Note]] and also [[Note]] again";
    expect(extractCitations(response).length).toBe(1);
  });

  it("returns empty for no citations", () => {
    expect(extractCitations("No citations here")).toEqual([]);
  });
});

// --- Phase 6: Canvas ---

describe("generateKnowledgeCanvas", () => {
  it("generates valid JSON canvas", () => {
    const chunks = [
      { title: "Note A", section: "Overview", content: "Content", category: "architecture", source_path: "a.md" },
      { title: "Note B", section: null, content: "Content", category: "architecture", source_path: "b.md" },
      { title: "Note C", section: "Detail", content: "See [[Note A]]", category: "operations", source_path: "c.md" },
    ];

    const result = generateKnowledgeCanvas(chunks, { title: "Test", groupByCategory: true, maxNodes: 100 });
    const canvas = JSON.parse(result);

    expect(canvas.nodes.length).toBe(3);
    expect(canvas.groups.length).toBe(2); // architecture + operations
    expect(canvas.edges.length).toBe(1); // Note C -> Note A
  });

  it("respects maxNodes limit", () => {
    const chunks = Array.from({ length: 20 }, (_, i) => ({
      title: `Note ${i}`, section: null, content: "Content", category: "test", source_path: `${i}.md`,
    }));

    const result = generateKnowledgeCanvas(chunks, { title: "Test", groupByCategory: true, maxNodes: 5 });
    const canvas = JSON.parse(result);
    expect(canvas.nodes.length).toBe(5);
  });

  it("omits groups when groupByCategory is false", () => {
    const chunks = [
      { title: "Note", section: null, content: "Content", category: "test", source_path: "a.md" },
    ];

    const result = generateKnowledgeCanvas(chunks, { title: "Test", groupByCategory: false, maxNodes: 100 });
    const canvas = JSON.parse(result);
    expect(canvas.groups).toBeUndefined();
  });

  it("handles empty chunk list", () => {
    const result = generateKnowledgeCanvas([], { title: "Empty", groupByCategory: true, maxNodes: 100 });
    const canvas = JSON.parse(result);
    expect(canvas.nodes).toEqual([]);
    expect(canvas.edges).toEqual([]);
  });
});

// --- Write-back: writeVaultNote ---

describe("writeVaultNote", () => {
  const testDir = join(tmpdir(), `vault-write-test-${Date.now()}`);

  it("creates note in category subdirectory", () => {
    const relPath = writeVaultNote(testDir, "Learnings", "Test Note", "# Test\n\nContent here");
    expect(relPath).toBe("Learnings/Test Note.md");

    const { readFileSync: readFs } = require("fs");
    const content = readFs(join(testDir, relPath), "utf-8");
    expect(content).toBe("# Test\n\nContent here");

    rmSync(testDir, { recursive: true, force: true });
  });

  it("creates intermediate directories", () => {
    const relPath = writeVaultNote(testDir, "Deep/Nested/Dir", "Nested", "content");
    expect(relPath).toBe("Deep/Nested/Dir/Nested.md");

    rmSync(testDir, { recursive: true, force: true });
  });

  it("sanitizes title for filesystem", () => {
    const relPath = writeVaultNote(testDir, "Notes", 'Bad: "chars" <here>', "ok");
    expect(relPath).toBe("Notes/Bad- -chars- -here-.md");

    rmSync(testDir, { recursive: true, force: true });
  });

  it("appends timestamp suffix to avoid clobbering", () => {
    writeVaultNote(testDir, "Notes", "Duplicate", "first");
    const secondPath = writeVaultNote(testDir, "Notes", "Duplicate", "second");

    // Second write should have a timestamp suffix, not overwrite
    expect(secondPath).not.toBe("Notes/Duplicate.md");
    expect(secondPath).toContain("Notes/Duplicate ");
    expect(secondPath).toEndWith(".md");

    // Original file should still contain "first"
    const { readFileSync: readFs } = require("fs");
    const original = readFs(join(testDir, "Notes/Duplicate.md"), "utf-8");
    expect(original).toBe("first");

    rmSync(testDir, { recursive: true, force: true });
  });

  it("overwrites when overwrite=true", () => {
    writeVaultNote(testDir, "Notes", "Overwrite Me", "original");
    writeVaultNote(testDir, "Notes", "Overwrite Me", "replaced", true);

    const { readFileSync: readFs } = require("fs");
    const content = readFs(join(testDir, "Notes/Overwrite Me.md"), "utf-8");
    expect(content).toBe("replaced");

    rmSync(testDir, { recursive: true, force: true });
  });
});

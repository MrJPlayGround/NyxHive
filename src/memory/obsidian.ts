import { readdirSync } from "node:fs";
import { join, basename } from "node:path";

// --- Types ---

/** Input structure for generating an Obsidian markdown note via {@link buildObsidianNote}. */
export interface ObsidianNote {
  title: string;
  content: string;
  category: string;
  tags?: string[];
  relatedNotes?: string[]; // becomes [[wiki links]]
  sourceAgent?: string;
  properties?: Record<string, unknown>; // extra frontmatter
}

/** Parsed YAML frontmatter fields from an Obsidian note. Supports standard fields plus arbitrary extras. */
export interface ParsedFrontmatter {
  title?: string;
  tags?: string[];
  aliases?: string[];
  status?: string;
  category?: string;
  importance?: "high" | "normal" | "low";
  [key: string]: unknown;
}

/**
 * Build a complete Obsidian markdown note with YAML frontmatter, context links, and content body.
 * Generates slug aliases, deduplicates tags, and adds source/date metadata automatically.
 */
export function buildObsidianNote(note: ObsidianNote): string {
  const date = new Date().toISOString().split("T")[0];
  const slug = note.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, "");

  // Build frontmatter
  const fm: Record<string, unknown> = {
    title: note.title,
    category: note.category,
    tags: [...new Set([
      "learning",
      note.category,
      ...(note.tags ?? []),
    ])],
    source: note.sourceAgent ?? "orchestrator",
    created: date,
    status: "active",
    aliases: [slug],
    ...(note.properties ?? {}),
  };

  const frontmatter = buildYamlFrontmatter(fm);

  // Build body
  const lines: string[] = [];
  lines.push(`# ${note.title}`);
  lines.push("");

  // Context section with links
  if (note.relatedNotes?.length || note.sourceAgent) {
    lines.push("## Context");
    lines.push("");
    if (note.relatedNotes?.length) {
      lines.push(`- Related: ${note.relatedNotes.map(n => `[[${n}]]`).join(", ")}`);
    }
    if (note.sourceAgent) {
      lines.push(`- Source agent: ${note.sourceAgent}`);
    }
    lines.push(`- Learned during conversation on ${date}`);
    lines.push("");
  }

  // Detail section
  lines.push("## Detail");
  lines.push("");
  lines.push(note.content);

  return `${frontmatter}\n${lines.join("\n")}\n`;
}

function buildYamlFrontmatter(obj: Record<string, unknown>): string {
  const lines: string[] = ["---"];

  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined || value === null) continue;

    if (Array.isArray(value)) {
      if (value.length === 0) continue;
      lines.push(`${key}:`);
      for (const item of value) {
        lines.push(`  - ${String(item)}`);
      }
    } else {
      const str = String(value);
      // Quote strings that contain special YAML characters
      if (str.includes(":") || str.includes("#") || str.includes("'") || str.includes('"')) {
        lines.push(`${key}: "${str.replace(/"/g, '\\"')}"`);
      } else {
        lines.push(`${key}: ${str}`);
      }
    }
  }

  lines.push("---");
  return lines.join("\n");
}

/**
 * Extract tags from note content using heuristics: category inheritance, existing note title matching,
 * and capitalized multi-word term detection. Filters stop words and short tags.
 */
export function extractTags(content: string, category: string, existingTitles?: Set<string>): string[] {
  const tags = new Set<string>(["learning", category]);

  // Add nested category tag
  if (category.includes("/")) {
    tags.add(category);
  }

  // Extract words that match existing note titles (they're concepts worth tagging)
  if (existingTitles) {
    const lower = content.toLowerCase();
    for (const title of existingTitles) {
      if (title.length < 3) continue; // skip tiny titles
      if (lower.includes(title.toLowerCase())) {
        const tag = title.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-/]/g, "");
        if (tag.length >= 2) tags.add(tag);
      }
    }
  }

  // Extract key terms from content using simple heuristics
  // Look for capitalized multi-word terms (likely proper nouns / concepts)
  const capitalizedTerms = content.match(/\b[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+\b/g);
  if (capitalizedTerms) {
    for (const term of capitalizedTerms.slice(0, 5)) {
      const tag = term.toLowerCase().replace(/\s+/g, "-");
      if (tag.length >= 3 && tag.length <= 30) tags.add(tag);
    }
  }

  // Filter out single chars and stop words
  const stopTags = new Set(["the", "and", "for", "not", "but", "are", "was", "has", "had"]);
  return [...tags].filter(t => t.length >= 2 && !stopTags.has(t));
}

/**
 * Auto-link the first occurrence of each known note title as a [[wiki link]].
 * Skips code blocks, existing wiki links, and titles shorter than 3 chars.
 * Matches longest titles first to avoid partial overlaps.
 */
export function detectWikiLinks(content: string, existingTitles: Set<string>): string {
  if (existingTitles.size === 0) return content;

  // Sort by length descending to match longer titles first
  const sorted = [...existingTitles].sort((a, b) => b.length - a.length);
  let result = content;

  // Track which regions are already linked or in code blocks
  const protected_: Array<[number, number]> = [];

  // Protect code blocks
  const codeBlockRe = /```[\s\S]*?```|`[^`]+`/g;
  let m: RegExpExecArray | null;
  while ((m = codeBlockRe.exec(result)) !== null) {
    protected_.push([m.index, m.index + m[0].length]);
  }

  // Protect existing wiki links
  const wikiLinkRe = /\[\[[^\]]+\]\]/g;
  while ((m = wikiLinkRe.exec(result)) !== null) {
    protected_.push([m.index, m.index + m[0].length]);
  }

  function isProtected(start: number, end: number): boolean {
    return protected_.some(([ps, pe]) => start >= ps && end <= pe);
  }

  for (const title of sorted) {
    if (title.length < 3) continue;

    // Case-insensitive search for first occurrence
    const re = new RegExp(`\\b(${escapeRegex(title)})\\b`, "i");
    const match = re.exec(result);

    if (match && !isProtected(match.index, match.index + match[0].length)) {
      const original = match[1];
      const linked = `[[${original}]]`;
      result = result.slice(0, match.index) + linked + result.slice(match.index + match[0].length);
      // Protect this new link
      protected_.push([match.index, match.index + linked.length]);
    }
  }

  return result;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Recursively scan an Obsidian vault directory and return the set of all .md note titles
 * (filenames without extension). Skips .obsidian, .trash, .git, and node_modules by default.
 */
export function getVaultNoteTitles(vaultPath: string, skipDirs?: string[]): Set<string> {
  const skip = new Set(skipDirs ?? [".obsidian", ".trash", ".git", "node_modules", ".smart-connections"]);
  const titles = new Set<string>();

  function scan(dir: string) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (skip.has(entry.name)) continue;
      if (entry.name.startsWith(".")) continue;

      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        scan(fullPath);
      } else if (entry.name.endsWith(".md")) {
        titles.add(basename(entry.name, ".md"));
      }
    }
  }

  scan(vaultPath);
  return titles;
}

/**
 * Parse YAML frontmatter from a markdown string. Returns the parsed key-value pairs
 * (including list values) and the body content after the closing `---`.
 * Returns null frontmatter if the content doesn't start with `---` or has no valid fields.
 */
export function parseFrontmatter(content: string): { frontmatter: ParsedFrontmatter | null; body: string } {
  if (!content.startsWith("---")) {
    return { frontmatter: null, body: content };
  }

  const endIdx = content.indexOf("---", 3);
  if (endIdx === -1) {
    return { frontmatter: null, body: content };
  }

  const yamlBlock = content.slice(3, endIdx).trim();
  const body = content.slice(endIdx + 3).trim();

  const fm: ParsedFrontmatter = {};

  for (const line of yamlBlock.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    // Handle list items (indented with -)
    if (trimmed.startsWith("- ")) {
      // This is a list continuation, handled below
      continue;
    }

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    const rawValue = trimmed.slice(colonIdx + 1).trim();

    if (!rawValue) {
      // Could be a list (next lines start with -)
      const list: string[] = [];
      const lines = yamlBlock.split("\n");
      const lineIdx = lines.findIndex(l => l.trim() === trimmed);
      for (let i = lineIdx + 1; i < lines.length; i++) {
        const item = lines[i].trim();
        if (item.startsWith("- ")) {
          list.push(item.slice(2).trim().replace(/^["']|["']$/g, ""));
        } else if (!item.startsWith(" ") && !item.startsWith("\t") && item.includes(":")) {
          break;
        }
      }
      if (list.length > 0) {
        fm[key] = list;
      }
    } else {
      // Strip quotes
      const value = rawValue.replace(/^["']|["']$/g, "");
      fm[key] = value;
    }
  }

  return { frontmatter: fm.title || fm.tags || fm.status || fm.category || fm.importance || fm.aliases
    ? fm : (Object.keys(fm).length > 0 ? fm : null), body };
}

/**
 * Flatten wiki links into plain text for embedding/search indexing.
 * Strips embeds (![[...]]), converts heading refs to "Note: Heading",
 * display-text links to their display text, and plain links to their title.
 */
export function resolveWikiLinks(content: string): string {
  let result = content;

  // ![[embedded]] -> strip entirely
  result = result.replace(/!\[\[[^\]]*\]\]/g, "");

  // [[Note Name#Heading]] -> Note Name: Heading
  result = result.replace(/\[\[([^\]|#]+)#([^\]|]+)\]\]/g, "$1: $2");

  // [[Note Name|Display Text]] -> Display Text
  result = result.replace(/\[\[[^\]|]+\|([^\]]+)\]\]/g, "$1");

  // [[Note Name]] -> Note Name
  result = result.replace(/\[\[([^\]]+)\]\]/g, "$1");

  return result;
}

/**
 * Convert Obsidian callout blocks (`> [!type] Title`) into flat "TYPE -- Title: body" lines
 * suitable for embedding. Collapses multi-line callout bodies into single lines.
 */
export function processCallouts(content: string): string {
  // Match callout blocks: > [!type] Title\n> Content lines
  const lines = content.split("\n");
  const result: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const calloutMatch = lines[i].match(/^>\s*\[!(\w+)\]\s*(.*)/);

    if (calloutMatch) {
      const type = calloutMatch[1].toUpperCase();
      const title = calloutMatch[2].trim();
      const bodyLines: string[] = [];

      i++;
      while (i < lines.length && lines[i].startsWith(">")) {
        const stripped = lines[i].replace(/^>\s?/, "").trim();
        if (stripped) bodyLines.push(stripped);
        i++;
      }

      const body = bodyLines.join(" ");
      if (title && body) {
        result.push(`${type} -- ${title}: ${body}`);
      } else if (title) {
        result.push(`${type} -- ${title}`);
      } else if (body) {
        result.push(`${type}: ${body}`);
      }
    } else {
      result.push(lines[i]);
      i++;
    }
  }

  return result.join("\n");
}

/**
 * Extract unique [[wiki link]] references from an agent response string.
 * Returns an array of note titles (without brackets), deduplicated.
 */
export function extractCitations(response: string): string[] {
  const citations: string[] = [];
  const re = /\[\[([^\]]+)\]\]/g;
  let match: RegExpExecArray | null;

  while ((match = re.exec(response)) !== null) {
    citations.push(match[1]);
  }

  return [...new Set(citations)];
}

const COMMON_VERBS = new Set([
  "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did",
  "will", "would", "could", "should", "may", "might",
  "shall", "can", "need", "must",
  "beat", "beats", "outperform", "outperforms",
  "handle", "handles", "require", "requires",
  "improve", "improves", "reduce", "reduces",
  "enable", "enables", "prevent", "prevents",
  "cause", "causes", "solve", "solves",
  "compound", "compounds", "scale", "scales",
  "fail", "fails", "work", "works",
  "win", "wins", "lose", "loses",
]);

/** Check if a title is category-style (noun-heavy, no verbs). */
export function isCategoryStyleTitle(title: string): boolean {
  const words = title.toLowerCase().split(/\s+/);
  if (words.some(w => COMMON_VERBS.has(w))) return false;
  return true;
}

/** Node in an Obsidian Canvas JSON file */
export interface CanvasNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  type: "text";
  text: string;
  color?: string;
}

/** Directional edge connecting two canvas nodes. */
export interface CanvasEdge {
  id: string;
  fromNode: string;
  toNode: string;
  fromSide: "right" | "left" | "top" | "bottom";
  toSide: "right" | "left" | "top" | "bottom";
}

/** Labeled grouping rectangle that visually contains related canvas nodes. */
export interface CanvasGroup {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  label: string;
  color?: string;
}

/** Options for {@link generateKnowledgeCanvas}. */
export interface CanvasOptions {
  title: string;
  groupByCategory: boolean;
  maxNodes: number;
}

interface ChunkForCanvas {
  title: string;
  section: string | null;
  content: string;
  category: string | null;
  source_path: string;
}

const CANVAS_COLORS = ["1", "2", "3", "4", "5", "6"]; // Obsidian's color palette indices
const NODE_WIDTH = 250;
const NODE_HEIGHT = 60;
const NODE_GAP_X = 30;
const NODE_GAP_Y = 20;
const GROUP_PADDING = 40;
const COLS_PER_GROUP = 4;

/**
 * Generate an Obsidian Canvas JSON from knowledge chunks. Groups nodes by category,
 * lays them out in a grid, and creates edges from wiki link cross-references.
 * Returns the canvas as a JSON string.
 */
export function generateKnowledgeCanvas(
  chunks: ChunkForCanvas[],
  options: CanvasOptions,
): string {
  const limited = chunks.slice(0, options.maxNodes);

  // Group by category
  const groups = new Map<string, ChunkForCanvas[]>();
  for (const chunk of limited) {
    const cat = chunk.category ?? "uncategorized";
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat)!.push(chunk);
  }

  // Sort groups by size (largest first)
  const sortedGroups = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);

  const nodes: CanvasNode[] = [];
  const edges: CanvasEdge[] = [];
  const canvasGroups: CanvasGroup[] = [];

  let groupY = 0;

  for (let gi = 0; gi < sortedGroups.length; gi++) {
    const [category, catChunks] = sortedGroups[gi];
    const color = CANVAS_COLORS[gi % CANVAS_COLORS.length];

    const rows = Math.ceil(catChunks.length / COLS_PER_GROUP);
    const cols = Math.min(catChunks.length, COLS_PER_GROUP);
    const groupWidth = cols * (NODE_WIDTH + NODE_GAP_X) - NODE_GAP_X + GROUP_PADDING * 2;
    const groupHeight = rows * (NODE_HEIGHT + NODE_GAP_Y) - NODE_GAP_Y + GROUP_PADDING * 2 + 30; // +30 for label

    if (options.groupByCategory) {
      canvasGroups.push({
        id: `group-${category}`,
        x: 0,
        y: groupY,
        width: groupWidth,
        height: groupHeight,
        label: category,
        color,
      });
    }

    for (let ci = 0; ci < catChunks.length; ci++) {
      const chunk = catChunks[ci];
      const col = ci % COLS_PER_GROUP;
      const row = Math.floor(ci / COLS_PER_GROUP);

      const nodeId = `node-${nodes.length}`;
      const label = chunk.section ? `${chunk.title}\n${chunk.section}` : chunk.title;

      nodes.push({
        id: nodeId,
        x: GROUP_PADDING + col * (NODE_WIDTH + NODE_GAP_X),
        y: groupY + GROUP_PADDING + 30 + row * (NODE_HEIGHT + NODE_GAP_Y),
        width: NODE_WIDTH,
        height: NODE_HEIGHT,
        type: "text",
        text: label,
        color,
      });
    }

    groupY += groupHeight + 60; // gap between groups
  }

  // Build edges from wiki link references between chunks
  const titleToNodeId = new Map<string, string>();
  for (let i = 0; i < limited.length; i++) {
    titleToNodeId.set(limited[i].title.toLowerCase(), `node-${i}`);
  }

  for (let i = 0; i < limited.length; i++) {
    const chunk = limited[i];
    const wikiRefs = chunk.content.match(/\[\[([^\]]+)\]\]/g) ?? [];
    for (const ref of wikiRefs) {
      const target = ref.slice(2, -2).split("|")[0].split("#")[0].toLowerCase();
      const targetId = titleToNodeId.get(target);
      if (targetId && targetId !== `node-${i}`) {
        edges.push({
          id: `edge-${edges.length}`,
          fromNode: `node-${i}`,
          toNode: targetId,
          fromSide: "right",
          toSide: "left",
        });
      }
    }
  }

  const canvas = {
    nodes,
    edges,
    ...(canvasGroups.length > 0 ? { groups: canvasGroups } : {}),
  };

  return JSON.stringify(canvas, null, 2);
}

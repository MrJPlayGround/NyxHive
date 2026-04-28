import { readFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, basename } from "node:path";
import { parseFrontmatter, type ParsedFrontmatter } from "./frontmatter.js";

export const SOUL_FILE_TYPES = ["identity", "rules", "tools", "context", "memory"] as const;
export type SoulFileType = (typeof SOUL_FILE_TYPES)[number];
const KNOWN_FILE_SET = new Set<string>(SOUL_FILE_TYPES);

export interface SoulFileSet {
  identity?: ParsedFrontmatter;
  rules?: ParsedFrontmatter;
  tools?: ParsedFrontmatter;
  context?: ParsedFrontmatter;
  memory?: ParsedFrontmatter;
}

/** Result of loading a soul v2 directory */
export interface SoulV2LoadResult {
  /** Raw agent files (only files the agent actually has) */
  agent: SoulFileSet;
  /** Raw _base files */
  base: SoulFileSet;
  /** Resolved files: agent wins if present, else _base */
  resolved: SoulFileSet;
  /** Extra .md files beyond the 5 known types (e.g. personality.md, philosophy.md) */
  extras: Record<string, ParsedFrontmatter>;
}

export function loadStandaloneSoulV2Directory(dir: string): SoulV2LoadResult {
  const agent = loadFileSet(dir);
  const resolved: SoulFileSet = {};
  for (const type of SOUL_FILE_TYPES) {
    resolved[type] = agent[type];
  }
  return {
    agent,
    base: {},
    resolved,
    extras: loadExtras(dir),
  };
}

function loadFile(filePath: string): ParsedFrontmatter | undefined {
  if (!existsSync(filePath)) return undefined;
  return parseFrontmatter(readFileSync(filePath, "utf-8"));
}

function loadFileSet(dir: string): SoulFileSet {
  const result: SoulFileSet = {};
  for (const type of SOUL_FILE_TYPES) {
    const parsed = loadFile(resolve(dir, `${type}.md`));
    if (parsed) result[type] = parsed;
  }
  return result;
}

/** Discover .md files beyond the 5 known types in a soul directory */
function loadExtras(dir: string): Record<string, ParsedFrontmatter> {
  if (!existsSync(dir)) return {};
  const extras: Record<string, ParsedFrontmatter> = {};
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".md")) continue;
    const name = basename(file, ".md");
    if (KNOWN_FILE_SET.has(name)) continue;
    const parsed = loadFile(resolve(dir, file));
    if (parsed) extras[name] = parsed;
  }
  return extras;
}

/**
 * Load soul v2 directory for an agent.
 * Returns agent files, base files, and resolved (agent-wins-else-base) files separately.
 * The compiler needs all three for merge mode logic.
 * Extra .md files (personality, philosophy, etc.) are collected in the extras field.
 */
export function loadSoulV2Directory(soulsDir: string, agentKey: string): SoulV2LoadResult {
  const base = loadFileSet(resolve(soulsDir, "_base"));
  const agent = loadFileSet(resolve(soulsDir, agentKey));
  const extras = loadExtras(resolve(soulsDir, agentKey));

  const resolved: SoulFileSet = {};
  for (const type of SOUL_FILE_TYPES) {
    resolved[type] = agent[type] ?? base[type];
  }

  return { agent, base, resolved, extras };
}

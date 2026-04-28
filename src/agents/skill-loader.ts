import { resolve, join, relative, delimiter } from "node:path";
import { readdirSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import type { ProceduralSkillDraft, ProceduralSkillDraftStore } from "../memory/procedural-skills.js";
import { getProceduralSkillSuccessRate, needsProceduralSkillAudit } from "../memory/procedural-skill-analytics.js";
import { parseFrontmatter } from "../soul/frontmatter.js";

export type SkillRootKind = "curated" | "generated";

export interface SkillRoot {
  kind: SkillRootKind;
  path: string;
}

export interface SkillResolution {
  name: string;
  root: SkillRoot;
  skillDir: string;
  skillPath: string;
}

export interface SkillAuditEntry {
  name: string;
  path: string;
  rootKind: SkillRootKind;
  status: "pass" | "fail";
  frontmatter: {
    name: string;
    description: string;
  };
  issues: string[];
}

export interface SkillAuditReport {
  ok: boolean;
  skills: SkillAuditEntry[];
}

export interface ExportedSkillCatalog {
  version: 1;
  generatedAt: string;
  skills: Array<{
    name: string;
    description: string;
    path: string;
    rootKind: SkillRootKind;
    portable: boolean;
  }>;
}

const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

function splitPathEnv(value: string | undefined): string[] {
  return (value ?? "")
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function uniqueResolved(paths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const path of paths) {
    const resolved = resolve(path);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    result.push(resolved);
  }
  return result;
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!!rel && !rel.startsWith("..") && !rel.startsWith("/"));
}

export function normalizeSkillName(skillName: string): string | null {
  const trimmed = skillName.trim();
  if (!trimmed || trimmed.includes("/") || trimmed.includes("\\") || trimmed.includes("\0")) return null;
  if (trimmed === "." || trimmed === ".." || trimmed.includes("..")) return null;
  return SKILL_NAME_PATTERN.test(trimmed) ? trimmed : null;
}

export function getSkillsDir(): string {
  if (process.env.NYXHIVE_SKILLS_DIR?.trim()) {
    return resolve(process.env.NYXHIVE_SKILLS_DIR);
  }
  return resolve(import.meta.dir, "../../skills");
}

export function getGeneratedSkillsDir(): string {
  if (process.env.NYXHIVE_GENERATED_SKILLS_DIR?.trim()) {
    return resolve(process.env.NYXHIVE_GENERATED_SKILLS_DIR);
  }
  return resolve(process.cwd(), ".nyxhive", "skills", "generated");
}

export function getSkillRoots(opts: { includeGenerated?: boolean } = {}): SkillRoot[] {
  const curated = uniqueResolved([getSkillsDir(), ...splitPathEnv(process.env.NYXHIVE_EXTRA_SKILLS_DIRS)])
    .map((path) => ({ kind: "curated" as const, path }));
  if (!opts.includeGenerated) return curated;
  const generated = uniqueResolved([getGeneratedSkillsDir(), ...splitPathEnv(process.env.NYXHIVE_EXTRA_GENERATED_SKILLS_DIRS)])
    .map((path) => ({ kind: "generated" as const, path }));
  const roots: SkillRoot[] = [...curated];
  const seen = new Set(roots.map((root) => root.path));
  for (const root of generated) {
    if (seen.has(root.path)) continue;
    seen.add(root.path);
    roots.push(root);
  }
  return roots;
}

export function resolveSkill(skillName: string, opts: { includeGenerated?: boolean } = {}): SkillResolution | null {
  const normalized = normalizeSkillName(skillName);
  if (!normalized) return null;
  for (const root of getSkillRoots({ includeGenerated: opts.includeGenerated ?? true })) {
    const skillDir = resolve(root.path, normalized);
    if (!isInside(root.path, skillDir)) continue;
    const skillPath = join(skillDir, "SKILL.md");
    if (existsSync(skillPath)) {
      return { name: normalized, root, skillDir, skillPath };
    }
  }
  return null;
}

export function listAvailableSkills(opts: { includeGenerated?: boolean } = {}): string[] {
  const names = new Set<string>();
  for (const root of getSkillRoots({ includeGenerated: opts.includeGenerated ?? false })) {
    if (!existsSync(root.path)) continue;
    for (const entry of readdirSync(root.path, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (!opts.includeGenerated && entry.name.startsWith("auto-")) continue;
      const normalized = normalizeSkillName(entry.name);
      if (!normalized) continue;
      if (existsSync(join(root.path, normalized, "SKILL.md"))) names.add(normalized);
    }
  }
  return [...names].sort();
}

function listSkillResolutions(opts: { includeGenerated?: boolean } = {}): SkillResolution[] {
  const resolutions: SkillResolution[] = [];
  const seen = new Set<string>();
  for (const root of getSkillRoots({ includeGenerated: opts.includeGenerated ?? false })) {
    if (!existsSync(root.path)) continue;
    for (const entry of readdirSync(root.path, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (!opts.includeGenerated && entry.name.startsWith("auto-")) continue;
      const normalized = normalizeSkillName(entry.name);
      if (!normalized) continue;
      const skillDir = resolve(root.path, normalized);
      if (!isInside(root.path, skillDir)) continue;
      const skillPath = join(skillDir, "SKILL.md");
      if (!existsSync(skillPath)) continue;
      const key = `${root.kind}:${root.path}:${normalized}`;
      if (seen.has(key)) continue;
      seen.add(key);
      resolutions.push({ name: normalized, root, skillDir, skillPath });
    }
  }
  return resolutions.sort((left, right) => left.name.localeCompare(right.name));
}

function readStringFrontmatter(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function auditSkills(opts: { includeGenerated?: boolean } = {}): SkillAuditReport {
  const skills = listSkillResolutions(opts).map((skill): SkillAuditEntry => {
    const content = readFileSync(skill.skillPath, "utf-8");
    const parsed = parseFrontmatter(content).frontmatter;
    const fmName = readStringFrontmatter(parsed.name);
    const description = readStringFrontmatter(parsed.description);
    const issues: string[] = [];

    if (!fmName) {
      issues.push("frontmatter.name is required");
    } else if (fmName !== skill.name) {
      issues.push("frontmatter.name must match directory name");
    }
    if (!description) issues.push("frontmatter.description is required");

    return {
      name: skill.name,
      path: skill.skillPath,
      rootKind: skill.root.kind,
      status: issues.length === 0 ? "pass" : "fail",
      frontmatter: { name: fmName, description },
      issues,
    };
  });

  return {
    ok: skills.every((skill) => skill.status === "pass"),
    skills,
  };
}

export function exportSkillCatalog(report = auditSkills()): ExportedSkillCatalog {
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    skills: report.skills
      .map((skill) => ({
        name: skill.name,
        description: skill.frontmatter.description,
        path: skill.path,
        rootKind: skill.rootKind,
        portable: skill.status === "pass",
      }))
      .sort((left, right) => {
        if (left.portable !== right.portable) return left.portable ? -1 : 1;
        return left.name.localeCompare(right.name);
      }),
  };
}

export function loadSkillContent(skillName: string, opts: { includeGenerated?: boolean } = {}): string | null {
  const resolved = resolveSkill(skillName, { includeGenerated: opts.includeGenerated ?? true });
  if (!resolved) return null;
  return readFileSync(resolved.skillPath, "utf-8");
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9._/-]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 4);
}

function toUniqueTokens(text: string): string[] {
  return [...new Set(tokenize(text))];
}

function buildPhrases(tokens: string[]): Set<string> {
  const phrases = new Set<string>();
  for (let i = 0; i < tokens.length - 1; i += 1) {
    phrases.add(`${tokens[i]} ${tokens[i + 1]}`);
  }
  return phrases;
}

function splitPathSegments(token: string): string[] {
  return token
    .split(/[/._-]+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 4);
}

function scoreTokenOverlap(taskTokens: string[], draftTokens: string[]): number {
  const taskTokenSet = new Set(taskTokens);
  const seen = new Set<string>();
  let score = 0;

  for (const token of draftTokens) {
    if (!taskTokenSet.has(token) || seen.has(token)) continue;
    seen.add(token);
    score += token.includes("/") || token.includes(".") ? 6 : 2;
  }

  return score;
}

function scorePathSegmentOverlap(taskTokens: string[], draftTokens: string[]): number {
  const taskSegments = new Set(taskTokens.flatMap(splitPathSegments));
  if (taskSegments.size === 0) return 0;

  let score = 0;
  const seen = new Set<string>();
  for (const token of draftTokens) {
    if (!token.includes("/") && !token.includes(".")) continue;
    for (const segment of splitPathSegments(token)) {
      if (!taskSegments.has(segment) || seen.has(segment)) continue;
      seen.add(segment);
      score += 2;
    }
  }

  return score;
}

function scorePhraseOverlap(taskTokens: string[], draftTokens: string[]): number {
  const taskPhrases = buildPhrases(taskTokens);
  if (taskPhrases.size === 0) return 0;

  let score = 0;
  for (const phrase of buildPhrases(draftTokens)) {
    if (taskPhrases.has(phrase)) score += 4;
  }
  return score;
}

function scorePublishedDraft(
  taskMessage: string,
  draft: ProceduralSkillDraft,
  opts?: { conversationId?: string },
): number {
  const taskTokens = toUniqueTokens(taskMessage);
  if (taskTokens.length === 0) return 0;

  const titleTokens = toUniqueTokens(draft.title);
  const summaryTokens = toUniqueTokens(draft.summary);
  const skillNameTokens = toUniqueTokens(draft.published_skill_name ?? "");
  const bodyTokens = toUniqueTokens(draft.draft_markdown.slice(0, 1200));

  let score = 0;
  score += scoreTokenOverlap(taskTokens, titleTokens) * 2;
  score += scoreTokenOverlap(taskTokens, summaryTokens);
  score += scoreTokenOverlap(taskTokens, skillNameTokens);
  score += scoreTokenOverlap(taskTokens, bodyTokens);
  score += scorePathSegmentOverlap(taskTokens, [...titleTokens, ...summaryTokens, ...bodyTokens]);
  score += scorePhraseOverlap(taskTokens, [...titleTokens, ...summaryTokens, ...bodyTokens]);

  if (score === 0) return 0;
  if (opts?.conversationId && draft.conversation_id && draft.conversation_id === opts.conversationId) {
    score += 8;
  }
  score += Math.min(draft.usage_count, 5);
  score += Math.min(draft.success_count * 2, 8);
  const successRate = getProceduralSkillSuccessRate(draft);
  if (successRate !== null) score += Math.round(successRate * 6);
  if (needsProceduralSkillAudit(draft)) score -= 8;
  return score;
}

function selectPublishedAutoSkills(opts: LoadAgentSkillsOptions): ProceduralSkillDraft[] {
  if (!opts.agentKey || !opts.taskMessage?.trim() || !opts.proceduralSkills) return [];

  const published = opts.proceduralSkills.list({
    status: "published",
    agentKey: opts.agentKey,
    limit: 50,
  });

  return published
    .map((draft) => ({
      draft,
      score: scorePublishedDraft(opts.taskMessage!, draft, { conversationId: opts.conversationId }),
    }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      if (b.draft.usage_count !== a.draft.usage_count) return b.draft.usage_count - a.draft.usage_count;
      return b.draft.id - a.draft.id;
    })
    .slice(0, opts.maxAutoSkills ?? 2)
    .map((entry) => entry.draft);
}

export interface LoadAgentSkillsOptions {
  agentSkills?: string[];
  agentKey?: string;
  taskMessage?: string;
  conversationId?: string;
  proceduralSkills?: ProceduralSkillDraftStore;
  maxAutoSkills?: number;
}

export interface ResolvedAgentSkills {
  content: string;
  selectedAutoSkills: ProceduralSkillDraft[];
}

export function resolveAgentSkills(agentSkillsOrOptions?: string[] | LoadAgentSkillsOptions): ResolvedAgentSkills {
  const opts: LoadAgentSkillsOptions = Array.isArray(agentSkillsOrOptions)
    ? { agentSkills: agentSkillsOrOptions }
    : (agentSkillsOrOptions ?? {});

  if (opts.agentSkills !== undefined && opts.agentSkills.length === 0) {
    return { content: "", selectedAutoSkills: [] };
  }
  const toLoad = opts.agentSkills !== undefined ? opts.agentSkills : listAvailableSkills();
  const parts: string[] = [];
  const loaded = new Set<string>();
  for (const skillName of toLoad) {
    const normalized = normalizeSkillName(skillName);
    if (!normalized || loaded.has(normalized)) continue;
    loaded.add(normalized);
    const content = loadSkillContent(normalized, { includeGenerated: opts.agentSkills !== undefined });
    if (content !== null) {
      parts.push(`--- SKILL: ${skillName} ---\n${content}`);
    }
  }

  const autoSkills = selectPublishedAutoSkills(opts);
  for (const draft of autoSkills) {
    const autoSkillBody = loadPublishedProceduralSkillContent(draft);
    parts.push(`--- AUTO SKILL: ${draft.published_skill_name ?? `auto-${draft.id}`} ---\n${autoSkillBody}`);
    opts.proceduralSkills?.recordUsage(draft.id);
  }

  return {
    content: parts.join("\n\n"),
    selectedAutoSkills: autoSkills,
  };
}

export function loadAgentSkills(agentSkillsOrOptions?: string[] | LoadAgentSkillsOptions): string {
  return resolveAgentSkills(agentSkillsOrOptions).content;
}

function loadPublishedProceduralSkillContent(draft: ProceduralSkillDraft): string {
  const publishedPath = draft.published_skill_path?.trim();
  if (publishedPath && existsSync(publishedPath)) {
    const resolvedPath = resolve(publishedPath);
    const trusted = getSkillRoots({ includeGenerated: true }).some((root) => isInside(root.path, resolvedPath));
    if (trusted) return readFileSync(resolvedPath, "utf-8");
  }
  return draft.draft_markdown;
}

export function generatePluginJson(targetDir: string): void {
  const pluginDir = join(targetDir, ".claude-plugin");
  mkdirSync(pluginDir, { recursive: true });
  const pluginJson = {
    skillsPath: getSkillsDir(),
    nyxhiveSkills: {
      roots: getSkillRoots({ includeGenerated: true }),
      generatedSkillsPath: getGeneratedSkillsDir(),
    },
  };
  writeFileSync(join(pluginDir, "plugin.json"), JSON.stringify(pluginJson, null, 2));
}

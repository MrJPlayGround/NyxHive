import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { ProceduralSkillDraftStore } from "../memory/procedural-skills.js";
import { getGeneratedSkillsDir, getSkillRoots, normalizeSkillName } from "./skill-loader.js";

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function deriveBaseSkillName(title: string, preferredSkillName?: string): string {
  const preferred = preferredSkillName?.trim();
  if (preferred) {
    const cleaned = slugify(preferred);
    return cleaned.startsWith("auto-") ? cleaned : `auto-${cleaned}`;
  }

  const withoutPrefix = title.replace(/^workflow:\s*/i, "").trim();
  const slug = slugify(withoutPrefix).slice(0, 48) || "workflow";
  return `auto-${slug}`;
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!!rel && !rel.startsWith("..") && !rel.startsWith("/"));
}

function isTrustedSkillPath(skillPath: string, targetDir: string): boolean {
  const resolvedPath = resolve(skillPath);
  const roots = [resolve(targetDir), ...getSkillRoots({ includeGenerated: true }).map((root) => root.path)];
  return roots.some((root) => isInside(root, resolvedPath));
}

function skillNameExistsAnywhere(skillName: string, targetDir: string): boolean {
  const roots = getSkillRoots({ includeGenerated: true });
  const candidates = [targetDir, ...roots.map((root) => root.path)];
  const seen = new Set<string>();
  for (const root of candidates) {
    const resolvedRoot = resolve(root);
    if (seen.has(resolvedRoot)) continue;
    seen.add(resolvedRoot);
    if (existsSync(join(resolvedRoot, skillName))) return true;
  }
  return false;
}

function ensureUniqueSkillName(baseName: string, skillsDir: string): string {
  let candidate = baseName;
  let suffix = 2;
  while (skillNameExistsAnywhere(candidate, skillsDir)) {
    candidate = `${baseName}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function renderSkillBody(draft: { title: string; summary: string; draft_markdown: string }, skillName: string): string {
  const body = draft.draft_markdown.trim();
  const hasFrontmatter = body.startsWith("---\n");
  const frontmatter = [
    "---",
    `name: ${skillName}`,
    `description: ${draft.summary.replace(/\s+/g, " ").slice(0, 180)}`,
    "category: Agent Memory",
    "tags: [procedural, generated, nyxhive]",
    "---",
    "",
  ].join("\n");

  return [
    "<!-- Generated from NyxHive procedural skill draft. Review and refine freely. -->",
    hasFrontmatter ? body : `${frontmatter}${body}`,
    "",
  ].join("\n");
}

export function publishProceduralSkillDraft(
  store: ProceduralSkillDraftStore,
  draftId: number,
  opts?: { skillName?: string; skillsDir?: string; refine?: boolean },
): { skillName: string; skillPath: string } {
  const draft = store.getById(draftId);
  if (!draft) {
    throw new Error(`Procedural skill draft ${draftId} not found`);
  }

  const skillsDir = resolve(opts?.skillsDir ?? getGeneratedSkillsDir());
  mkdirSync(skillsDir, { recursive: true });

  if (draft.status === "published" && draft.published_skill_name) {
    const storedPath = draft.published_skill_path?.trim();
    const existingPath = storedPath && isTrustedSkillPath(storedPath, skillsDir)
      ? storedPath
      : join(skillsDir, draft.published_skill_name, "SKILL.md");
    if (existsSync(existingPath) && !opts?.refine) {
      return { skillName: draft.published_skill_name, skillPath: existingPath };
    }
    if (opts?.refine || !skillNameExistsAnywhere(draft.published_skill_name, skillsDir) || existsSync(join(skillsDir, draft.published_skill_name))) {
      const skillDir = dirname(existingPath);
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(existingPath, renderSkillBody(draft, draft.published_skill_name), "utf-8");
      store.publish(draftId, draft.published_skill_name, existingPath);
      return { skillName: draft.published_skill_name, skillPath: existingPath };
    }
  }

  const baseName = deriveBaseSkillName(draft.title, opts?.skillName);
  const normalizedBaseName = normalizeSkillName(baseName) ?? "auto-workflow";
  const skillName = ensureUniqueSkillName(normalizedBaseName, skillsDir);
  const skillDir = join(skillsDir, skillName);
  const skillPath = join(skillDir, "SKILL.md");

  mkdirSync(skillDir, { recursive: true });
  writeFileSync(skillPath, renderSkillBody(draft, skillName), "utf-8");
  store.publish(draftId, skillName, skillPath);

  return { skillName, skillPath };
}

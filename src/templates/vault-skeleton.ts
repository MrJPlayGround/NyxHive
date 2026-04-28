import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { NyxTemplate } from "./types.js";

export interface VaultSkeleton {
  folders: string[];
  files: Record<string, string>; // path -> content (Obsidian markdown)
  tags: string[];
}

const DEFAULT_FOLDERS = [
  "Learnings",
  "Knowledge",
  "Knowledge/Architecture",
  "Knowledge/Processes",
  "Knowledge/Tools",
];

const DEFAULT_TAGS = [
  "architecture",
  "process",
  "tool",
  "learning",
];

export function generateVaultSkeleton(instanceName: string, template?: NyxTemplate): VaultSkeleton {
  const date = new Date().toISOString().split("T")[0];

  // Merge template-specific folders with defaults
  const templateFolders = template?.knowledge?.vault_skeleton?.folders ?? [];
  const folders = [...DEFAULT_FOLDERS];
  for (const f of templateFolders) {
    if (!folders.includes(f)) folders.push(f);
  }
  // Learnings always present
  if (!folders.includes("Learnings")) folders.unshift("Learnings");

  // Merge tags
  const templateTags = template?.knowledge?.vault_skeleton?.index_tags ?? [];
  const tags = [...new Set([...DEFAULT_TAGS, ...templateTags])];

  // Build README
  const tagSection = tags.map(t => `- \`#${t}\``).join("\n");

  // Template-specific sections
  const templateSections = template?.knowledge?.vault_skeleton?.readme_sections ?? [];
  const extraSections = templateSections.length > 0
    ? `\n## Sections\n\n${templateSections.map(s =>
        `- [[${s.title}]] -- ${s.description}`
      ).join("\n")}\n`
    : "\n## Sections\n\n- [[Knowledge]] -- Curated reference material\n- [[Learnings]] -- Auto-captured insights from conversations\n";

  const readme = `---
title: ${instanceName} Knowledge Vault
tags:
  - index
  - vault-root
created: ${date}
---

# ${instanceName} Knowledge Vault

This vault is managed by NyxHive. It contains curated knowledge and auto-generated learnings.
${extraSections}
## Tags

Use tags to organize and filter:
${tagSection}

## How It Works

Agents search this vault during conversations using semantic similarity.
High-quality notes with proper tags, links, and frontmatter surface better.

> [!tip] Improve Results
> Add \`importance: high\` to frontmatter of critical notes.
> Use \`[[wiki links]]\` to connect related concepts.
> Mark outdated notes with \`status: archived\`.
`;

  const files: Record<string, string> = {
    "README.md": readme,
  };

  // Minimal .obsidian config
  files[".obsidian/app.json"] = JSON.stringify({ strictLineBreaks: false }, null, 2);

  return { folders, files, tags };
}

export function createVaultStructure(vaultPath: string, skeleton: VaultSkeleton): void {
  // Create folders
  for (const folder of skeleton.folders) {
    mkdirSync(join(vaultPath, folder), { recursive: true });
  }

  // Write files (never overwrite existing)
  for (const [relPath, content] of Object.entries(skeleton.files)) {
    const fullPath = join(vaultPath, relPath);
    const dir = fullPath.substring(0, fullPath.lastIndexOf("/"));
    if (dir) mkdirSync(dir, { recursive: true });

    if (!existsSync(fullPath)) {
      writeFileSync(fullPath, content, "utf-8");
    }
  }
}

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, relative, basename } from "node:path";

const DEFAULT_SKIP_DIRS = new Set([
  ".obsidian",
  ".trash",
  ".git",
  "node_modules",
  ".smart-connections",
]);

export interface VaultFile {
  path: string;       // relative path from vault root
  title: string;      // filename without .md
  category: string;   // top-level directory name
  content: string;    // raw markdown content
}

export interface VaultConfig {
  path: string;
  skipDirs?: string[];
}

export function listVaultFiles(config: VaultConfig): VaultFile[] {
  const vaultRoot = config.path;
  const skipDirs = new Set([...DEFAULT_SKIP_DIRS, ...(config.skipDirs ?? [])]);
  const files: VaultFile[] = [];

  function walk(dir: string): void {
    const entries = readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.name.startsWith(".") && skipDirs.has(entry.name)) continue;
      if (skipDirs.has(entry.name)) continue;

      const fullPath = join(dir, entry.name);

      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.name.endsWith(".md") && !entry.name.startsWith("._")) {
        const relPath = relative(vaultRoot, fullPath);
        const title = basename(entry.name, ".md");
        const topDir = relPath.includes("/") ? relPath.split("/")[0] : "root";

        try {
          const content = readFileSync(fullPath, "utf-8");
          // Skip empty or very short files
          if (content.trim().length < 20) continue;

          files.push({
            path: relPath,
            title,
            category: topDir.toLowerCase(),
            content,
          });
        } catch {
          // Skip unreadable files
        }
      }
    }
  }

  walk(vaultRoot);
  return files;
}

/**
 * Write a markdown note to an Obsidian vault.
 * Creates intermediate directories as needed.
 * Returns the relative path of the written file.
 *
 * @param vaultPath - Absolute path to the vault root
 * @param category - Subdirectory within the vault (e.g. "Learnings", "Architecture")
 * @param title - Note title (used as filename, .md appended)
 * @param content - Full markdown content (including frontmatter if desired)
 * @param overwrite - If false (default), appends a timestamp suffix to avoid clobbering existing notes
 */
export function writeVaultNote(
  vaultPath: string,
  category: string,
  title: string,
  content: string,
  overwrite = false,
): string {
  // Sanitize title for filesystem
  const safeTitle = title.replace(/[<>:"/\\|?*]/g, "-").replace(/\s+/g, " ").trim();
  const dir = join(vaultPath, category);

  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  let filename = `${safeTitle}.md`;
  const fullPath = join(dir, filename);

  // If file exists and we're not overwriting, add timestamp suffix
  if (!overwrite && existsSync(fullPath)) {
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    filename = `${safeTitle} ${ts}.md`;
  }

  const finalPath = join(dir, filename);
  writeFileSync(finalPath, content, "utf-8");

  return relative(vaultPath, finalPath);
}

import { parse as parseYaml } from "yaml";

export interface ParsedFrontmatter {
  frontmatter: Record<string, unknown>;
  body: string;
}

/**
 * Parse YAML frontmatter from a Markdown file.
 * Frontmatter is delimited by --- markers at the start of the file.
 */
export function parseFrontmatter(content: string): ParsedFrontmatter {
  const trimmed = content.trimStart();

  if (!trimmed.startsWith("---")) {
    return { frontmatter: {}, body: content.trim() };
  }

  const endIndex = trimmed.indexOf("\n---", 3);
  if (endIndex === -1) {
    return { frontmatter: {}, body: content.trim() };
  }

  const yamlStr = trimmed.slice(4, endIndex).trim();
  const bodyStr = trimmed.slice(endIndex + 4).trim();
  const frontmatter = yamlStr ? (parseYaml(yamlStr) ?? {}) : {};

  return {
    frontmatter: typeof frontmatter === "object" && frontmatter !== null
      ? frontmatter as Record<string, unknown>
      : {},
    body: bodyStr,
  };
}

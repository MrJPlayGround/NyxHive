import { NyxTemplateSchema, type NyxTemplate } from "./types.js";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { formatError } from "../utils/error.js";
import { normalizeObsidianPath } from "../utils/obsidian-paths.js";

export const BUILTIN_TEMPLATES_DIR = join(import.meta.dir, "../../templates");
export const LOCAL_TEMPLATES_DIR = join(homedir(), ".nyxhive/templates");

export function resolveTemplatePath(id: string): string | null {
  // Absolute path
  if (isAbsolute(id)) {
    const templateJson = join(id, "template.json");
    return existsSync(templateJson) ? id : null;
  }

  // Built-in
  const builtIn = join(BUILTIN_TEMPLATES_DIR, id);
  if (existsSync(join(builtIn, "template.json"))) return builtIn;

  // Local
  const local = join(LOCAL_TEMPLATES_DIR, id);
  if (existsSync(join(local, "template.json"))) return local;

  return null;
}

export function loadTemplate(pathOrId: string): NyxTemplate {
  const templateDir = isAbsolute(pathOrId) && existsSync(join(pathOrId, "template.json"))
    ? pathOrId
    : resolveTemplatePath(pathOrId);

  if (!templateDir) {
    throw new Error(`Template not found: ${pathOrId}`);
  }

  const jsonPath = join(templateDir, "template.json");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(jsonPath, "utf-8"));
  } catch (err) {
    throw new Error(`Failed to parse template.json for ${pathOrId}: ${formatError(err)}`);
  }
  const result = NyxTemplateSchema.safeParse(raw);

  if (!result.success) {
    const errors = result.error.issues.map(e => `  ${e.path.join(".")}: ${e.message}`).join("\n");
    throw new Error(`Invalid template ${pathOrId}:\n${errors}`);
  }

  return result.data;
}

export function listTemplates(): Array<{ id: string; path: string; template: NyxTemplate }> {
  const templates: Array<{ id: string; path: string; template: NyxTemplate }> = [];
  const seen = new Set<string>();

  for (const dir of [BUILTIN_TEMPLATES_DIR, LOCAL_TEMPLATES_DIR]) {
    if (!existsSync(dir)) continue;

    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (seen.has(entry.name)) continue;

      const templateJson = join(dir, entry.name, "template.json");
      if (!existsSync(templateJson)) continue;

      try {
        const template = loadTemplate(join(dir, entry.name));
        seen.add(entry.name);
        templates.push({ id: entry.name, path: join(dir, entry.name), template });
      } catch {
        // Skip invalid templates
      }
    }
  }

  return templates;
}

export function validateTemplateDir(templatePath: string): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const absPath = resolve(templatePath);

  // Check template.json exists
  const jsonPath = join(absPath, "template.json");
  if (!existsSync(jsonPath)) {
    return { valid: false, errors: ["template.json not found"] };
  }

  // Validate schema
  let template: NyxTemplate;
  try {
    const raw = JSON.parse(readFileSync(jsonPath, "utf-8"));
    const result = NyxTemplateSchema.safeParse(raw);
    if (!result.success) {
      for (const err of result.error.issues) {
        errors.push(`Schema: ${err.path.join(".")}: ${err.message}`);
      }
      return { valid: false, errors };
    }
    template = result.data;
  } catch (err) {
    return { valid: false, errors: [`Failed to parse template.json: ${err}`] };
  }

  // Validate knowledge vault exists if configured
  if (template.knowledge) {
    const vaultPath = isAbsolute(template.knowledge.vault_path)
      ? normalizeObsidianPath(template.knowledge.vault_path)!
      : join(absPath, template.knowledge.vault_path);

    if (!existsSync(vaultPath)) {
      errors.push(`Knowledge vault not found: ${vaultPath}`);
    }
  }

  // Validate theme icon if set
  if (template.theme.icon) {
    const iconPath = join(absPath, "assets", template.theme.icon);
    if (!existsSync(iconPath)) {
      errors.push(`Theme icon not found: ${iconPath}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

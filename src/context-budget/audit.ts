import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadSoulV2Directory } from "../soul/loader-v2.js";
import { compileSoulV2 } from "../soul/compiler-v2.js";
import { composeSystemPrompt } from "../soul/compiler.js";
import { SDK_TOOLS, SDK_UTILITY_TOOLS, SDK_WRITE_TOOLS } from "../agents/tools.js";

export type ContextBudgetComponentKind = "soul_prompts" | "skills" | "local_tools" | "mcp_tools";
export type ContextBudgetSeverity = "warn" | "high";

export interface ContextBudgetDetail {
  name: string;
  path?: string;
  tokens: number;
  chars: number;
  lines: number;
  notes?: string[];
}

export interface ContextBudgetComponent {
  kind: ContextBudgetComponentKind;
  label: string;
  count: number;
  tokens: number;
  chars: number;
  details: ContextBudgetDetail[];
}

export interface ContextBudgetIssue {
  severity: ContextBudgetSeverity;
  component: ContextBudgetComponentKind;
  message: string;
  estimatedSavingsTokens: number;
}

export interface ContextBudgetReport {
  rootDir: string;
  totalTokens: number;
  generatedAt: number;
  components: ContextBudgetComponent[];
  issues: ContextBudgetIssue[];
  recommendations: ContextBudgetIssue[];
}

const HEAVY_SKILL_LINES = 400;
const HEAVY_SKILL_TOKENS = 3000;
const HEAVY_SOUL_TOKENS = 4000;
const VERY_HEAVY_SOUL_TOKENS = 8000;
const MCP_TOOL_SCHEMA_ESTIMATE = 500;
const LOCAL_TOOL_WARN_COUNT = 20;
const MCP_TOOL_WARN_COUNT = 20;

function lineCount(text: string): number {
  if (!text) return 0;
  return text.split(/\r?\n/).length;
}

export function estimateContextTokens(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;

  const syntaxChars = (trimmed.match(/[{}[\]();:=<>]/g) ?? []).length;
  const syntaxDensity = syntaxChars / Math.max(trimmed.length, 1);
  if (syntaxDensity > 0.04) {
    return Math.ceil(trimmed.length / 4);
  }

  const words = trimmed.split(/\s+/).filter(Boolean).length;
  return Math.ceil(words * 1.3);
}

function listSubdirs(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function makeComponent(
  kind: ContextBudgetComponentKind,
  label: string,
  details: ContextBudgetDetail[],
): ContextBudgetComponent {
  return {
    kind,
    label,
    count: details.length,
    tokens: details.reduce((sum, detail) => sum + detail.tokens, 0),
    chars: details.reduce((sum, detail) => sum + detail.chars, 0),
    details: [...details].sort((a, b) => b.tokens - a.tokens),
  };
}

function analyzeSkills(rootDir: string, issues: ContextBudgetIssue[]): ContextBudgetComponent {
  const skillsDir = join(rootDir, "skills");
  const details: ContextBudgetDetail[] = [];

  for (const name of listSubdirs(skillsDir)) {
    const skillPath = join(skillsDir, name, "SKILL.md");
    if (!existsSync(skillPath)) continue;
    const content = readFileSync(skillPath, "utf-8");
    const tokens = estimateContextTokens(content);
    const lines = lineCount(content);
    const notes: string[] = [];

    if (lines > HEAVY_SKILL_LINES) notes.push("heavy");
    if (tokens > HEAVY_SKILL_TOKENS) notes.push("token-heavy");
    if (notes.length > 0) {
      issues.push({
        severity: tokens > HEAVY_SKILL_TOKENS ? "high" : "warn",
        component: "skills",
        message: `Skill ${name} is heavy (${lines} lines, ~${tokens} tokens)`,
        estimatedSavingsTokens: Math.max(0, tokens - HEAVY_SKILL_TOKENS),
      });
    }

    details.push({ name, path: skillPath, tokens, chars: content.length, lines, notes });
  }

  return makeComponent("skills", "Skills", details);
}

function analyzeSouls(rootDir: string, issues: ContextBudgetIssue[]): {
  component: ContextBudgetComponent;
  mcpToolRefs: Map<string, Set<string>>;
} {
  const soulsDir = join(rootDir, "souls");
  const details: ContextBudgetDetail[] = [];
  const mcpToolRefs = new Map<string, Set<string>>();

  for (const name of listSubdirs(soulsDir)) {
    if (name.startsWith("_")) continue;
    const soulDir = join(soulsDir, name);
    try {
      const loaded = loadSoulV2Directory(soulsDir, name);
      const soul = compileSoulV2(loaded);
      const prompt = composeSystemPrompt(soul);
      const tokens = estimateContextTokens(prompt);
      const notes: string[] = [];

      if (tokens > HEAVY_SOUL_TOKENS) notes.push("heavy");
      if (tokens > VERY_HEAVY_SOUL_TOKENS) notes.push("very-heavy");
      if (notes.length > 0) {
        issues.push({
          severity: tokens > VERY_HEAVY_SOUL_TOKENS ? "high" : "warn",
          component: "soul_prompts",
          message: `Soul prompt ${name} is heavy (~${tokens} tokens)`,
          estimatedSavingsTokens: Math.max(0, tokens - HEAVY_SOUL_TOKENS),
        });
      }

      for (const tool of soul.capabilities.mcp_tools) {
        if (!mcpToolRefs.has(tool)) mcpToolRefs.set(tool, new Set());
        mcpToolRefs.get(tool)!.add(name);
      }

      details.push({ name, path: soulDir, tokens, chars: prompt.length, lines: lineCount(prompt), notes });
    } catch (err) {
      issues.push({
        severity: "high",
        component: "soul_prompts",
        message: `Could not compile soul ${name}: ${err instanceof Error ? err.message : String(err)}`,
        estimatedSavingsTokens: 0,
      });
    }
  }

  return { component: makeComponent("soul_prompts", "Soul prompts", details), mcpToolRefs };
}

function analyzeLocalTools(issues: ContextBudgetIssue[]): ContextBudgetComponent {
  const tools = [...SDK_TOOLS, ...SDK_UTILITY_TOOLS, ...SDK_WRITE_TOOLS];
  const unique = new Map<string, string>();

  for (const tool of tools) {
    unique.set(tool.name, JSON.stringify(tool));
  }

  const details = [...unique.entries()].map(([name, schema]) => ({
    name,
    tokens: estimateContextTokens(schema),
    chars: schema.length,
    lines: 1,
  }));

  if (details.length > LOCAL_TOOL_WARN_COUNT) {
    issues.push({
      severity: "warn",
      component: "local_tools",
      message: `${details.length} local SDK tools are defined; broad tool exposure can dominate native API turns`,
      estimatedSavingsTokens: Math.max(0, details.length - LOCAL_TOOL_WARN_COUNT) * 250,
    });
  }

  return makeComponent("local_tools", "Local SDK tools", details);
}

function analyzeMcpTools(mcpToolRefs: Map<string, Set<string>>, issues: ContextBudgetIssue[]): ContextBudgetComponent {
  const details: ContextBudgetDetail[] = [...mcpToolRefs.entries()].map(([name, agents]) => ({
    name,
    tokens: MCP_TOOL_SCHEMA_ESTIMATE,
    chars: name.length,
    lines: 1,
    notes: [`agents:${[...agents].sort().join(",")}`],
  }));

  if (details.length > MCP_TOOL_WARN_COUNT) {
    issues.push({
      severity: "warn",
      component: "mcp_tools",
      message: `${details.length} unique MCP tools are allowed across souls`,
      estimatedSavingsTokens: Math.max(0, details.length - MCP_TOOL_WARN_COUNT) * MCP_TOOL_SCHEMA_ESTIMATE,
    });
  }

  return makeComponent("mcp_tools", "MCP allowlist", details);
}

export function analyzeContextBudget(rootDir: string): ContextBudgetReport {
  const resolvedRoot = resolve(rootDir);
  if (!existsSync(resolvedRoot) || !statSync(resolvedRoot).isDirectory()) {
    throw new Error(`Context budget root is not a directory: ${resolvedRoot}`);
  }

  const issues: ContextBudgetIssue[] = [];
  const soulAnalysis = analyzeSouls(resolvedRoot, issues);
  const components = [
    soulAnalysis.component,
    analyzeSkills(resolvedRoot, issues),
    analyzeLocalTools(issues),
    analyzeMcpTools(soulAnalysis.mcpToolRefs, issues),
  ];

  return {
    rootDir: resolvedRoot,
    generatedAt: Date.now(),
    totalTokens: components.reduce((sum, component) => sum + component.tokens, 0),
    components,
    issues: issues.sort((a, b) => {
      if (a.severity !== b.severity) return a.severity === "high" ? -1 : 1;
      return b.estimatedSavingsTokens - a.estimatedSavingsTokens;
    }),
    recommendations: issues
      .filter((issue) => issue.estimatedSavingsTokens > 0)
      .sort((a, b) => b.estimatedSavingsTokens - a.estimatedSavingsTokens)
      .slice(0, 3),
  };
}

export function formatContextBudgetReport(report: ContextBudgetReport, opts?: { verbose?: boolean }): string {
  const lines = [
    "Context Budget Report",
    `Root: ${report.rootDir}`,
    `Estimated overhead: ~${report.totalTokens.toLocaleString()} tokens`,
    "",
    "Components:",
  ];

  for (const component of report.components) {
    lines.push(`- ${component.label}: ${component.count} items, ~${component.tokens.toLocaleString()} tokens`);
    if (opts?.verbose) {
      for (const detail of component.details.slice(0, 8)) {
        const notes = detail.notes?.length ? ` (${detail.notes.join(", ")})` : "";
        lines.push(`  - ${detail.name}: ~${detail.tokens.toLocaleString()} tokens, ${detail.lines} lines${notes}`);
      }
    }
  }

  lines.push("", `Issues: ${report.issues.length}`);
  if (report.issues.length === 0) {
    lines.push("- No obvious context bloat found.");
  } else {
    for (const issue of report.issues.slice(0, opts?.verbose ? 20 : 8)) {
      lines.push(`- [${issue.severity}] ${issue.message}`);
    }
  }

  if (report.recommendations.length > 0) {
    lines.push("", "Top savings:");
    for (const recommendation of report.recommendations) {
      lines.push(`- Save ~${recommendation.estimatedSavingsTokens.toLocaleString()} tokens: ${recommendation.message}`);
    }
  }

  return lines.join("\n");
}

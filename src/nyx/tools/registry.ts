/**
 * Client-side tool registry for the nyx CLI.
 *
 * Each tool definition includes:
 * - sensitivity: how risky this tool is (governs approval gate and display)
 * - renderInput: human-readable summary of the tool input
 *
 * Bun tree-shakes unused tool modules at bundle time.
 */

import { z } from "zod";

export type ToolSensitivity = "low" | "medium" | "high";

export interface ToolDef {
  /** How sensitive/risky this tool is. Used by approval gate and verbosity filter. */
  sensitivity: ToolSensitivity;
  /** Render a concise human-readable summary of the tool input. Max ~80 chars. */
  renderInput(input: unknown): string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function str(v: unknown): string {
  if (typeof v === "string") return v;
  if (v === null || v === undefined) return "";
  return JSON.stringify(v);
}

function truncate(s: string | undefined, max = 80): string {
  if (s === undefined || s === null) return "";
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

function fromObj(input: unknown, ...keys: string[]): string {
  if (typeof input !== "object" || input === null) return truncate(JSON.stringify(input));
  const obj = input as Record<string, unknown>;
  for (const key of keys) {
    if (key in obj && obj[key] !== undefined && obj[key] !== null) {
      return truncate(str(obj[key]));
    }
  }
  return truncate(JSON.stringify(input));
}

// ─── Tool Definitions ─────────────────────────────────────────────────────────

const BashSchema = z.object({ command: z.string() }).strip();
const Bash: ToolDef = {
  sensitivity: "high",
  renderInput(input) {
    const p = BashSchema.safeParse(input);
    return truncate(p.success ? p.data.command : str(input));
  },
};

const ReadSchema = z.object({ file_path: z.string(), offset: z.number().optional(), limit: z.number().optional() }).strip();
const ReadFile: ToolDef = {
  sensitivity: "low",
  renderInput(input) {
    const p = ReadSchema.safeParse(input);
    if (!p.success) return truncate(str(input));
    const { file_path, offset, limit } = p.data;
    const suffix = offset || limit ? ` [${offset ?? 0}+${limit ?? "all"}]` : "";
    return truncate(file_path + suffix);
  },
};

const WriteSchema = z.object({ file_path: z.string(), content: z.string() }).strip();
const WriteFile: ToolDef = {
  sensitivity: "medium",
  renderInput(input) {
    const p = WriteSchema.safeParse(input);
    if (!p.success) return truncate(str(input));
    const lines = p.data.content.split("\n").length;
    return truncate(`${p.data.file_path} (${lines} lines)`);
  },
};

const EditSchema = z.object({ file_path: z.string(), old_string: z.string(), new_string: z.string() }).strip();
const EditFile: ToolDef = {
  sensitivity: "medium",
  renderInput(input) {
    const p = EditSchema.safeParse(input);
    if (!p.success) return truncate(str(input));
    return truncate(p.data.file_path);
  },
};

const GlobSchema = z.object({ pattern: z.string(), path: z.string().optional() }).strip();
const GlobTool: ToolDef = {
  sensitivity: "low",
  renderInput(input) {
    const p = GlobSchema.safeParse(input);
    if (!p.success) return truncate(str(input));
    return truncate(p.data.path ? `${p.data.pattern} in ${p.data.path}` : p.data.pattern);
  },
};

const GrepSchema = z.object({ pattern: z.string(), path: z.string().optional(), glob: z.string().optional() }).strip();
const GrepTool: ToolDef = {
  sensitivity: "low",
  renderInput(input) {
    const p = GrepSchema.safeParse(input);
    if (!p.success) return truncate(str(input));
    const scope = p.data.path ?? p.data.glob ?? "";
    return truncate(scope ? `/${p.data.pattern}/ in ${scope}` : `/${p.data.pattern}/`);
  },
};

const WebFetchSchema = z.object({ url: z.string() }).strip();
const WebFetch: ToolDef = {
  sensitivity: "low",
  renderInput(input) {
    const p = WebFetchSchema.safeParse(input);
    return truncate(p.success ? p.data.url : str(input));
  },
};

const WebSearchSchema = z.object({ query: z.string() }).strip();
const WebSearch: ToolDef = {
  sensitivity: "low",
  renderInput(input) {
    const p = WebSearchSchema.safeParse(input);
    return truncate(p.success ? p.data.query : str(input));
  },
};

const AgentSchema = z.object({ description: z.string().optional(), prompt: z.string().optional(), subagent_type: z.string().optional() }).strip();
const AgentTool: ToolDef = {
  sensitivity: "medium",
  renderInput(input) {
    const p = AgentSchema.safeParse(input);
    if (!p.success) return truncate(str(input));
    const label = p.data.subagent_type ? `[${p.data.subagent_type}] ` : "";
    return truncate(label + (p.data.description ?? p.data.prompt ?? ""));
  },
};

const TodoSchema = z.object({ todos: z.array(z.object({ content: z.string() })).optional() }).strip();
const TodoTool: ToolDef = {
  sensitivity: "low",
  renderInput(input) {
    const p = TodoSchema.safeParse(input);
    if (!p.success) return truncate(str(input));
    const count = p.data.todos?.length ?? 0;
    return `${count} task${count !== 1 ? "s" : ""}`;
  },
};

/** Generic MCP tool — shows server + tool name + first notable field */
const McpTool: ToolDef = {
  sensitivity: "medium",
  renderInput(input) {
    return fromObj(input, "query", "message", "path", "id", "name", "url", "command");
  },
};

/** Fallback for unknown tools */
const DefaultTool: ToolDef = {
  sensitivity: "medium",
  renderInput(input) {
    return fromObj(input, "path", "query", "command", "message", "id", "url");
  },
};

// ─── Registry ─────────────────────────────────────────────────────────────────

/** Exact-name lookup table */
const exactMap = new Map<string, ToolDef>([
  ["Bash", Bash],
  ["Read", ReadFile],
  ["Write", WriteFile],
  ["Edit", EditFile],
  ["MultiEdit", EditFile],
  ["Glob", GlobTool],
  ["Grep", GrepTool],
  ["WebFetch", WebFetch],
  ["WebSearch", WebSearch],
  ["Agent", AgentTool],
  ["TodoWrite", TodoTool],
  ["TodoRead", TodoTool],
]);

/**
 * Look up a tool definition by name.
 * Falls back to McpTool for mcp__* names, DefaultTool otherwise.
 */
export function getToolDef(toolName: string): ToolDef {
  const exact = exactMap.get(toolName);
  if (exact) return exact;
  if (toolName.startsWith("mcp__")) return McpTool;
  return DefaultTool;
}

/** Convenience: get sensitivity for a tool name */
export function toolSensitivity(toolName: string): ToolSensitivity {
  return getToolDef(toolName).sensitivity;
}

/** Convenience: render tool input using the registry */
export function renderToolInput(toolName: string, input: unknown): string {
  return getToolDef(toolName).renderInput(input);
}

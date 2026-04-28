import type { AgentConfig } from "../types.js";
import type { ToolDefinition } from "../providers/types.js";
import { SDK_TOOLS, SDK_UTILITY_TOOLS, SDK_WRITE_TOOLS } from "./tools.js";
import { resolveAgentToolPolicy } from "./toolsets.js";

/**
 * Native API tool names keyed by common Claude CLI aliases.
 * Config may use either family; runtime enforcement normalizes both.
 */
export const CLAUDE_TO_NATIVE_TOOL: Record<string, string> = {
  Read: "read_file",
  Glob: "search_files",
  Grep: "search_code",
  LS: "list_directory",
  Write: "write_file",
  Edit: "edit_file",
  Bash: "run_command",
  TodoWrite: "todo_write",
  TodoRead: "todo_read",
  WebFetch: "web_fetch",
  WebSearch: "web_search",
};

const LOWER_TOOL_ALIASES = new Map<string, string>([
  ["read", "read_file"],
  ["glob", "search_files"],
  ["grep", "search_code"],
  ["ls", "list_directory"],
  ["write", "write_file"],
  ["edit", "edit_file"],
  ["bash", "run_command"],
  ["todowrite", "todo_write"],
  ["todoread", "todo_read"],
  ["webfetch", "web_fetch"],
  ["websearch", "web_search"],
  ["read_file", "read_file"],
  ["search_files", "search_files"],
  ["search_code", "search_code"],
  ["list_directory", "list_directory"],
  ["write_file", "write_file"],
  ["edit_file", "edit_file"],
  ["run_command", "run_command"],
  ["todo_write", "todo_write"],
  ["todo_read", "todo_read"],
  ["web_fetch", "web_fetch"],
  ["web_search", "web_search"],
  ["search_knowledge", "search_knowledge"],
]);

const READ_ONLY_TASK_TYPES = new Set([
  "review",
  "code_review",
  "analysis",
  "research",
  "audit",
  "explain",
]);

export function expandConfiguredToolName(name: string): string[] {
  const trimmed = name.trim();
  if (!trimmed) return [];
  return [
    trimmed,
    CLAUDE_TO_NATIVE_TOOL[trimmed],
    LOWER_TOOL_ALIASES.get(trimmed.toLowerCase()),
  ].filter((value, index, values): value is string => !!value && values.indexOf(value) === index);
}

export function isReadOnlyTaskType(taskType?: string): boolean {
  return !!taskType && READ_ONLY_TASK_TYPES.has(taskType);
}

export function filterLocalToolDefinitions(
  definitions: ToolDefinition[],
  agent: Pick<AgentConfig, "allowed_tools" | "disallowed_tools">,
): ToolDefinition[] {
  let filtered = definitions;
  const policy = resolveAgentToolPolicy(agent);

  if (policy.force_empty_allowlist) {
    filtered = [];
  } else if (policy.allowed_tools?.length) {
    const allowed = new Set(policy.allowed_tools.flatMap(expandConfiguredToolName));
    filtered = filtered.filter((definition) => allowed.has(definition.name));
  }

  if (policy.disallowed_tools?.length) {
    const blocked = new Set(policy.disallowed_tools.flatMap(expandConfiguredToolName));
    filtered = filtered.filter((definition) => !blocked.has(definition.name));
  }

  return filtered;
}

export function buildLocalToolDefinitions(opts: {
  useTools: boolean;
  canWrite: boolean;
  agent: Pick<AgentConfig, "allowed_tools" | "disallowed_tools">;
  taskType?: string;
  includeUtilityTools?: boolean;
}): ToolDefinition[] | undefined {
  if (!opts.useTools) return undefined;

  const effectiveWrite = opts.canWrite && !isReadOnlyTaskType(opts.taskType);
  const definitions = [
    ...SDK_TOOLS,
    ...(effectiveWrite ? SDK_WRITE_TOOLS : []),
    ...(opts.includeUtilityTools ? SDK_UTILITY_TOOLS : []),
  ];

  return filterLocalToolDefinitions(definitions, opts.agent);
}

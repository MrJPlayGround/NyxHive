import type { AgentConfig } from "../types.js";
import { expandConfiguredToolName } from "./tool-permissions.js";

export type ToolsetProfile =
  | "default"
  | "read_only"
  | "coding"
  | "proposal_exec"
  | "chat_safe"
  | "off";

const TOOLSET_TOOLS: Record<Exclude<ToolsetProfile, "default">, string[]> = {
  read_only: ["read_file", "search_files", "search_code", "list_directory", "search_knowledge", "todo_read", "web_search", "web_fetch"],
  coding: ["read_file", "search_files", "search_code", "list_directory", "search_knowledge", "todo_read", "todo_write", "write_file", "edit_file", "run_command"],
  proposal_exec: ["read_file", "search_files", "search_code", "list_directory", "search_knowledge", "todo_read", "todo_write", "write_file", "edit_file", "run_command"],
  chat_safe: ["search_knowledge", "todo_read"],
  off: [],
};

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

export function normalizeToolsetProfile(value: string | undefined): ToolsetProfile | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase().replace(/[-\s]+/g, "_");
  if (["default", "read_only", "coding", "proposal_exec", "chat_safe", "off"].includes(normalized)) {
    return normalized as ToolsetProfile;
  }
  return undefined;
}

export function resolveAgentToolPolicy(agent: Pick<AgentConfig, "allowed_tools" | "disallowed_tools" | "role"> & { toolset?: string }, opts: { defaultProfile?: ToolsetProfile } = {}): Pick<AgentConfig, "allowed_tools" | "disallowed_tools"> & { force_empty_allowlist?: boolean } {
  const profile = normalizeToolsetProfile(agent.toolset) ?? opts.defaultProfile ?? "default";
  const profileAllowed = profile === "default" ? undefined : TOOLSET_TOOLS[profile];
  if (profile !== "default" && profileAllowed !== undefined && profileAllowed.length === 0) {
    return {
      allowed_tools: [],
      force_empty_allowlist: true,
      ...(agent.disallowed_tools?.length ? { disallowed_tools: unique(agent.disallowed_tools.flatMap(expandConfiguredToolName)) } : {}),
    };
  }
  const allowed = profileAllowed
    ? unique([...(profileAllowed.flatMap(expandConfiguredToolName)), ...(agent.allowed_tools ?? []).flatMap(expandConfiguredToolName)])
    : agent.allowed_tools;
  const disallowed = unique((agent.disallowed_tools ?? []).flatMap(expandConfiguredToolName));
  return {
    ...(allowed ? { allowed_tools: allowed } : {}),
    ...(disallowed.length > 0 ? { disallowed_tools: disallowed } : {}),
  };
}

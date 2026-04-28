import { homedir } from "node:os";
import { normalize, resolve } from "node:path";
import type { AgentConfig } from "../types.js";

export type CodexSandboxMode = "read-only" | "workspace-write" | "danger-full-access";
export type CodexApprovalPolicy = "never" | "on-request" | "on-failure" | "untrusted";

export type CodexSecurityDecision = {
  sandboxMode: CodexSandboxMode;
  approvalPolicy: CodexApprovalPolicy;
  additionalDirectories: string[];
  authority: CodexAuthorityTrace;
};

export type CodexAuthorityTrace = {
  agent?: string;
  role?: string;
  capabilities: string[];
  hasExecutableAuthority: boolean;
  taskType?: string;
  nonMutatingTask: boolean;
  requiresExternalMutation: boolean;
  workingDirectory: string;
  additionalDirectories: string[];
  filteredAdditionalDirectories: string[];
  selectedReason: "non-mutating task" | "mutating workspace task" | "external mutation required";
};

export type CodexSecurityInput = {
  agent?: Pick<AgentConfig, "name" | "capabilities" | "role" | "agentic_mode">;
  workingDirectory: string;
  baseDir?: string;
  configuredAdditionalDirectories?: string[];
  taskType?: string;
  requireExecutableAuthority?: boolean;
  requiresExternalMutation?: boolean;
};

const NON_MUTATING_TASK_TYPES = new Set(["trivial", "simple_qa", "conversation", "summarization"]);
const BROAD_ROOTS = new Set([
  "/",
  "/Users",
  homedir(),
  "/home",
  "/home/user",
  "/Volumes",
]);

function hasExecutableAuthority(agent: CodexSecurityInput["agent"]): boolean {
  if (!agent) return true;
  return agent.capabilities?.includes("tool_use") === true;
}

export function assertCodexExecutableAuthority(agent: CodexSecurityInput["agent"]): void {
  if (hasExecutableAuthority(agent)) return;
  throw new Error("Codex SDK execution requires tool_use capability");
}

function isBroadRoot(path: string): boolean {
  return BROAD_ROOTS.has(normalize(path));
}

function isDuplicateWorkspaceDirectory(path: string, workingDirectory: string): boolean {
  return normalize(path) === normalize(workingDirectory);
}

export function sanitizeCodexAdditionalDirectories(
  directories: string[] | undefined,
  workingDirectory: string,
): string[] {
  return sanitizeCodexAdditionalDirectoryDecision(directories, workingDirectory).safe;
}

function sanitizeCodexAdditionalDirectoryDecision(
  directories: string[] | undefined,
  workingDirectory: string,
): { safe: string[]; filtered: string[] } {
  if (!directories?.length) return { safe: [], filtered: [] };
  const seen = new Set<string>();
  const safe: string[] = [];
  const filtered: string[] = [];
  for (const directory of directories) {
    const resolved = resolve(directory);
    if (isBroadRoot(resolved) || isDuplicateWorkspaceDirectory(resolved, workingDirectory)) {
      filtered.push(resolved);
      continue;
    }
    if (seen.has(resolved)) {
      filtered.push(resolved);
      continue;
    }
    seen.add(resolved);
    safe.push(resolved);
  }
  return { safe, filtered };
}

export function resolveCodexSecurityDecision(input: CodexSecurityInput): CodexSecurityDecision {
  if (input.requireExecutableAuthority) {
    assertCodexExecutableAuthority(input.agent);
  }

  const taskType = input.taskType?.trim();
  const nonMutating = !taskType || NON_MUTATING_TASK_TYPES.has(taskType);
  const executableAuthority = hasExecutableAuthority(input.agent);
  const requiresExternalMutation = input.requiresExternalMutation === true;
  const sandboxMode: CodexSandboxMode = requiresExternalMutation && executableAuthority
    ? "danger-full-access"
    : nonMutating
      ? "read-only"
      : "workspace-write";
  const selectedReason: CodexAuthorityTrace["selectedReason"] = sandboxMode === "danger-full-access"
    ? "external mutation required"
    : nonMutating
      ? "non-mutating task"
      : "mutating workspace task";
  const directories = sanitizeCodexAdditionalDirectoryDecision(
    input.configuredAdditionalDirectories,
    input.workingDirectory,
  );

  return {
    sandboxMode,
    approvalPolicy: "never",
    additionalDirectories: directories.safe,
    authority: {
      ...(input.agent?.name ? { agent: input.agent.name } : {}),
      ...(input.agent?.role ? { role: input.agent.role } : {}),
      capabilities: input.agent?.capabilities ?? [],
      hasExecutableAuthority: executableAuthority,
      ...(taskType ? { taskType } : {}),
      nonMutatingTask: nonMutating,
      requiresExternalMutation,
      workingDirectory: input.workingDirectory,
      additionalDirectories: directories.safe,
      filteredAdditionalDirectories: directories.filtered,
      selectedReason,
    },
  };
}

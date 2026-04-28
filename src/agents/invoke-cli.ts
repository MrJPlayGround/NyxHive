import { writeFileSync, mkdirSync, unlinkSync, existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { logger } from "../utils/logger.js";
import { formatError } from "../utils/error.js";
import type { AgentConfig, InvocationResult, InvocationTaskType, NyxHiveConfig } from "../types.js";
import { sanitizeEnv } from "../security/vault.js";
import { ensureWorkspace } from "./workspace.js";
import { loadAndCompileSoul } from "../soul/index.js";
import type { TaskType } from "../providers/types.js";
import {
  validateAllowedDirectory,
  pendingTempDirs,
  ANTHROPIC_MODEL_PATTERN,
  formatInvocationLogLabel,
  type CLIProgress,
  type ExecutionEvent,
  type InvokeOpts,
} from "./invoke.js";
import { generatePluginJson } from "./skill-loader.js";
import { CodexNoAssistantResponseError, parseClaudeJsonOutput, parseCodexJsonOutput, type CodexExecEvent } from "./output-parsers.js";
import { getEffortForAgent, SSE_HEARTBEAT_INTERVAL_MS, SUBAGENT_WARN_THRESHOLD_MS } from "../defaults.js";
import { resolveMcpEndpointUrl } from "../server/urls.js";
import { resolveAgentRuntimePaths } from "./paths.js";
import { getInvocationStallTimeoutMs, getInvocationStartupGraceMs } from "./stall-timeout.js";
import { getServicePathEntries, resolveCliBinary } from "../utils/cli-path.js";
import { redactSecrets } from "../utils/redaction.js";
import { selectAgentHarness, shouldUseHarnessRuntime } from "../harness/selection.js";
import { buildHarnessTrajectoryEntry, recordHarnessTrajectoryIfEnabled } from "../harness/trajectory.js";
import type { HarnessRuntimeEvent } from "../harness/types.js";
import { resolveMcpToolProfile, type McpToolProfileDecision } from "./mcp-tool-profiles.js";

// Task-type-aware CLI timeouts (seconds)
// With stream-json visibility + heartbeat, we can safely allow long tasks.
// Emergency kill is always available via `nyxhive kill`.
const CLI_TIMEOUTS: Record<string, number> = {
  orchestrator: 120 * 60, // 2 hours — full app builds, multi-agent coordination, ongoing ops
  coding:        90 * 60, // 1.5 hours — large codebases, full feature implementation
  code_review:   45 * 60, // 45 min — reviewing PRs, large diffs
  expert:        45 * 60, // 45 min — deep analysis, research
  analysis:      30 * 60, // 30 min
};
const CLI_DEFAULT_TIMEOUT = 20 * 60; // 20 min for everything else
const STALL_TIMEOUT_MS = getInvocationStallTimeoutMs();
const STARTUP_GRACE_MS = getInvocationStartupGraceMs();
const CLAUDE_SESSION_BUSY_RETRY_DELAYS_MS = [500, 1_000, 2_000] as const;
const CLAUDE_SESSION_RELEASE_TIMEOUT_MS = 5_000;
const CLAUDE_SESSION_RELEASE_POLL_MS = 100;

interface ClaudeSessionOwner {
  pid: number;
  sessionId: string;
  path: string;
  cwd?: string;
}

function isUsefulSpeakerName(name: string | undefined): boolean {
  const trimmed = name?.trim();
  if (!trimmed) return false;
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) {
    return false;
  }
  const normalized = trimmed.toLowerCase();
  if (
    normalized === "unknown"
    || normalized === "api_key"
    || normalized === "nyxhive gateway"
    || normalized.includes(" device")
  ) {
    return false;
  }
  return true;
}

/**
 * NyxHive owns persistent memory. Claude/Codex subprocesses should not create
 * their own cwd-scoped memory islands when running under the harness.
 */
export function applyNyxHiveCliEnvironment(
  baseEnv: Record<string, string>,
  cli: string,
  config?: Pick<NyxHiveConfig, "daemon">,
): Record<string, string> {
  const env = { ...baseEnv };
  const pathEntries = [
    ...(env.PATH?.split(delimiter).filter(Boolean) ?? []),
    ...getServicePathEntries(),
  ];
  env.PATH = [...new Set(pathEntries)].join(delimiter);

  if (cli === "claude") {
    if (config?.daemon.claude_config_dir) {
      env.CLAUDE_CONFIG_DIR = config.daemon.claude_config_dir;
    }
    // Claude auto-memory shards state by cwd/project root. NyxHive already
    // provides centralized memory + knowledge context, so disable the native
    // layer entirely for managed subprocesses.
    delete env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE;
    delete env.CLAUDE_CODE_REMOTE_MEMORY_DIR;
    env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = "1";
  }

  if (cli === "codex" && config?.daemon.codex_home) {
    env.CODEX_HOME = config.daemon.codex_home;
  }

  return env;
}

export function shouldUseCodexAppServerRuntime(
  agent: AgentConfig,
  _config: NyxHiveConfig | undefined,
  env: Record<string, string | undefined> = process.env,
  override?: InvokeOpts["codexRuntime"],
): boolean {
  return shouldUseHarnessRuntime({ agent, config: _config, env, override });
}

export function appendCurrentSpeakerPrompt(prompt: string, senderName?: string): string {
  if (!isUsefulSpeakerName(senderName)) {
    return prompt;
  }
  return `${prompt}\n\n[Current speaker]\nYou are currently speaking to ${senderName}. Address them as ${senderName}. Do not confuse them with anyone else mentioned in your instructions or conversation history.`;
}

function summarizeCommandName(command: string | undefined): string | undefined {
  const trimmed = command?.trim();
  if (!trimmed) return undefined;
  const firstExecutableLine = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("#"));
  if (!firstExecutableLine) return undefined;
  const shellWrapperMatch = firstExecutableLine.match(
    /^(?:\/\S+\/)?(?:zsh|bash|sh)\s+-[A-Za-z]*c\s+([\s\S]+)$/i,
  );
  if (shellWrapperMatch?.[1]) {
    const nested = shellWrapperMatch[1].trim().replace(/^['"]|['"]$/g, "");
    const nestedExecutable = summarizeCommandName(nested);
    if (nestedExecutable) return nestedExecutable;
  }
  const match = firstExecutableLine.match(/^([^\s"'`|;&<>()]+)/);
  const executable = match?.[1]?.split("/").pop()?.trim();
  if (!executable || executable === "#") return undefined;
  return executable;
}

function formatMcpToolActivity(tool: string): string {
  const [, server, name] = tool.split("__");
  if (!server || !name) return "Calling MCP tool";
  const humanizedName = name
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
  return `Calling ${server}/${humanizedName}`;
}

/** Format tool name + detail into a short human-readable activity string. */
export function formatToolActivity(tool: string, detail?: string): string {
  const basename = (p: string) => p.split("/").pop() ?? p;
  switch (tool) {
    case "Read":    return detail ? `Reading ${basename(detail)}` : "Reading file";
    case "Write":   return detail ? `Writing ${basename(detail)}` : "Writing file";
    case "Edit":    return detail ? `Editing ${basename(detail)}` : "Editing file";
    case "Bash": {
      const commandName = summarizeCommandName(detail);
      return commandName ? `Running ${commandName}` : "Running command";
    }
    case "Glob":    return "Searching files";
    case "Grep":    return "Searching code";
    case "WebFetch": return "Fetching web page";
    case "WebSearch": return "Web search";
    case "Task":    return detail ? `Subagent: ${detail}` : "Spawning subagent";
    case "TodoWrite": return "Updating tasks";
    default:
      if (tool.startsWith("mcp__")) return formatMcpToolActivity(tool);
      return detail ? `${tool}: ${basename(detail).slice(0, 40)}` : tool;
  }
}

function createExecutionEvent(
  event: Omit<ExecutionEvent, "timestamp"> & { timestamp?: number },
): ExecutionEvent {
  return {
    timestamp: event.timestamp ?? Date.now(),
    ...event,
  };
}

function truncateExecutionText(text: string | undefined, max = 120): string | undefined {
  const compact = redactSecrets(text ?? "").replace(/\s+/g, " ").trim();
  if (!compact) return undefined;
  return compact.length > max ? `${compact.slice(0, max - 3)}...` : compact;
}

export function isClaudeSessionBusyError(text: string | undefined): boolean {
  if (!text) return false;
  return /Session ID [\w-]+ is already in use\./i.test(text);
}

export function getClaudeSessionBusyRetryDelayMs(attempt: number): number | undefined {
  return CLAUDE_SESSION_BUSY_RETRY_DELAYS_MS[attempt];
}

function getClaudeSessionsDir(): string {
  const override = process.env.NYXHIVE_CLAUDE_SESSIONS_DIR?.trim();
  if (override) return override;
  return join(homedir(), ".claude", "sessions");
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function findClaudeSessionOwners(sessionId: string): ClaudeSessionOwner[] {
  const sessionsDir = getClaudeSessionsDir();
  if (!sessionId || !existsSync(sessionsDir)) return [];

  const owners: ClaudeSessionOwner[] = [];
  for (const entry of readdirSync(sessionsDir)) {
    if (!entry.endsWith(".json")) continue;
    const path = join(sessionsDir, entry);
    try {
      const raw = JSON.parse(readFileSync(path, "utf-8")) as {
        pid?: unknown;
        sessionId?: unknown;
        cwd?: unknown;
      };
      if (raw.sessionId !== sessionId) continue;
      const pid = typeof raw.pid === "number" ? raw.pid : Number(raw.pid);
      if (!isProcessAlive(pid)) {
        try { unlinkSync(path); } catch { /* ignore stale session cleanup failure */ }
        continue;
      }
      owners.push({
        pid,
        sessionId,
        path,
        cwd: typeof raw.cwd === "string" ? raw.cwd : undefined,
      });
    } catch {
      // Ignore malformed or concurrently removed session files.
    }
  }
  return owners;
}

export async function waitForClaudeSessionRelease(
  sessionId: string,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<{ released: boolean; waitedMs: number; owners: ClaudeSessionOwner[] }> {
  const timeoutMs = opts.timeoutMs ?? CLAUDE_SESSION_RELEASE_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? CLAUDE_SESSION_RELEASE_POLL_MS;
  const startedAt = Date.now();

  let owners = findClaudeSessionOwners(sessionId);
  if (owners.length === 0) {
    return { released: true, waitedMs: 0, owners: [] };
  }

  while (Date.now() - startedAt < timeoutMs) {
    await Bun.sleep(pollMs);
    owners = findClaudeSessionOwners(sessionId);
    if (owners.length === 0) {
      return { released: true, waitedMs: Date.now() - startedAt, owners: [] };
    }
  }

  return {
    released: false,
    waitedMs: Date.now() - startedAt,
    owners,
  };
}

type InvokeOptsWithResumeRetry = InvokeOpts & { _resumeBusyRetryAttempt?: number; _codexActionRetried?: boolean };

const CODEX_PLAN_ONLY_RE = /\b(?:i(?:['’]ll| will)|let me|first[, ]+i(?:['’]ll| will)|i(?:['’]m| am) going (?:straight )?to|i(?:['’]m| am) (?:starting|heading|moving) (?:straight )?(?:to|into|with)|here(?:['’]s| is) what i(?:['’]ll| will)|my plan is to|next,? i(?:['’]ll| will)|before i (?:judge|answer|review|call|decide))\b/i;
const CODEX_ACTION_COMPLETION_RE = /\b(?:i ran|i updated|i changed|i fixed|i checked|i verified|i found|done|completed|implemented|resolved|working now|here'?s what changed|i used|i inspected)\b/i;
const CODEX_TOOL_ACTION_REQUEST_RE =
  /(?:\b(?:go\s+)?(?:read|inspect|check|review|look\s+(?:at|into|through)|pull|show|run|test|verify|search|find|open)\b[\s\S]{0,180}\b(?:git|commits?|diffs?|logs?|history|repo|repository|code|files?|workspace|harness|tests?|typecheck|build|changes?)\b|\b(?:git\s+(?:log|show|diff|status)|bun\s+(?:test|run\s+typecheck)|npm\s+(?:test|run\s+build)|pnpm\s+(?:test|build))\b)/i;
const CODEX_NATIVE_EVIDENCE_REVIEW_RE =
  /\b(?:check|review|read|inspect|look\s+(?:at|into|through))\b[\s\S]{0,220}\b(?:commits?|diffs?|git|repo|repository|history|harness|workspace|system|changes?)\b/i;
const CODEX_MUTATION_REQUEST_RE =
  /\b(?:fix|implement|change|edit|write|create|delete|remove|refactor|build|run\s+(?:tests?|typecheck|lint)|test\s+(?:this|it|the)|commit|push|merge)\b/i;
const CODEX_EVIDENCE_PREFLIGHT_COMMANDS: Array<{ label: string; args: string[] }> = [
  { label: "git status --short --branch", args: ["status", "--short", "--branch"] },
  { label: "git log --oneline --decorate -8", args: ["log", "--oneline", "--decorate", "-8"] },
  { label: "git show --stat --oneline --summary -4", args: ["show", "--stat", "--oneline", "--summary", "-4"] },
];

function getClaudeToolKind(toolName: string): ExecutionEvent["kind"] {
  if (toolName.startsWith("mcp__")) return "mcp_tool";
  if (toolName === "WebSearch" || toolName === "WebFetch") return "web_search";
  if (toolName === "Write" || toolName === "Edit" || toolName === "MultiEdit") return "file_change";
  if (toolName === "Bash" || toolName === "Read" || toolName === "Glob" || toolName === "Grep") return "command";
  return "status";
}

function getClaudeToolTitle(toolName: string, phase: ExecutionEvent["phase"]): string {
  const started = phase === "started" || phase === "updated";
  switch (toolName) {
    case "Read":
      return started ? "Reading file" : "File read complete";
    case "Write":
    case "Edit":
    case "MultiEdit":
      return started ? "Applying file change" : "File change complete";
    case "Bash":
      return started ? "Running command" : "Command run complete";
    case "Glob":
    case "Grep":
      return started ? "Searching code" : "Code search complete";
    case "WebFetch":
      return started ? "Fetching web page" : "Web fetch complete";
    case "WebSearch":
      return started ? "Running web search" : "Web search complete";
    case "Task":
    case "Agent":
      return started ? "Handing off to subagent" : "Subagent complete";
    case "TodoWrite":
      return started ? "Updating task list" : "Task list updated";
    default:
      return started ? `${toolName} started` : `${toolName} complete`;
  }
}

export function buildClaudeToolExecutionEvent(
  id: string,
  toolName: string,
  phase: ExecutionEvent["phase"],
  input?: Record<string, unknown>,
  turn?: number,
): ExecutionEvent {
  const kind = getClaudeToolKind(toolName);
  const pathValue = typeof input?.file_path === "string" ? input.file_path : undefined;
  const commandValue = typeof input?.command === "string" ? input.command : undefined;
  const patternValue = typeof input?.pattern === "string" ? input.pattern : undefined;
  const queryValue = typeof input?.query === "string" ? input.query : undefined;
  const urlValue = typeof input?.url === "string" ? input.url : undefined;
  const descValue = typeof input?.description === "string" ? input.description : undefined;
  const subtitle =
    truncateExecutionText(commandValue)
    ?? truncateExecutionText(pathValue)
    ?? truncateExecutionText(patternValue)
    ?? truncateExecutionText(queryValue)
    ?? truncateExecutionText(urlValue)
    ?? truncateExecutionText(descValue);

  if (toolName.startsWith("mcp__")) {
    const [, server, tool] = toolName.split("__");
    return createExecutionEvent({
      id,
      kind: "mcp_tool",
      phase,
      turn,
      title: phase === "started" ? "Calling MCP tool" : "MCP tool complete",
      subtitle: [server, tool].filter(Boolean).join("/") || toolName,
      details: subtitle,
    });
  }

  if (toolName === "WebSearch" || toolName === "WebFetch") {
    return createExecutionEvent({
      id,
      kind: "web_search",
      phase,
      turn,
      title: getClaudeToolTitle(toolName, phase),
      subtitle,
      details: toolName === "WebFetch" ? truncateExecutionText(urlValue, 180) : subtitle,
    });
  }

  if (toolName === "Write" || toolName === "Edit" || toolName === "MultiEdit") {
    return createExecutionEvent({
      id,
      kind: "file_change",
      phase,
      turn,
      title: getClaudeToolTitle(toolName, phase),
      subtitle,
      changes: pathValue ? [{ path: pathValue, kind: "update" }] : undefined,
    });
  }

  if (toolName === "Bash") {
    const redactedCommand = commandValue ? redactSecrets(commandValue) : undefined;
    return createExecutionEvent({
      id,
      kind: "command",
      phase,
      turn,
      title: getClaudeToolTitle(toolName, phase),
      subtitle,
      command: redactedCommand,
    });
  }

  if (toolName === "Read") {
    return createExecutionEvent({
      id,
      kind: "command",
      phase,
      turn,
      title: getClaudeToolTitle(toolName, phase),
      subtitle,
    });
  }

  if (toolName === "Glob" || toolName === "Grep") {
    return createExecutionEvent({
      id,
      kind: "command",
      phase,
      turn,
      title: getClaudeToolTitle(toolName, phase),
      subtitle,
      details: subtitle,
    });
  }

  if (toolName === "Task" || toolName === "Agent") {
    return createExecutionEvent({
      id,
      kind: "status",
      phase,
      turn,
      title: getClaudeToolTitle(toolName, phase),
      subtitle,
      details: subtitle,
    });
  }

  if (toolName === "TodoWrite") {
    return createExecutionEvent({
      id,
      kind: "status",
      phase,
      turn,
      title: getClaudeToolTitle(toolName, phase),
      subtitle,
    });
  }

  return createExecutionEvent({
    id,
    kind,
    phase,
    turn,
    title: getClaudeToolTitle(toolName, phase),
    subtitle,
    details: subtitle,
  });
}

export function buildCodexCommandExecutionEvent(
  id: string,
  phase: ExecutionEvent["phase"],
  command: string | undefined,
  turn?: number,
  opts?: { outputPreview?: string; exitCode?: number | null },
): ExecutionEvent {
  const redactedCommand = command ? redactSecrets(command) : undefined;
  const subtitle = truncateExecutionText(command);
  return createExecutionEvent({
    id,
    kind: "command",
    phase,
    turn,
    title: phase === "started" ? "Running command" : phase === "failed" ? "Command failed" : "Command run complete",
    subtitle,
    details: subtitle,
    command: redactedCommand,
    outputPreview: opts?.outputPreview ? redactSecrets(opts.outputPreview) : undefined,
    exitCode: opts?.exitCode,
  });
}

export function shouldReadCodexPromptFromStdin(cli: string): boolean {
  return cli === "codex";
}

export function isLikelyCodexPlanOnlyResponse(response: string): boolean {
  const text = response.trim();
  if (!text) return false;
  if (!CODEX_PLAN_ONLY_RE.test(text)) return false;
  if (CODEX_ACTION_COMPLETION_RE.test(text)) return false;
  if (/\b(?:running|executed|output|result):\b/i.test(text)) return false;
  return true;
}

export function shouldRetryCodexPlanOnlyTurn(
  taskType: string | undefined,
  response: string,
  toolsUsed: string[] | undefined,
  alreadyRetried: boolean,
  message?: string,
): boolean {
  if (alreadyRetried) return false;
  const lowActionTask = !taskType || taskType === "conversation" || taskType === "simple_qa" || taskType === "trivial" || taskType === "summarization";
  if (lowActionTask && !CODEX_TOOL_ACTION_REQUEST_RE.test(message ?? "")) return false;
  if ((toolsUsed?.length ?? 0) > 0) return false;
  return isLikelyCodexPlanOnlyResponse(response);
}

function currentMessageForActionDetection(message: string | undefined): string {
  const text = message ?? "";
  const bracketMarker = "[Current Message]";
  const bracketIdx = text.lastIndexOf(bracketMarker);
  if (bracketIdx >= 0) {
    return text.slice(bracketIdx + bracketMarker.length).trim();
  }

  const lower = text.toLowerCase();
  const plainMarker = "current message:";
  const plainIdx = lower.lastIndexOf(plainMarker);
  if (plainIdx >= 0) {
    return text.slice(plainIdx + plainMarker.length).trim();
  }

  return text;
}

export function requiresCodexToolEvidence(message: string | undefined): boolean {
  return CODEX_TOOL_ACTION_REQUEST_RE.test(currentMessageForActionDetection(message));
}

export function shouldUseNativeEvidenceReview(message: string | undefined): boolean {
  const text = currentMessageForActionDetection(message);
  return CODEX_NATIVE_EVIDENCE_REVIEW_RE.test(text) && !CODEX_MUTATION_REQUEST_RE.test(text);
}

function findGitRoot(candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    if (!candidate || !existsSync(candidate)) continue;
    const proc = Bun.spawnSync(["git", "-C", candidate, "rev-parse", "--show-toplevel"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    if (proc.exitCode !== 0) continue;
    const root = new TextDecoder().decode(proc.stdout).trim();
    if (root) return root;
  }
  return undefined;
}

function runPreflightGitCommand(root: string, command: { label: string; args: string[] }): { output: string; exitCode: number } {
  const proc = Bun.spawnSync(["git", "-C", root, ...command.args], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = new TextDecoder().decode(proc.stdout).trim();
  const stderr = new TextDecoder().decode(proc.stderr).trim();
  const output = [stdout, stderr ? `[stderr]\n${stderr}` : ""].filter(Boolean).join("\n").trim();
  return { output, exitCode: proc.exitCode };
}

function buildEvidencePreflightPrompt(root: string, results: Array<{ label: string; output: string; exitCode: number }>): string {
  const sections = results.map((result) => {
    const output = result.output || "(no output)";
    return [
      `$ ${result.label}`,
      `exit=${result.exitCode}`,
      output,
    ].join("\n");
  });
  return [
    "[Harness evidence preflight]",
    `Repository root: ${root}`,
    "NyxHive already collected this read-only evidence before model execution. Use it directly. Do not say you need to inspect commits/files unless you need additional evidence beyond this bundle.",
    "",
    ...sections,
  ].join("\n\n");
}

export function buildEvidenceReview(
  results: Array<{ label: string; output: string; exitCode: number }>,
  intro = "I checked the live repo evidence before answering.",
): string {
  const evidenceLines = results.flatMap((result) => {
    const outputLines = (result.output || "(no output)")
      .split("\n")
      .map((line) => line.trimEnd())
      .filter(Boolean)
      .slice(0, 18);
    return [
      `- \`${result.label}\` exit=${result.exitCode}`,
      ...outputLines.map((line) => `  ${line}`),
    ];
  });

  return [
    intro,
    "",
    "**Evidence**",
    ...(evidenceLines.length ? evidenceLines : ["- No evidence commands ran."]),
  ].join("\n");
}

/** Find and read the most recently modified plan file in the workspace. */
function readLatestPlanFile(workDir: string): string | null {
  const plansDir = join(workDir, ".claude", "plans");
  if (!existsSync(plansDir)) return null;
  try {
    const files = readdirSync(plansDir)
      .filter(f => f.endsWith(".md"))
      .map(f => ({ path: join(plansDir, f), mtime: statSync(join(plansDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    if (files.length === 0) return null;
    // Only use plans modified in the last 5 minutes (current session)
    if (Date.now() - files[0].mtime > 5 * 60 * 1000) return null;
    return readFileSync(files[0].path, "utf-8");
  } catch {
    return null;
  }
}

function shouldRequirePlanning(taskType?: string): boolean {
  if (!taskType) return false;
  return taskType !== "simple_qa" && taskType !== "conversation";
}

function shouldDisableThinking(taskType?: string): boolean {
  return taskType === "trivial"
    || taskType === "classification"
    || taskType === "simple_qa"
    || taskType === "conversation"
    || taskType === "summarization";
}

function cleanupInvocationTempFiles(tempFiles: string[], tempDir: string | undefined, mcpConfigPath: string | undefined): void {
  for (const f of tempFiles) {
    try { if (existsSync(f)) unlinkSync(f); } catch { /* ignore */ }
  }
  if (tempDir) pendingTempDirs.delete(tempDir);
  if (mcpConfigPath) {
    try { if (existsSync(mcpConfigPath)) unlinkSync(mcpConfigPath); } catch { /* ignore */ }
    pendingTempDirs.delete(mcpConfigPath);
  }
}

export function resolveClaudeReasoningSettings(taskType?: string): {
  thinking: "adaptive" | "disabled";
  effort?: "low" | "medium" | "high";
} {
  if (shouldDisableThinking(taskType)) {
    return { thinking: "disabled", effort: "low" };
  }

  if (taskType === "analysis" || taskType === "research" || taskType === "expert" || taskType === "code_review") {
    return { thinking: "adaptive", effort: "high" };
  }

  if (taskType === "coding" || taskType === "worker_subtask" || taskType === "orchestrator" || taskType === "long_context") {
    return { thinking: "adaptive", effort: "high" };
  }

  return { thinking: "adaptive", effort: "medium" };
}

export function appendClaudeResumeArgs(args: string[], resumeSessionId?: string): void {
  if (!resumeSessionId) return;
  // Claude uses --resume to continue an existing conversation. Reusing
  // --session-id tries to claim the ID again and fails with "already in use".
  args.push("--resume", resumeSessionId);
}

function buildClaudeHarnessAppendPrompt(taskType: string | undefined, senderName?: string): string {
  const lines = [
    "IMPORTANT: The AskUserQuestion tool is NOT available in this environment. Do not attempt to use it.",
    "If requirements are unclear, make a reasonable assumption and proceed unless the answer materially changes the plan or implementation.",
    "If you need user input to continue, output a JSON block at the END of your response:",
    "```json",
    '{"input_request":{"question":"your question here","options":[{"key":"option1","description":"desc"}]}}',
    "```",
    "Do not attempt to use AskUserQuestion. Use the JSON format above instead.",
    "If you output an input_request, stop immediately after the JSON block and do not continue working.",
    "Spend more reasoning on initial planning and final verification. Once the plan is clear, keep routine execution steps concise.",
  ];

  if (shouldRequirePlanning(taskType)) {
    lines.push("For multi-step tasks: you MUST use TodoWrite before making code changes. Break the work into steps and keep the task list updated.");
  }

  lines.push("Before declaring implementation complete, you MUST run verification and include the output in your response.");

  return appendCurrentSpeakerPrompt(lines.join("\n\n"), senderName);
}

function isVerificationCommand(command: string | undefined): boolean {
  const normalized = command?.trim().toLowerCase();
  if (!normalized) return false;
  return /\b(bun test|bun run test|bun run lint|bun run build|bun run typecheck|npm test|npm run test|npm run lint|npm run build|pnpm test|pnpm lint|pnpm build|yarn test|yarn lint|yarn build|vitest|jest|pytest|ruff check|eslint|biome check|tsc(?:\s|$)|go test|cargo test|cargo check|deno test|swift test|xcodebuild|gradle(?:w)? test|mvn test|phpunit|composer test)\b/.test(normalized);
}

function isCompletionClaim(text: string): boolean {
  return /\b(done|complete(?:d)?|implemented|fixed|resolved|verified|working now|ready)\b/i.test(text);
}

function hasRecentVerification(currentTurn: number, verificationTurns: number[]): boolean {
  return verificationTurns.some((turn) => currentTurn - turn <= 3);
}

export function formatToolResultPreview(text: string, maxLines = 12, maxChars = 700): string {
  const normalized = redactSecrets(text).replace(/\r\n/g, "\n").trim();
  if (!normalized) return "";

  const lines = normalized.split("\n");
  if (lines.length > maxLines) {
    return `${lines.slice(0, maxLines).join("\n")}\n... (truncated, ${lines.length - maxLines} more lines not shown. Use offset/limit to read specific sections.)`;
  }

  if (normalized.length > maxChars) {
    return `${normalized.slice(0, maxChars)}\n... (truncated, more output not shown. Use offset/limit to read specific sections.)`;
  }

  return normalized;
}

function extractTextFromToolResultContent(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((entry) => {
      if (typeof entry === "string") return entry;
      if (!entry || typeof entry !== "object") return "";
      if ("text" in entry && typeof entry.text === "string") return entry.text;
      if ("content" in entry && typeof entry.content === "string") return entry.content;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

export async function invokeCLI(
  agent: AgentConfig,
  message: string,
  opts: InvokeOpts,
  startTime: number,
  taskType?: string,
): Promise<InvocationResult> {
  const cli = agent.cli_fallback ?? "claude";
  const resolvedCli = resolveCliBinary(cli);
  if (!resolvedCli) {
    throw new Error(`Executable not found in $PATH: "${cli}"`);
  }
  // Always ensure workspace (generates PLATFORM.md, CLAUDE.md, etc.)
  const workspace = ensureWorkspace(agent, opts.baseDir, opts.config, opts.agentKey, opts.registry, opts.scheduler, opts.memory, opts.instanceSoulsDir);
  // Use CWD override if provided and valid (e.g., target repo for proposal execution)
  const workDir = opts.cwdOverride && existsSync(opts.cwdOverride) ? opts.cwdOverride : workspace;
  const resolvedAllowedDirectories = resolveAgentRuntimePaths(opts.baseDir, agent.allowed_directories) ?? [];

  // Ensure skills plugin exists when using cwdOverride (e.g., worktrees)
  if (workDir !== workspace && cli === "claude") {
    generatePluginJson(workDir);
  }

  // Build prompt — when resuming a session, the CLI already has conversation history,
  // so we only inject the new message (plus any per-message context like knowledge/files).
  // Fresh sessions get conversation history injected as text.
  const resumeSessionId = opts.sessionId;
  let prompt = message;
  if (!resumeSessionId) {
    if (opts.conversationHistory && opts.conversationHistory.length > 0) {
      const historyLines = opts.conversationHistory.map(
        (msg) => `${msg.role === "user" ? "User" : "Assistant"}: ${msg.content}`,
      );
      prompt = `[Conversation History]\n${historyLines.join("\n")}\n\n[Current Message]\n${message}`;
    } else if (opts.conversationContext) {
      prompt = `Previous conversation context:\n${opts.conversationContext}\n\n---\n\nCurrent message:\n${message}`;
    }
  }

  // Write file attachments to temp directory for CLI access
  const tempFiles: string[] = [];
  let tempDir: string | undefined;
  let mcpConfigPath: string | undefined;
  if (opts.files && opts.files.length > 0) {
    tempDir = join(tmpdir(), `nyxhive-files-${randomUUID()}`);
    mkdirSync(tempDir, { recursive: true });
    pendingTempDirs.add(tempDir);
    const fileDescriptions: string[] = [];
    for (const file of opts.files) {
      const tempPath = join(tempDir, `${file.name.replace(/[^a-zA-Z0-9._-]/g, "_")}`);
      writeFileSync(tempPath, Buffer.from(file.base64, "base64"));
      tempFiles.push(tempPath);
      fileDescriptions.push(`- ${file.name} (${file.mimeType}): ${tempPath}`);
    }
    prompt = `[Attached Files]\nThe user sent ${tempFiles.length} file(s). Read them at:\n${fileDescriptions.join("\n")}\n\n${prompt}`;
  }

  const evidencePreflightRequired = cli === "codex" && requiresCodexToolEvidence(message);
  let evidencePreflightRan = false;
  let evidencePreflightResults: Array<{ label: string; output: string; exitCode: number }> = [];
  if (evidencePreflightRequired) {
    const gitRoot = findGitRoot([
      opts.cwdOverride ?? "",
      opts.baseDir,
      workDir,
      ...resolvedAllowedDirectories,
    ]);
    if (gitRoot) {
      const preflightResults: Array<{ label: string; output: string; exitCode: number }> = [];
      for (const command of CODEX_EVIDENCE_PREFLIGHT_COMMANDS) {
        const startedAt = Date.now();
        opts.onProgress?.({
          turns: 0,
          tokensIn: 0,
          tokensOut: 0,
          elapsed: Math.round((startedAt - startTime) / 1000),
          activity: formatToolActivity("Bash", `git -C ${gitRoot} ${command.args.join(" ")}`),
          phase: "working",
          agent: agent.name,
          executionEvent: buildCodexCommandExecutionEvent(`preflight:${command.label}:started`, "started", command.label, 0),
        });
        const result = runPreflightGitCommand(gitRoot, command);
        preflightResults.push({ label: command.label, ...result });
        opts.onProgress?.({
          turns: 0,
          tokensIn: 0,
          tokensOut: 0,
          elapsed: Math.round((Date.now() - startTime) / 1000),
          activity: formatToolActivity("Bash", command.label),
          phase: "working",
          agent: agent.name,
          executionEvent: buildCodexCommandExecutionEvent(`preflight:${command.label}:completed`, result.exitCode === 0 ? "completed" : "failed", command.label, 0, {
            outputPreview: formatToolResultPreview(result.output),
            exitCode: result.exitCode,
          }),
        });
      }
      prompt = `${buildEvidencePreflightPrompt(gitRoot, preflightResults)}\n\n${prompt}`;
      evidencePreflightRan = true;
      evidencePreflightResults = preflightResults;
      logger.info(`[invoke] ${formatInvocationLogLabel(agent.name, opts)} evidence_preflight=root:${gitRoot} commands=${preflightResults.length}`);
      if (shouldUseNativeEvidenceReview(message)) {
        cleanupInvocationTempFiles(tempFiles, tempDir, mcpConfigPath);
        return {
          response: buildEvidenceReview(preflightResults),
          agent: agent.name,
          method: "api",
          task_type: taskType as InvocationTaskType,
          model: "harness-evidence-review",
          tokens_in: 0,
          tokens_out: 0,
          cost: 0,
          duration_ms: Date.now() - startTime,
          toolsUsed: ["harness_evidence_preflight"],
        };
      }
    } else {
      logger.warn(`[invoke] ${formatInvocationLogLabel(agent.name, opts)} evidence_preflight=skipped reason=no_git_root`);
    }
  }

  // Security: sanitize environment — strip sensitive vars, inject only declared credentials
  let env = sanitizeEnv(process.env);
  // Strip CLAUDECODE so agents can spawn even when NyxHive is started from within a Claude Code session
  delete env.CLAUDECODE;
  // Inject NyxHive API key so .mcp.json ${NYXHIVE_API_KEY} expansion works in spawned Claude sessions
  if (opts.config?.server?.api_key) {
    env.NYXHIVE_API_KEY = opts.config.server.api_key;
  }
  // Inject agent-declared credentials from vault
  if (opts.vault && agent.credentials?.length) {
    Object.assign(env, opts.vault.getForAgent(agent.credentials, agent.name));
  }
  env = applyNyxHiveCliEnvironment(env, cli, opts.config);

  const timeoutSec = CLI_TIMEOUTS[taskType ?? ""] ?? CLI_DEFAULT_TIMEOUT;
  const timeoutMs = timeoutSec * 1000;
  const logLabel = formatInvocationLogLabel(agent.name, opts);

  const selectedHarness = cli === "codex"
    ? selectAgentHarness({ agent, config: opts.config, env: process.env, override: opts.codexRuntime })
    : null;
  if (selectedHarness?.runtime === "codex_app_server") {
    try {
      logger.info(`[invoke] ${logLabel} spawn backend=codex_app_server cwd=${workDir} timeout=${timeoutSec}s task=${taskType ?? "unknown"} memory=${opts.config?.daemon.codex_home ? "codex_home" : "default"}${resumeSessionId ? ` resume=${resumeSessionId.slice(0, 8)}…` : ""}`);
      const harness = selectedHarness;
      const harnessTrajectoryId = randomUUID();
      const harnessEvents: HarnessRuntimeEvent[] = [];
      let appServerTextSoFar = "";
      let appServerTurnCount = 0;
      let appServerTokensIn = 0;
      let appServerTokensOut = 0;
      const onAppServerEvent = (event: HarnessRuntimeEvent) => {
        harnessEvents.push(event);
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        if (event.kind === "turn.started") {
          appServerTurnCount += 1;
          opts.onProgress?.({
            turns: appServerTurnCount,
            tokensIn: appServerTokensIn,
            tokensOut: appServerTokensOut,
            elapsed,
            activity: "Codex turn started",
            phase: "working",
            agent: agent.name,
          });
          return;
        }
        if (event.kind === "content.delta" && event.message) {
          appServerTextSoFar += event.message;
          opts.onProgress?.({
            turns: appServerTurnCount,
            tokensIn: appServerTokensIn,
            tokensOut: appServerTokensOut,
            elapsed,
            textDelta: event.message,
            textSoFar: appServerTextSoFar,
            phase: "responding",
            streamingSafe: true,
            agent: agent.name,
          });
          return;
        }
        if (event.kind === "tool.started" || event.kind === "tool.completed") {
          const tool = event.message ?? "tool";
          const phase: ExecutionEvent["phase"] = event.kind === "tool.started" ? "started" : "completed";
          opts.onProgress?.({
            turns: appServerTurnCount,
            tokensIn: appServerTokensIn,
            tokensOut: appServerTokensOut,
            elapsed,
            activity: formatToolActivity(tool),
            phase: "working",
            agent: agent.name,
            executionEvent: createExecutionEvent({
              id: `${event.turnId ?? appServerTurnCount}:${event.itemId ?? tool}`,
              kind: "status",
              phase,
              turn: appServerTurnCount,
              title: tool,
            }),
          });
          return;
        }
        if (event.kind === "usage.updated") {
          appServerTokensIn += event.tokensIn ?? 0;
          appServerTokensOut += event.tokensOut ?? 0;
          opts.onProgress?.({
            turns: appServerTurnCount,
            tokensIn: appServerTokensIn,
            tokensOut: appServerTokensOut,
            elapsed,
            activity: "Usage updated",
            phase: "working",
            agent: agent.name,
          });
        }
      };
      let result: Awaited<ReturnType<typeof harness.runTurn>>;
      try {
        const codexEffort = getEffortForAgent(agent.effort, agent.role);
        result = await harness.runTurn({
          binaryPath: resolvedCli,
          cwd: workDir,
          env,
          prompt,
          model: agent.model,
          effort: codexEffort,
          agent,
          baseDir: opts.baseDir,
          configuredAdditionalDirectories: resolvedAllowedDirectories,
          taskType,
          resumeThreadId: resumeSessionId,
          codexHome: opts.config?.daemon.codex_home,
          attachments: opts.files,
          timeoutMs,
          signal: opts.signal,
          onEvent: onAppServerEvent,
          freshConnection: opts.freshRuntimeConnection,
        });
      } catch (error) {
        recordHarnessTrajectoryIfEnabled(buildHarnessTrajectoryEntry({
          id: harnessTrajectoryId,
          runtime: harness.runtime,
          provider: harness.provider,
          model: agent.model,
          taskType,
          prompt,
          events: harnessEvents,
          error,
        }));
        throw error;
      }
      recordHarnessTrajectoryIfEnabled(buildHarnessTrajectoryEntry({
        id: harnessTrajectoryId,
        runtime: harness.runtime,
        provider: harness.provider,
        model: agent.model,
        taskType,
        prompt,
        result,
      }));
      const duration = Date.now() - startTime;
      logger.info(
        `[invoke] ${logLabel} backend=codex_app_server completed duration=${duration}ms tokens=${result.tokensIn ?? 0}+${result.tokensOut ?? 0} thread=${result.providerThreadId.slice(0, 12)}`,
      );
      return {
        response: result.response,
        agent: agent.name,
        method: "cli",
        task_type: taskType as InvocationTaskType,
        model: agent.model,
        tokens_in: result.tokensIn,
        tokens_out: result.tokensOut,
        duration_ms: duration,
        toolsUsed: result.toolsUsed,
        runtime_events: result.events,
        input_request: result.inputRequest,
        session_id: result.providerThreadId,
        session_runtime: "codex_app_server",
      };
    } finally {
      cleanupInvocationTempFiles(tempFiles, tempDir, mcpConfigPath);
    }
  }

  const args: string[] = [];
  let mcpProfile: McpToolProfileDecision | undefined;

  if (cli === "claude") {
    // For claude CLI: workspace files (AGENTS.md, NYXHIVE.md) provide static context.
    // Include knowledge context in the prompt for dynamic RAG results.
    if (opts.knowledgeContext) {
      prompt = `[Relevant Knowledge]\n${opts.knowledgeContext}\n\n${prompt}`;
    }

    // Tool restriction strategy:
    // - Agents with allowed_tools: use --tools to restrict available tools, keep
    //   --dangerously-skip-permissions so the restricted set auto-executes.
    //   --allowed-tools only controls permission pre-approval, not availability.
    // - Agents without allowed_tools: --dangerously-skip-permissions gives full access.
    const isSandboxed = opts.sandbox && opts.sandbox.name !== "none";
    const _hasToolAllowlist = agent.allowed_tools && agent.allowed_tools.length > 0;
    args.push(
      "-p", prompt,
      "--output-format", "stream-json", "--verbose", "--include-partial-messages",
    );
    const reasoning = resolveClaudeReasoningSettings(taskType);
    args.push("--thinking", reasoning.thinking);
    if (reasoning.effort) {
      args.push("--effort", reasoning.effort);
    }
    // Resume existing session for conversation continuity.
    appendClaudeResumeArgs(args, resumeSessionId);
    if (!isSandboxed) {
      args.push("--dangerously-skip-permissions");
    }
    if (agent.model) args.push("--model", agent.model);

    // Cap CLI turns — only if explicitly configured per-agent
    if (agent.max_tool_turns) {
      args.push("--max-turns", String(agent.max_tool_turns));
    }

    // Give claude access to the vault directory
    if (opts.config?.vault?.path) {
      args.push("--add-dir", opts.config.vault.path);
    }

    // Give claude access to additional directories configured per-agent
    if (resolvedAllowedDirectories.length > 0) {
      for (const dir of resolvedAllowedDirectories) {
        try {
          const safeDir = validateAllowedDirectory(dir);
          args.push("--add-dir", safeDir);
        } catch (err) {
          logger.warn(`[invoke] Skipping blocked allowed_directory "${dir}": ${formatError(err)}`);
        }
      }
    }

    // Restrict available tools for this agent (e.g., pure orchestrators: read-only)
    // --tools controls which tools the model can see and use (hard restriction).
    // --disallowed-tools is a permission-level block (soft, can be bypassed).
    // Pure orchestrators MUST be read-only. Lead agents get full tool access.
    const isReadOnlyAgent = agent.role === "orchestrator";
    const effectiveAllowedTools = isReadOnlyAgent
      ? (agent.allowed_tools?.length ? agent.allowed_tools : ["Read", "Glob", "Grep"])
      : agent.allowed_tools;
    if (effectiveAllowedTools?.length) {
      args.push("--tools", ...effectiveAllowedTools);
    }
    // Pure orchestrators: also explicitly block write tools as belt-and-suspenders
    // AskUserQuestion is always blocked — stdin is closed in CLI invocations,
    // so the tool would hang. We also tell the model via system prompt to prevent
    // wasted turns from repeated failed attempts.
    const baseDisallowed = [...(agent.disallowed_tools ?? []), "AskUserQuestion"];
    const effectiveDisallowed = isReadOnlyAgent
      ? [...new Set([...baseDisallowed, "Write", "Edit", "Bash", "NotebookEdit"])]
      : [...new Set(baseDisallowed)];
    args.push("--disallowed-tools", ...effectiveDisallowed);
    // Append sender identity so the agent knows who it's talking to — critical for --resume
    // sessions where the system prompt is from the original session creation
    const appendPrompt = buildClaudeHarnessAppendPrompt(taskType, opts.senderName);
    args.push("--append-system-prompt", appendPrompt);

    // MCP self-service: give agent access to NyxHive MCP tools
    // Priority: config (AgentConfig) > soul YAML — no role-based defaults
    let mcpTools = agent.mcp_tools ?? [];
    if (mcpTools.length === 0 && opts.agentKey) {
      try {
        const soul = loadAndCompileSoul(opts.agentKey, undefined, opts.instanceSoulsDir);
        if (soul?.capabilities.mcp_tools?.length) {
          mcpTools = soul.capabilities.mcp_tools;
        }
      } catch { /* soul compile failure is non-fatal */ }
    }
    mcpProfile = resolveMcpToolProfile({ requestedTools: mcpTools, taskType, message });
    mcpTools = mcpProfile.exposedTools;
    if (mcpProfile.droppedTools.length > 0) {
      logger.info(
        `[invoke] ${logLabel} MCP profile=${mcpProfile.profile} exposed=${mcpProfile.exposedTools.length}/${mcpProfile.requestedTools.length} ` +
        `saved≈${mcpProfile.estimatedSavedTokens}t dropped=[${mcpProfile.droppedTools.join(",")}]`,
      );
    }
    const mcpUrl = resolveMcpEndpointUrl(opts.config);
    if (mcpTools.length > 0 && opts.config?.server?.api_key && mcpUrl) {
      const mcpSlug = opts.config.daemon?.name?.toLowerCase().replace(/[^a-z0-9]+/g, "_") ?? "nyxhive";
      mcpConfigPath = join(tmpdir(), `${mcpSlug}-mcp-${randomUUID()}.json`);
      writeFileSync(mcpConfigPath, JSON.stringify({
        mcpServers: {
          [mcpSlug]: {
            type: "http",
            url: mcpUrl,
            headers: { Authorization: `Bearer ${opts.config.server.api_key}` },
          },
        },
      }), { mode: 0o600 });
      pendingTempDirs.add(mcpConfigPath);
      args.push("--mcp-config", mcpConfigPath);

      // MCP tools in Claude CLI are named mcp__<instance>__<tool>
      // Merge with --tools so MCP exposure is narrowed even when local tools remain broad.
      const mcpToolNames = mcpTools.map(t => `mcp__${mcpSlug}__${t}`);
      const idx = args.indexOf("--tools");
      if (idx !== -1) {
        let endIdx = idx + 1;
        while (endIdx < args.length && !args[endIdx].startsWith("--")) endIdx++;
        args.splice(endIdx, 0, ...mcpToolNames);
      } else {
        args.push("--tools", "default", ...mcpToolNames);
      }
    }
    // Block global plugins (e.g. claude-mem) — NyxHive manages its own memory
    args.push("--strict-mcp-config");
  } else if (cli === "codex") {
    const codexEffort = getEffortForAgent(agent.effort, agent.role);
    args.push("exec", "--experimental-json", "--dangerously-bypass-approvals-and-sandbox", "--cd", workDir);
    if (agent.model) {
      args.push("--model", agent.model);
    }
    if (codexEffort) {
      args.push("-c", `model_reasoning_effort="${codexEffort === "max" ? "xhigh" : codexEffort}"`);
    }
    args.push("-");
  } else {
    args.push(prompt);
  }

  const toolsIdx = args.indexOf("--tools");
  const toolsArg = toolsIdx !== -1
    ? args.slice(toolsIdx + 1).filter(a => !a.startsWith("--")).join(",") || "all"
    : "all";
  const memoryPolicy = cli === "claude"
    ? "nyxhive"
    : (cli === "codex" && opts.config?.daemon.codex_home ? "codex_home" : "default");
  logger.info(`[invoke] ${logLabel} spawn backend=${cli} cwd=${workDir} timeout=${timeoutSec}s task=${taskType ?? "unknown"} tools=${toolsArg} memory=${memoryPolicy}${resumeSessionId ? ` resume=${resumeSessionId.slice(0, 8)}…` : ""}`);

  // Apply sandbox wrapping (transforms command/env/cwd, caller still does Bun.spawn)
  const sandboxWrapped = opts.sandbox?.wrap({
    command: [resolvedCli, ...args],
    cwd: workDir,
    env,
    mountDirs: [
      ...(opts.config?.vault?.path ? [opts.config.vault.path] : []),
      ...resolvedAllowedDirectories,
    ],
    writableDirs: [workDir],
  });

  const spawnCmd = sandboxWrapped?.command ?? [resolvedCli, ...args];
  const spawnEnv = sandboxWrapped?.env ?? env;
  const spawnCwd = sandboxWrapped?.cwd ?? workDir;

  const proc = Bun.spawn(spawnCmd, {
    cwd: spawnCwd,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "pipe",
    env: spawnEnv,
  });

  if (shouldReadCodexPromptFromStdin(cli)) {
    proc.stdin.write(prompt);
  }
  proc.stdin.end();

  // Update registry with PID so watchdog can kill stuck processes
  if (opts.registry && opts.agentKey && proc.pid) {
    opts.registry.updateRunningPid(opts.agentKey, proc.pid);
  }

  // Shared ref: streamCLIOutput updates this on meaningful events (tool calls, text).
  // The outer heartbeat only pings the watchdog registry when activity is recent.
  const meaningfulActivity = { lastAt: Date.now() };
  const MEANINGFUL_STALL_MS = STALL_TIMEOUT_MS;
  const heartbeatInterval = setInterval(() => {
    if (Date.now() - meaningfulActivity.lastAt < MEANINGFUL_STALL_MS) {
      opts.onHeartbeat?.();
    }
  }, 30_000);

  // Wire abort signal for task cancellation
  if (opts.signal) {
    opts.signal.addEventListener("abort", () => {
      proc.kill("SIGTERM");
      // Wait briefly for graceful shutdown, then kill process group
      setTimeout(() => {
        try {
          if (proc.pid) {
            // Kill children first
            Bun.spawnSync(["pkill", "-9", "-P", String(proc.pid)]);
            // Then force-kill the process itself if still alive
            try { process.kill(proc.pid, "SIGKILL"); } catch {}
          }
        } catch {}
      }, 5000);
    }, { once: true });
  }

  // Race against timeout
  let timeoutId: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      proc.kill("SIGTERM");
      // Wait briefly for graceful shutdown, then kill process group
      setTimeout(() => {
        try {
          if (proc.pid) {
            // Kill children first
            Bun.spawnSync(["pkill", "-9", "-P", String(proc.pid)]);
            // Then force-kill the process itself if still alive
            try { process.kill(proc.pid, "SIGKILL"); } catch {}
          }
        } catch {}
      }, 5000);
      reject(new Error(`${cli} timed out after ${timeoutSec}s`));
    }, timeoutMs);
  });

  try {
    // Stream stdout line by line for live CLI progress (claude NDJSON)
    const stdoutPromise = cli === "claude"
      ? streamCLIOutput(proc.stdout, agent, startTime, logLabel, taskType, opts.onProgress, opts.onFileChange, meaningfulActivity)
      : cli === "codex" && opts.streamCodexProgress !== false
      ? streamCodexOutput(proc.stdout, agent, startTime, logLabel, opts.onProgress, meaningfulActivity)
      : new Response(proc.stdout).text().then((s): StreamResult => ({ output: s, orphanedSubagents: [] }));

    const [stdoutResult, stderr] = await Promise.race([
      Promise.all([
        stdoutPromise,
        new Response(proc.stderr).text(),
      ]),
      timeout.then(() => [{ output: "", orphanedSubagents: [] as OrphanedSubagent[] }, ""] as [StreamResult, string]),
    ]);

    const exitCode = await Promise.race([proc.exited, timeout]);
    clearTimeout(timeoutId!);

    // Log orphaned subagents with exit code context
    const { output: stdout, orphanedSubagents, harnessSignals } = stdoutResult;
    if (orphanedSubagents.length > 0) {
      for (const sub of orphanedSubagents) {
        logger.warn(`[invoke] ${logLabel} subagent="${sub.description}" orphaned duration=${sub.durationSec}s exit=${exitCode}`);
      }
      logger.warn(`[invoke] ${logLabel} cli_exit=${exitCode} orphaned_subagents=${orphanedSubagents.length} results_lost=1`);
    }

    if (exitCode !== 0) {
      const partialOutput = stdout.trim();
      // SIGINT (130) or SIGTERM (143) with partial output — treat as success with warning
      if ((exitCode === 130 || exitCode === 143) && partialOutput.length > 0) {
        logger.warn(`[invoke] ${logLabel} signal_exit=${exitCode} partial_output=${partialOutput.length}chars`);
      } else {
        // If we were resuming a session and it failed, retry without resume
        if (resumeSessionId) {
          const errOutput = (stderr as string).trim() || partialOutput;
          const resumeRetryAttempt = (opts as InvokeOptsWithResumeRetry)._resumeBusyRetryAttempt ?? 0;
          const busyRetryDelayMs = isClaudeSessionBusyError(errOutput)
            ? getClaudeSessionBusyRetryDelayMs(resumeRetryAttempt)
            : undefined;
          if (busyRetryDelayMs !== undefined) {
            const waitResult = await waitForClaudeSessionRelease(resumeSessionId, { timeoutMs: busyRetryDelayMs });
            if (waitResult.released) {
              logger.warn(
                `[invoke] ${logLabel} resume_busy exit=${exitCode} retry=${resumeRetryAttempt + 1}/${CLAUDE_SESSION_BUSY_RETRY_DELAYS_MS.length} released=1 wait_ms=${waitResult.waitedMs}`,
              );
              return invokeCLI(
                agent,
                message,
                { ...opts, _resumeBusyRetryAttempt: resumeRetryAttempt + 1 } as InvokeOptsWithResumeRetry,
                startTime,
                taskType,
              );
            }
            const ownerSummary = waitResult.owners.map((owner) => `${owner.pid}${owner.cwd ? `@${owner.cwd}` : ""}`).join(",");
            if (waitResult.owners.length > 0) {
              // The previous invocation already returned its result — these processes are cleanup
              // remnants. Force-kill them to free the session ID so we can resume.
              let forceKilled = 0;
              for (const owner of waitResult.owners) {
                try { process.kill(owner.pid, "SIGTERM"); forceKilled++; } catch {}
              }
              logger.warn(
                `[invoke] ${logLabel} resume_busy exit=${exitCode} force_killed=${forceKilled} owners=${ownerSummary} wait_ms=${waitResult.waitedMs}`,
              );
              // Give killed processes up to 3s to clean up their session files
              const cleanupWait = await waitForClaudeSessionRelease(resumeSessionId, { timeoutMs: 3_000 });
              if (!cleanupWait.released) {
                // Still holding — manually remove stale session files
                for (const owner of cleanupWait.owners) {
                  try { unlinkSync(owner.path); } catch {}
                }
                logger.warn(`[invoke] ${logLabel} session_files_purged session=${resumeSessionId.slice(0, 8)}`);
              }
              logger.warn(`[invoke] ${logLabel} session_force_freed session=${resumeSessionId.slice(0, 8)} retry_resume=1`);
              return invokeCLI(
                agent,
                message,
                { ...opts, _resumeBusyRetryAttempt: resumeRetryAttempt + 1 } as InvokeOptsWithResumeRetry,
                startTime,
                taskType,
              );
            }
            logger.warn(
              `[invoke] ${logLabel} resume_busy exit=${exitCode} released=0 wait_ms=${waitResult.waitedMs} owners=${ownerSummary || "unknown"}`,
            );
          }
          logger.warn(`[invoke] ${logLabel} resume_failed exit=${exitCode} error=${errOutput.slice(0, 200)}`);
          const freshOpts = { ...opts, sessionId: undefined } as InvokeOptsWithResumeRetry;
          return invokeCLI(agent, message, freshOpts, startTime, taskType);
        }
        const errOutput = (stderr as string).trim() || partialOutput;
        throw new Error(`${cli} exited with code ${exitCode}: ${errOutput.slice(0, 500)}`);
      }
    }

    const rawOutput = stdout.trim();
    if (!rawOutput) {
      // Structured diagnostics for empty stdout — capture everything useful for debugging
      const stderrStr = (stderr as string)?.trim() ?? "";
      const elapsed = Date.now() - startTime;
      logger.warn(`[invoke] ${logLabel} empty_stdout exit=${exitCode} stderr=${stderrStr.length}chars elapsed=${elapsed}ms session=${resumeSessionId ?? "none"} model=${agent.model} prompt=${message.length}chars`);
      if (stderrStr) {
        logger.warn(`[invoke] ${logLabel} stderr=${stderrStr.slice(0, 500)}`);
      }

      // Retry once without session resume on empty response
      if (resumeSessionId) {
        logger.warn(`[invoke] ${logLabel} empty_response resume=1 retry=fresh`);
        const freshOpts = { ...opts, sessionId: undefined };
        return invokeCLI(agent, message, freshOpts, startTime, taskType);
      }
      if (!opts._emptyRetried) {
        logger.warn(`[invoke] ${logLabel} empty_response retry=fresh`);
        return invokeCLI(agent, message, { ...opts, _emptyRetried: true }, startTime, taskType);
      }
      throw new Error(`${cli} returned empty response (exit=${exitCode}, elapsed=${elapsed}ms, stderr=${stderrStr.slice(0, 200)})`);
    }

    const duration = Date.now() - startTime;

    if (cli === "claude") {
      if (harnessSignals?.planningViolation && harnessSignals.firstToolName) {
        logger.warn(`[invoke] ${logLabel} planning_missing first_tool=${harnessSignals.firstToolName} task=${taskType ?? "unknown"}`);
      }
      if (harnessSignals?.missingVerification) {
        logger.warn(`[invoke] ${logLabel} verification_missing task=${taskType ?? "unknown"} turns=${harnessSignals.turnCount}`);
      }
    }

    // Parse claude JSON output for tokens, cost, response
    if (cli === "claude") {
      const cliResult = parseClaudeJsonOutput(agent, rawOutput, duration, logLabel);
      cliResult.task_type = taskType as TaskType;
      if (mcpProfile) {
        cliResult.context_budget = {
          mcp_profile: mcpProfile.profile,
          mcp_requested_tools: mcpProfile.requestedTools.length,
          mcp_exposed_tools: mcpProfile.exposedTools.length,
          mcp_dropped_tools: mcpProfile.droppedTools,
          estimated_mcp_schema_tokens: mcpProfile.estimatedSchemaTokens,
          estimated_mcp_saved_tokens: mcpProfile.estimatedSavedTokens,
        };
      }

      if (cliResult.session_id) {
        const release = await waitForClaudeSessionRelease(cliResult.session_id);
        if (release.released) {
          if (release.waitedMs > 0) {
            logger.info(
              `[invoke] ${logLabel} session_released session=${cliResult.session_id.slice(0, 8)} wait_ms=${release.waitedMs}`,
            );
          }
        } else {
          const ownerSummary = release.owners.map((owner) => `${owner.pid}${owner.cwd ? `@${owner.cwd}` : ""}`).join(",");
          logger.warn(
            `[invoke] ${logLabel} session_release_timeout session=${cliResult.session_id.slice(0, 8)} wait_ms=${release.waitedMs} owners=${ownerSummary || "unknown"} discard_resume=1`,
          );
          delete cliResult.session_id;
          delete cliResult.session_runtime;
        }
      }

      // Surface plan content when CLI exited from plan mode
      if (cliResult.exitedPlanMode) {
        const planContent = readLatestPlanFile(workDir);
        if (planContent) {
          cliResult.response = `Plan ready for review:\n\n${planContent}`;
        } else if (cliResult.planText) {
          cliResult.response = cliResult.planText;
          logger.info(`[invoke] ${logLabel} plan_extracted size=${cliResult.planText.length}chars`);
        }
        delete cliResult.exitedPlanMode;
        delete cliResult.planText;
      }

      return cliResult;
    }

    if (cli === "codex") {
      let cliResult: ReturnType<typeof parseCodexJsonOutput>;
      try {
        cliResult = parseCodexJsonOutput(agent, rawOutput, duration, logLabel);
      } catch (err) {
        if (err instanceof CodexNoAssistantResponseError && !opts._emptyRetried) {
          logger.warn(`[invoke] ${logLabel} codex_no_assistant_response retry=fresh error=${err.message}`);
          return invokeCLI(agent, message, { ...opts, _emptyRetried: true }, startTime, taskType);
        }
        throw err;
      }
      cliResult.task_type = taskType as TaskType;
      if (
        evidencePreflightRan &&
        requiresCodexToolEvidence(message) &&
        isLikelyCodexPlanOnlyResponse(cliResult.response)
      ) {
        logger.warn(`[invoke] ${logLabel} codex_plan_only_after_preflight fallback=harness_review`);
        cliResult.response = buildEvidenceReview(
          evidencePreflightResults,
          "I checked the live repo evidence before answering. Codex did not produce extra tool output after the harness preflight, so this review is grounded in the commands NyxHive ran directly.",
        );
        cliResult.model = "harness-evidence-review";
        cliResult.method = "api";
        cliResult.tokens_in = cliResult.tokens_in ?? 0;
        cliResult.tokens_out = cliResult.tokens_out ?? 0;
        cliResult.cost = cliResult.cost ?? 0;
        return cliResult;
      }
      if (shouldRetryCodexPlanOnlyTurn(
        taskType,
        cliResult.response,
        cliResult.toolsUsed,
        !!(opts as InvokeOptsWithResumeRetry)._codexActionRetried,
        message,
      )) {
        logger.warn(`[invoke] ${logLabel} codex_plan_only retry=1 task=${taskType ?? "unknown"}`);
        const retryPrompt = `${message}\n\n[Harness retry]\nYou explained a plan without taking action. Do not restate the plan. Take the first concrete action now using available tools or commands, then continue until the task is actually complete.`;
        const retryOpts: InvokeOptsWithResumeRetry = {
          ...(opts as InvokeOptsWithResumeRetry),
          _codexActionRetried: true,
        };
        return invokeCLI(
          agent,
          retryPrompt,
          retryOpts,
          startTime,
          taskType,
        );
      }
      if (
        (opts as InvokeOptsWithResumeRetry)._codexActionRetried &&
        !evidencePreflightRan &&
        requiresCodexToolEvidence(message) &&
        (cliResult.toolsUsed?.length ?? 0) === 0
      ) {
        throw new Error("Codex returned without using tools for a tool-required request after retry.");
      }
      return cliResult;
    }

    // Non-claude CLI: raw text response
    logger.info(`[invoke] ${logLabel} completed backend=${cli} duration=${duration}ms output=${rawOutput.length}chars`);

    return {
      response: rawOutput,
      agent: agent.name,
      method: "cli",
      task_type: taskType as InvocationTaskType,
      duration_ms: duration,
    };
  } catch (err) {
    clearTimeout(timeoutId!);
    proc.kill();
    throw err;
  } finally {
    clearInterval(heartbeatInterval);
    // Clean up sandbox resources (temp profiles, containers)
    sandboxWrapped?.cleanup?.();
    cleanupInvocationTempFiles(tempFiles, tempDir, mcpConfigPath);
  }
}

/**
 * Stream claude CLI output for live progress.
 *
 * With --output-format stream-json --verbose --include-partial-messages:
 *   Emits real-time stream_event lines (content_block_start, delta, stop, etc.)
 *   plus assistant (complete per-turn) and result lines.
 *   Stream events are parsed for real-time logging but NOT accumulated (too large).
 *   Only assistant + result lines are returned for parseClaudeJsonOutput().
 *
 * Fallback: If no stream_event lines appear (e.g. older CLI), falls back to
 *   per-turn assistant message parsing (same as before).
 *
 * Heartbeat: Logs every 30s during silent periods + calls onProgress so
 *   channels (Discord/Telegram) can send "still working..." pings.
 */
interface OrphanedSubagent {
  description: string;
  durationSec: number;
}

interface StreamResult {
  output: string;
  orphanedSubagents: OrphanedSubagent[];
  harnessSignals?: {
    firstToolName?: string;
    planningViolation: boolean;
    missingVerification: boolean;
    turnCount: number;
  };
}

async function streamCLIOutput(
  stream: ReadableStream<Uint8Array>,
  agent: AgentConfig,
  startTime: number,
  logLabel: string,
  taskType?: string,
  onProgress?: (info: CLIProgress) => void,
  onFileChange?: InvokeOpts["onFileChange"],
  meaningfulActivity?: { lastAt: number },
): Promise<StreamResult> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const outputLines: string[] = []; // Only assistant + result lines (for parseClaudeJsonOutput)

  // Token / turn tracking
  let turnCount = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let hasStreamEvents = false;
  let lastActivity = ""; // human-readable description of current action

  // Incremental text streaming to channels
  let fullResponseText = "";
  let pendingTextDelta = "";
  let lastTextEmit = Date.now();
  const TEXT_EMIT_INTERVAL_MS = 150;
  const TEXT_EMIT_MIN_CHARS = 1;
  const planningRequired = shouldRequirePlanning(taskType);
  let firstToolName: string | undefined;
  const verificationTurns: number[] = [];
  const toolNamesByUseId = new Map<string, string>();

  function maybeEmitTextProgress() {
    const sinceLastEmit = Date.now() - lastTextEmit;
    if (pendingTextDelta.length >= TEXT_EMIT_MIN_CHARS || sinceLastEmit >= TEXT_EMIT_INTERVAL_MS) {
      onProgress?.({
        turns: turnCount,
        tokensIn, tokensOut,
        elapsed: Math.round((Date.now() - startTime) / 1000),
        activity: lastActivity,
        textDelta: pendingTextDelta,
        textSoFar: fullResponseText,
        phase: "responding",
        streamingSafe: true,
      });
      lastTextEmit = Date.now();
      pendingTextDelta = "";
    }
  }

  // Active content blocks within current turn (stream events)
  const activeBlocks = new Map<number, {
    type: string;
    name?: string;
    text: string;
    inputJson: string;
    toolUseId?: string;
    resultText: string;
  }>();

  // Subagent tracking — detect Agent tool calls, log duration, warn on long-running
  const SUBAGENT_WARN_MS = SUBAGENT_WARN_THRESHOLD_MS;
  const SUBAGENT_ALERT_MS = 300_000; // alert after 5 min
  interface ActiveSubagent {
    blockIdx: number;
    description: string;
    startedAt: number;
    warned: boolean;
    alerted: boolean;
  }
  const activeSubagents = new Map<number, ActiveSubagent>();

  // Heartbeat: fires every 30s during silent periods
  // Stall detection: based on time since last MEANINGFUL event (tool calls, text, message starts),
  // not raw stream bytes. Keepalive bytes don't count as progress.
  let _lastEventTime = Date.now();
  let lastMeaningfulEventTime = Date.now();
  let stalled = false;
  const HEARTBEAT_MS = SSE_HEARTBEAT_INTERVAL_MS;
  const MAX_ELAPSED_MS = 3_600_000; // 1 hour hard ceiling
  const heartbeatInterval = setInterval(() => {
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const meaningfulSilence = Math.round((Date.now() - lastMeaningfulEventTime) / 1000);
    const meaningfulSilenceMs = Date.now() - lastMeaningfulEventTime;
    const totalElapsedMs = Date.now() - startTime;

    // Hard ceiling: nothing runs longer than MAX_ELAPSED_MS
    if (totalElapsedMs >= MAX_ELAPSED_MS) {
      stalled = true;
      logger.error(`[invoke] ${logLabel} backend=claude max_elapsed=${elapsed}s aborting=1`);
      onProgress?.({ turns: turnCount, tokensIn, tokensOut, elapsed, activity: `MAX TIME — aborting after ${elapsed}s`, phase: "working" });
      reader.cancel();
      return;
    }

    // Subagent duration checks — log warnings for long-running Agent tools
    for (const [_idx, sub] of activeSubagents) {
      const runningMs = Date.now() - sub.startedAt;
      const runningSec = Math.round(runningMs / 1000);
      if (runningMs >= SUBAGENT_ALERT_MS && !sub.alerted) {
        sub.alerted = true;
        logger.warn(`[invoke] ${logLabel} subagent="${sub.description}" running=${runningSec}s stuck=possible`);
        onProgress?.({ turns: turnCount, tokensIn, tokensOut, elapsed, activity: `Subagent stuck? "${sub.description}" (${runningSec}s)`, phase: "working", agent: agent.name });
      } else if (runningMs >= SUBAGENT_WARN_MS && !sub.warned) {
        sub.warned = true;
        logger.info(`[invoke] ${logLabel} subagent="${sub.description}" running=${runningSec}s`);
        onProgress?.({ turns: turnCount, tokensIn, tokensOut, elapsed, activity: `Subagent: "${sub.description}" (${runningSec}s)`, phase: "working", agent: agent.name });
      } else if (meaningfulSilence >= 25) {
        // Regular heartbeat for active subagent
        logger.info(`[invoke] ${logLabel} alive=${elapsed}s subagent="${sub.description}" running=${runningSec}s`);
        onProgress?.({ turns: turnCount, tokensIn, tokensOut, elapsed, activity: `Subagent: "${sub.description}" (${runningSec}s)`, phase: "working", agent: agent.name });
      }
    }

    // Standard heartbeat when no subagents active
    if (activeSubagents.size === 0 && meaningfulSilence >= 25) {
      const turnInfo = turnCount > 0 ? `${turnCount} turns` : "thinking";
      logger.info(`[invoke] ${logLabel} alive=${elapsed}s turns=${turnCount} state=${turnInfo === "thinking" ? "thinking" : "waiting"}`);
      onProgress?.({ turns: turnCount, tokensIn, tokensOut, elapsed, activity: lastActivity, phase: "working" });
    }

    // Stall detection: no meaningful event for the configured timeout, no subagents running.
    // Before first tool call, use the startup grace for the initial model response.
    const effectiveTimeout = turnCount > 0 ? STALL_TIMEOUT_MS : STARTUP_GRACE_MS;
    if (activeSubagents.size === 0 && meaningfulSilenceMs >= effectiveTimeout) {
      stalled = true;
      logger.error(`[invoke] ${logLabel} backend=claude stalled=${meaningfulSilence}s turn=${turnCount} aborting=1`);
      onProgress?.({ turns: turnCount, tokensIn, tokensOut, elapsed, activity: `STALLED — aborting after ${meaningfulSilence}s silence`, phase: "working" });
      reader.cancel();
    }

    // Update meaningful activity ref for outer watchdog heartbeat
    if (meaningfulActivity && meaningfulSilenceMs < STALL_TIMEOUT_MS) {
      meaningfulActivity.lastAt = lastMeaningfulEventTime;
    }
  }, HEARTBEAT_MS);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      _lastEventTime = Date.now();

      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n");
      buffer = parts.pop() ?? "";

      for (const line of parts) {
        if (!line.trim()) continue;

        try {
          const parsed = JSON.parse(line);

          // ── Real-time stream events (from --include-partial-messages) ──
          if (parsed.type === "stream_event") {
            hasStreamEvents = true;
            lastMeaningfulEventTime = Date.now();
            const evt = parsed.event;

            if (evt.type === "message_start") {
              // Resolve any active subagents — new turn means their execution completed
              for (const [subIdx, sub] of activeSubagents) {
                const durationMs = Date.now() - sub.startedAt;
                const durationSec = Math.round(durationMs / 1000);
                if (durationSec >= 5) {
                  logger.info(`[invoke] ${logLabel} subagent="${sub.description}" completed=${durationSec}s`);
                }
                onProgress?.({
                  turns: turnCount,
                  tokensIn,
                  tokensOut,
                  elapsed: Math.round((Date.now() - startTime) / 1000),
                  activity: `Subagent: "${sub.description}"`,
                  phase: "working",
                  agent: agent.name,
                  executionEvent: buildClaudeToolExecutionEvent(`${turnCount}:${subIdx}:Task`, "Task", "completed", { description: sub.description }, turnCount),
                });
                activeSubagents.delete(subIdx);
              }

              // Inject turn separator between text blocks so multi-turn responses
              // don't merge into one wall of text.
              if (turnCount >= 1 && fullResponseText.length > 0) {
                fullResponseText += "\n\n";
                pendingTextDelta += "\n\n";
              }

              turnCount++;
              activeBlocks.clear();
              // Capture input tokens from message_start (this is where the API reports them)
              if (evt.message?.usage) {
                const u = evt.message.usage;
                tokensIn += (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
              }
              const elapsed = Math.round((Date.now() - startTime) / 1000);
              logger.info(`[invoke] ${logLabel} turn=${turnCount} elapsed=${elapsed}s started=1`);
            }

            else if (evt.type === "content_block_start") {
              const idx = evt.index ?? 0;
              const block = evt.content_block ?? {};
              activeBlocks.set(idx, {
                type: block.type ?? "text",
                name: block.name,
                text: block.text ?? "",
                inputJson: "",
                toolUseId: typeof block.id === "string" ? block.id : typeof block.tool_use_id === "string" ? block.tool_use_id : undefined,
                resultText: extractTextFromToolResultContent(block.content),
              });
              // Log tool start immediately — user sees the tool name in real-time
              if (block.type === "tool_use" && block.name) {
                if (!firstToolName) {
                  firstToolName = block.name;
                  if (planningRequired && firstToolName !== "TodoWrite") {
                    logger.warn(`[invoke] ${logLabel} planning_expected first_tool=${firstToolName}`);
                  }
                }
                if (typeof block.id === "string") {
                  toolNamesByUseId.set(block.id, block.name);
                }
                lastActivity = formatToolActivity(block.name);
                const elapsed = Math.round((Date.now() - startTime) / 1000);
                logger.info(`[invoke] ${logLabel} turn=${turnCount} elapsed=${elapsed}s tool_start=${block.name}`);
                // Emit immediately so SSE clients see tool activity in real-time
                onProgress?.({
                  turns: turnCount,
                  tokensIn,
                  tokensOut,
                  elapsed,
                  activity: lastActivity,
                  phase: "working",
                  executionEvent: buildClaudeToolExecutionEvent(`${turnCount}:${idx}:${block.name}`, block.name, "started", undefined, turnCount),
                });
              }
            }

            else if (evt.type === "content_block_delta") {
              const idx = evt.index ?? 0;
              const delta = evt.delta ?? {};
              const block = activeBlocks.get(idx);
              if (block) {
                if (delta.type === "text_delta") {
                  block.text += delta.text ?? "";
                  fullResponseText += delta.text ?? "";
                  pendingTextDelta += delta.text ?? "";
                  maybeEmitTextProgress();
                }
                else if (delta.type === "input_json_delta") block.inputJson += delta.partial_json ?? "";
              }
            }

            else if (evt.type === "content_block_stop") {
              const idx = evt.index ?? 0;
              const block = activeBlocks.get(idx);
              const elapsed = Math.round((Date.now() - startTime) / 1000);

              if (block?.type === "tool_use" && block.inputJson) {
                // Log tool details now that we have the full input
                try {
                  const input = JSON.parse(block.inputJson);
                  if (block.toolUseId && block.name) {
                    toolNamesByUseId.set(block.toolUseId, block.name);
                  }
                  if (block.name === "Write" || block.name === "Edit" || block.name === "MultiEdit") {
                    const filePath = typeof input.file_path === "string" ? input.file_path : undefined;
                    if (filePath) {
                      onFileChange?.({
                        filePath,
                        operation: block.name === "Write" ? "write" : "edit",
                        linesAdded: 0,
                        linesRemoved: 0,
                        diffSummary: `${block.name}: ${filePath}`,
                      });
                    }
                  }
                  if (block.name === "Bash" && isVerificationCommand(typeof input.command === "string" ? input.command : undefined)) {
                    verificationTurns.push(turnCount);
                  }
                  // Agent tool: track subagent lifecycle for duration monitoring
                  if ((block.name === "Task" || block.name === "Agent") && input.description) {
                    const parts = [input.description];
                    if (input.subagent_type) parts.push(`type=${input.subagent_type}`);
                    if (input.model) parts.push(`model=${input.model}`);
                    const taskDetail = parts.join(", ");
                    lastActivity = formatToolActivity("Task", taskDetail);
                    logger.info(`[invoke] ${logLabel} turn=${turnCount} elapsed=${elapsed}s subagent=${taskDetail}`);
                    // Register subagent for duration tracking
                    activeSubagents.set(idx, {
                      blockIdx: idx,
                      description: input.description,
                      startedAt: Date.now(),
                      warned: false,
                      alerted: false,
                    });
                    onProgress?.({
                      turns: turnCount,
                      tokensIn,
                      tokensOut,
                      elapsed,
                      activity: lastActivity,
                      phase: "working",
                      agent: agent.name,
                      executionEvent: buildClaudeToolExecutionEvent(`${turnCount}:${idx}:${block.name}`, block.name, "completed", input, turnCount),
                    });
                  } else {
                    const detail = input.file_path || input.command?.slice(0, 80) || input.pattern || input.query?.slice(0, 60) || input.url?.slice(0, 60) || input.description?.slice(0, 60) || "";
                    if (detail) {
                      lastActivity = formatToolActivity(block.name!, detail);
                      logger.info(`[invoke] ${logLabel} turn=${turnCount} elapsed=${elapsed}s tool_done=${block.name} detail=${detail}`);
                      onProgress?.({
                        turns: turnCount,
                        tokensIn,
                        tokensOut,
                        elapsed,
                        activity: lastActivity,
                        phase: "working",
                        executionEvent: buildClaudeToolExecutionEvent(`${turnCount}:${idx}:${block.name}`, block.name!, "completed", input, turnCount),
                      });
                    }
                  }
                } catch { /* partial JSON, skip */ }
              } else if (block?.type === "tool_result" && block.toolUseId) {
                const linkedToolName = toolNamesByUseId.get(block.toolUseId);
                const preview = formatToolResultPreview(block.resultText);
                if (linkedToolName && preview) {
                  onProgress?.({
                    turns: turnCount,
                    tokensIn,
                    tokensOut,
                    elapsed,
                    activity: formatToolActivity(linkedToolName),
                    phase: "working",
                    executionEvent: {
                      ...buildClaudeToolExecutionEvent(`${turnCount}:${idx}:${linkedToolName}:result`, linkedToolName, "updated", undefined, turnCount),
                      outputPreview: preview,
                    },
                  });
                }
              } else if (block?.type === "text" && block.text.trim()) {
                const excerpt = block.text.trim().slice(0, 120);
                logger.info(`[invoke] ${logLabel} turn=${turnCount} elapsed=${elapsed}s text="${excerpt}${block.text.trim().length > 120 ? "…" : ""}"`);
                // Flush any remaining text delta
                if (pendingTextDelta) {
                  onProgress?.({
                    turns: turnCount, tokensIn, tokensOut,
                    elapsed,
                    activity: lastActivity,
                    textDelta: pendingTextDelta,
                    textSoFar: fullResponseText,
                    phase: "responding",
                    streamingSafe: true,
                  });
                  pendingTextDelta = "";
                  lastTextEmit = Date.now();
                }
              }
            }

            else if (evt.type === "message_delta") {
              // Only accumulate output tokens here; input tokens come from message_start
              if (evt.usage) {
                tokensOut += evt.usage.output_tokens ?? 0;
              }
              const elapsed = Math.round((Date.now() - startTime) / 1000);
              onProgress?.({ turns: turnCount, tokensIn, tokensOut, elapsed, activity: lastActivity, phase: "working" });
            }

            // Don't accumulate stream_event lines — too large, not needed for result parsing
            continue;
          }

          // ── System / rate_limit events — skip ──
          if (parsed.type === "system" || parsed.type === "rate_limit_event") {
            continue;
          }

          // ── Assistant per-turn message — accumulate for parseClaudeJsonOutput ──
          if (parsed.type === "assistant" && parsed.message) {
            lastMeaningfulEventTime = Date.now();
            outputLines.push(line);

            // Only log from assistant messages if we have NO stream events (fallback mode)
            if (!hasStreamEvents) {
              const msg = parsed.message;
              if (msg.usage) {
                turnCount++;
                const u = msg.usage;
                tokensIn += (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
                tokensOut += u.output_tokens ?? 0;
              }

              const content = msg.content ?? [];
              const tools: string[] = [];
              let textExcerpt = "";

              for (const block of content) {
                if (block.type === "tool_use") {
                  const name = block.name ?? "unknown";
                  const input = block.input ?? {};
                  let detail = "";
                  if (input.file_path) detail = input.file_path;
                  else if (input.command) detail = input.command.slice(0, 80);
                  else if (input.pattern) detail = input.pattern;
                  else if (input.query) detail = input.query.slice(0, 60);
                  else if (input.url) detail = input.url.slice(0, 60);
                  tools.push(detail ? `${name}(${detail})` : name);
                } else if (block.type === "text" && block.text && !textExcerpt) {
                  textExcerpt = block.text.trim().slice(0, 120);
                }
              }

              const elapsed = Math.round((Date.now() - startTime) / 1000);
              if (tools.length > 0) {
                logger.info(`[invoke] ${logLabel} turn=${turnCount} elapsed=${elapsed}s tools=${tools.join(", ")}`);
              } else if (textExcerpt) {
                logger.info(`[invoke] ${logLabel} turn=${turnCount} elapsed=${elapsed}s text="${textExcerpt}${textExcerpt.length >= 120 ? "…" : ""}"`);
              } else if (msg.usage) {
                logger.info(`[invoke] ${logLabel} turn=${turnCount} elapsed=${elapsed}s tokens=${tokensIn}+${tokensOut}`);
              }

              if (msg.usage) {
                onProgress?.({ turns: turnCount, tokensIn, tokensOut, elapsed, phase: "working" });
              }
            }
            continue;
          }

          // ── Result / unknown — always accumulate ──
          outputLines.push(line);

        } catch {
          // Not valid JSON line, accumulate anyway
          outputLines.push(line);
        }
      }
    }
  } finally {
    clearInterval(heartbeatInterval);
  }

  // Collect orphaned subagents for caller to log with exit code context
  const orphanedSubagents: OrphanedSubagent[] = [];
  for (const [, sub] of activeSubagents) {
    orphanedSubagents.push({
      description: sub.description,
      durationSec: Math.round((Date.now() - sub.startedAt) / 1000),
    });
  }
  activeSubagents.clear();

  // API stream stall detected — throw so invokeCLI kills the process and caller can retry
  if (stalled) {
    throw new Error(`API stream stalled on turn ${turnCount} — no data for ${Math.round(STALL_TIMEOUT_MS / 1000)}s`);
  }

  // Remaining buffer
  if (buffer.trim()) outputLines.push(buffer);
  return {
    output: outputLines.join("\n"),
    orphanedSubagents,
    harnessSignals: {
      firstToolName,
      planningViolation: planningRequired && !!firstToolName && firstToolName !== "TodoWrite",
      missingVerification: shouldRequirePlanning(taskType) && isCompletionClaim(fullResponseText) && !hasRecentVerification(turnCount, verificationTurns),
      turnCount,
    },
  };
}

async function streamCodexOutput(
  stream: ReadableStream<Uint8Array>,
  agent: AgentConfig,
  startTime: number,
  logLabel: string,
  onProgress?: (info: CLIProgress) => void,
  meaningfulActivity?: { lastAt: number },
): Promise<StreamResult> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const outputLines: string[] = [];

  let turnCount = 0;
  let tokensIn = 0;
  let tokensOut = 0;
  let lastActivity = "";
  let fullResponseText = "";
  let lastMeaningfulEventTime = Date.now();
  let stalled = false;

  const activeCommands = new Map<string, { command?: string; startedAt: number }>();
  const heartbeatInterval = setInterval(() => {
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    const meaningfulSilence = Math.round((Date.now() - lastMeaningfulEventTime) / 1000);
    const meaningfulSilenceMs = Date.now() - lastMeaningfulEventTime;

    for (const [id, cmd] of activeCommands) {
      const runningSec = Math.round((Date.now() - cmd.startedAt) / 1000);
      const commandActivity = formatToolActivity("Bash", cmd.command);
      logger.info(`[invoke] ${logLabel} alive=${elapsed}s command=${id} running=${runningSec}s`);
      onProgress?.({
        turns: turnCount,
        tokensIn,
        tokensOut,
        elapsed,
        activity: `${commandActivity} (${runningSec}s)`,
        phase: "working",
        agent: agent.name,
      });
    }

    if (activeCommands.size === 0 && meaningfulSilence >= 25) {
      logger.info(`[invoke] ${logLabel} alive=${elapsed}s turns=${turnCount} state=waiting`);
      const waitingActivity = lastActivity || (turnCount > 0 ? "Waiting for Codex tool activity" : "Starting Codex runtime");
      onProgress?.({
        turns: turnCount,
        tokensIn,
        tokensOut,
        elapsed,
        activity: waitingActivity,
        phase: "working",
        agent: agent.name,
      });
    }

    const effectiveTimeout = turnCount > 0 ? STALL_TIMEOUT_MS : STARTUP_GRACE_MS;
    if (activeCommands.size === 0 && meaningfulSilenceMs >= effectiveTimeout) {
      stalled = true;
      logger.error(`[invoke] ${logLabel} backend=codex stalled=${meaningfulSilence}s turn=${turnCount} aborting=1`);
      onProgress?.({
        turns: turnCount,
        tokensIn,
        tokensOut,
        elapsed,
        activity: `STALLED — aborting after ${meaningfulSilence}s silence`,
        phase: "working",
      });
      reader.cancel();
    }

    if (meaningfulActivity && meaningfulSilenceMs < STALL_TIMEOUT_MS) {
      meaningfulActivity.lastAt = lastMeaningfulEventTime;
    }
  }, SSE_HEARTBEAT_INTERVAL_MS);

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split("\n");
      buffer = parts.pop() ?? "";

      for (const line of parts) {
        if (!line.trim()) continue;
        outputLines.push(line);

        try {
          const parsed: CodexExecEvent = JSON.parse(line);
          const elapsed = Math.round((Date.now() - startTime) / 1000);

          if (parsed.type === "turn.started") {
            turnCount++;
            lastMeaningfulEventTime = Date.now();
            lastActivity = "Codex turn started; waiting for tool activity";
            logger.info(`[invoke] ${logLabel} turn=${turnCount} elapsed=${elapsed}s started=1`);
            onProgress?.({
              turns: turnCount,
              tokensIn,
              tokensOut,
              elapsed,
              activity: lastActivity,
              phase: "working",
              agent: agent.name,
            });
            continue;
          }

          if (parsed.type === "turn.completed" && parsed.usage) {
            lastMeaningfulEventTime = Date.now();
            tokensIn += (parsed.usage.input_tokens ?? 0) + (parsed.usage.cached_input_tokens ?? 0);
            tokensOut += parsed.usage.output_tokens ?? 0;
            onProgress?.({
              turns: turnCount,
              tokensIn,
              tokensOut,
              elapsed,
              activity: lastActivity,
              phase: "working",
              agent: agent.name,
            });
            continue;
          }

          if ((parsed.type === "item.started" || parsed.type === "item.updated" || parsed.type === "item.completed") && parsed.item) {
            const item = parsed.item;

            if (item.type === "command_execution") {
              const commandId = item.id ?? `cmd-${turnCount}`;
              const command = item.command;
              const activity = formatToolActivity("Bash", command);

              if (parsed.type === "item.started") {
                activeCommands.set(commandId, { command, startedAt: Date.now() });
                lastMeaningfulEventTime = Date.now();
                lastActivity = activity;
                logger.info(`[invoke] ${logLabel} turn=${turnCount} elapsed=${elapsed}s codex_command_start=${truncateExecutionText(command) ?? "command"}`);
                onProgress?.({
                  turns: turnCount,
                  tokensIn,
                  tokensOut,
                  elapsed,
                  activity,
                  phase: "working",
                  agent: agent.name,
                  executionEvent: buildCodexCommandExecutionEvent(`${turnCount}:${commandId}`, "started", command, turnCount),
                });
                continue;
              }

              if (parsed.type === "item.updated") {
                lastMeaningfulEventTime = Date.now();
                lastActivity = activity;
                continue;
              }

              activeCommands.delete(commandId);
              lastMeaningfulEventTime = Date.now();
              lastActivity = activity;
              const outputPreview = formatToolResultPreview(item.aggregated_output ?? "");
              const phase: ExecutionEvent["phase"] = typeof item.exit_code === "number" && item.exit_code !== 0 ? "failed" : "completed";
              logger.info(`[invoke] ${logLabel} turn=${turnCount} elapsed=${elapsed}s codex_command_done=${truncateExecutionText(command) ?? "command"} exit=${item.exit_code ?? 0}`);
              onProgress?.({
                turns: turnCount,
                tokensIn,
                tokensOut,
                elapsed,
                activity,
                phase: "working",
                agent: agent.name,
                executionEvent: buildCodexCommandExecutionEvent(`${turnCount}:${commandId}`, phase, command, turnCount, {
                  outputPreview,
                  exitCode: item.exit_code,
                }),
              });
              continue;
            }

            if (item.type === "agent_message" && parsed.type === "item.completed" && item.text) {
              lastMeaningfulEventTime = Date.now();
              if (fullResponseText.length > 0) {
                fullResponseText += "\n\n";
              }
              fullResponseText += item.text;
              onProgress?.({
                turns: turnCount,
                tokensIn,
                tokensOut,
                elapsed,
                activity: lastActivity,
                textDelta: fullResponseText.length === item.text.length ? item.text : `\n\n${item.text}`,
                textSoFar: fullResponseText,
                phase: "responding",
                streamingSafe: false,
                agent: agent.name,
              });
            }
          }
        } catch {
          // Keep raw line for final parser; ignore malformed progress events.
        }
      }
    }
  } finally {
    clearInterval(heartbeatInterval);
  }

  if (stalled) {
    throw new Error(`Codex stream stalled on turn ${turnCount} — no data for ${Math.round(STALL_TIMEOUT_MS / 1000)}s`);
  }

  if (buffer.trim()) outputLines.push(buffer.trim());
  return {
    output: outputLines.join("\n"),
    orphanedSubagents: [],
  };
}

// OpenCode path removed — replaced by native API tool loop (invoke-native-api.ts).
// Non-Anthropic agents with tool_use now route through invokeNativeAPI() which
// calls provider APIs directly and executes tools locally in the harness.

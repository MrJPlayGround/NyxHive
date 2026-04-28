import { Codex, type ThreadEvent } from "@openai/codex-sdk";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import type { AgentConfig, InvocationResult, InvocationTaskType } from "../types.js";
import { sanitizeEnv } from "../security/vault.js";
import { ensureWorkspace } from "./workspace.js";
import { resolveAgentRuntimePaths } from "./paths.js";
import { applyNyxHiveCliEnvironment, buildCodexCommandExecutionEvent, formatToolActivity, formatToolResultPreview } from "./invoke-cli.js";
import type { CLIProgress, InvokeOpts } from "./invoke.js";
import { logger } from "../utils/logger.js";
import { buildCodexTurnPrompt } from "./codex-turn-envelope.js";
import { getEffortForAgent } from "../defaults.js";
import { resolveCodexSecurityDecision } from "./codex-security.js";

function writeAttachmentFiles(files: InvokeOpts["files"]): { promptPrefix: string; paths: string[]; cleanupDir?: string } {
  if (!files?.length) return { promptPrefix: "", paths: [] };
  const tempDir = join(tmpdir(), `nyxhive-codex-sdk-files-${randomUUID()}`);
  mkdirSync(tempDir, { recursive: true });
  const descriptions: string[] = [];
  const paths: string[] = [];
  for (const file of files) {
    const tempPath = join(tempDir, file.name.replace(/[^a-zA-Z0-9._-]/g, "_"));
    writeFileSync(tempPath, Buffer.from(file.base64, "base64"));
    paths.push(tempPath);
    descriptions.push(`- ${file.name} (${file.mimeType}): ${tempPath}`);
  }
  return {
    promptPrefix: `[Attached Files]\nThe user sent ${files.length} file(s). Read them at:\n${descriptions.join("\n")}\n\n`,
    paths,
    cleanupDir: tempDir,
  };
}

function prepareCodexEnv(agent: AgentConfig, opts: InvokeOpts): Record<string, string> {
  let env = sanitizeEnv(process.env);
  if (opts.config?.server?.api_key) {
    env.NYXHIVE_API_KEY = opts.config.server.api_key;
  }
  if (opts.vault && agent.credentials?.length) {
    Object.assign(env, opts.vault.getForAgent(agent.credentials, agent.name));
  }
  env = applyNyxHiveCliEnvironment(env, "codex", opts.config);
  return env;
}

function emitProgress(opts: InvokeOpts, info: Omit<CLIProgress, "phase"> & { phase?: CLIProgress["phase"] }): void {
  opts.onProgress?.({
    phase: info.phase ?? "working",
    ...info,
  });
}

export async function invokeCodexSdk(
  agent: AgentConfig,
  message: string,
  opts: InvokeOpts,
  startTime: number,
  taskType?: string,
): Promise<InvocationResult> {
  const workspace = ensureWorkspace(agent, opts.baseDir, opts.config, opts.agentKey, opts.registry, opts.scheduler, opts.memory, opts.instanceSoulsDir);
  const workDir = opts.cwdOverride && existsSync(opts.cwdOverride) ? opts.cwdOverride : workspace;
  const configuredAdditionalDirectories = resolveAgentRuntimePaths(opts.baseDir, agent.allowed_directories) ?? [];
  const security = resolveCodexSecurityDecision({
    agent,
    workingDirectory: workDir,
    baseDir: opts.baseDir,
    configuredAdditionalDirectories,
    taskType,
    requireExecutableAuthority: true,
  });
  const authorityEvent = {
    kind: "authority.resolved",
    runtime: "codex_app_server" as const,
    provider: "openai" as const,
    payload: security,
    timestamp: Date.now(),
  };
  const env = prepareCodexEnv(agent, opts);
  const resumeSessionId = opts.sessionId;
  const attachments = writeAttachmentFiles(opts.files);
  const prompt = `${attachments.promptPrefix}${buildCodexTurnPrompt(message, opts, resumeSessionId, taskType)}`;
  const startedAt = Date.now();
  const logPrefix = `[codex-sdk] [agent=${agent.name}]`;
  const reasoningEffort = getEffortForAgent(agent.effort, agent.role);

  logger.info(`${logPrefix} start cwd=${workDir} task=${taskType ?? "unknown"} model=${agent.model}`);

  const codex = new Codex({ env });
  const threadOptions = {
    model: agent.model,
    workingDirectory: workDir,
    sandboxMode: security.sandboxMode,
    approvalPolicy: security.approvalPolicy,
    additionalDirectories: security.additionalDirectories,
    modelReasoningEffort: reasoningEffort === "max" ? "xhigh" as const : reasoningEffort,
  };
  const thread = resumeSessionId
    ? codex.resumeThread(resumeSessionId, threadOptions)
    : codex.startThread(threadOptions);

  emitProgress(opts, {
    turns: 0,
    tokensIn: 0,
    tokensOut: 0,
    elapsed: Math.round((Date.now() - startTime) / 1000),
    activity: "Starting Codex SDK runtime",
    agent: agent.name,
  });

  let finalResponse = "";
  let tokensIn = 0;
  let tokensOut = 0;
  const toolsUsed = new Set<string>();
  let turnCount = 0;

  try {
    const { events } = await thread.runStreamed(prompt, { signal: opts.signal });
    for await (const event of events as AsyncGenerator<ThreadEvent>) {
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      if (event.type === "turn.started") {
        turnCount += 1;
        emitProgress(opts, {
          turns: turnCount,
          tokensIn,
          tokensOut,
          elapsed,
          activity: "Codex SDK turn started",
          agent: agent.name,
        });
        continue;
      }
      if (event.type === "turn.completed") {
        tokensIn += event.usage.input_tokens + event.usage.cached_input_tokens;
        tokensOut += event.usage.output_tokens;
        continue;
      }
      if (event.type === "turn.failed") {
        throw new Error(event.error.message);
      }
      if (event.type === "error") {
        throw new Error(event.message);
      }
      if (event.type === "item.started" || event.type === "item.updated" || event.type === "item.completed") {
        const item = event.item;
        if (item.type === "command_execution") {
          toolsUsed.add("command_execution");
          const phase = item.status === "failed" ? "failed" : item.status === "completed" ? "completed" : event.type === "item.completed" ? "completed" : "started";
          const command = item.command;
          emitProgress(opts, {
            turns: turnCount,
            tokensIn,
            tokensOut,
            elapsed,
            activity: formatToolActivity("Bash", command),
            agent: agent.name,
            executionEvent: buildCodexCommandExecutionEvent(`${turnCount}:${item.id}`, phase, command, turnCount, {
              outputPreview: formatToolResultPreview(item.aggregated_output ?? ""),
              exitCode: item.exit_code,
            }),
          });
          continue;
        }
        if (item.type === "mcp_tool_call") {
          toolsUsed.add(`mcp:${item.server}/${item.tool}`);
          emitProgress(opts, {
            turns: turnCount,
            tokensIn,
            tokensOut,
            elapsed,
            activity: `Calling ${item.server}/${item.tool}`,
            agent: agent.name,
          });
          continue;
        }
        if (item.type === "agent_message" && event.type === "item.completed") {
          finalResponse = item.text;
          emitProgress(opts, {
            turns: turnCount,
            tokensIn,
            tokensOut,
            elapsed,
            activity: "",
            textDelta: item.text,
            textSoFar: item.text,
            streamingSafe: true,
            phase: "responding",
            agent: agent.name,
          });
        }
      }
    }
  } finally {
    if (attachments.cleanupDir) {
      rmSync(attachments.cleanupDir, { recursive: true, force: true });
    }
  }

  if (!finalResponse.trim()) {
    throw new Error("Codex SDK completed without an assistant response");
  }

  const duration = Date.now() - startedAt;
  logger.info(`${logPrefix} completed duration=${duration}ms tokens=${tokensIn}+${tokensOut} tools=${toolsUsed.size}`);
  return {
    response: finalResponse,
    agent: agent.name,
    method: "cli",
    task_type: taskType as InvocationTaskType,
    model: agent.model,
    tokens_in: tokensIn,
    tokens_out: tokensOut,
    duration_ms: Date.now() - startTime,
    toolsUsed: toolsUsed.size > 0 ? [...toolsUsed] : undefined,
    runtime_events: [authorityEvent],
    session_id: thread.id ?? undefined,
    session_runtime: "codex_app_server",
  };
}

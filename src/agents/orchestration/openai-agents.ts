import { Agent, run, tool, type Tool } from "@openai/agents";
import { z } from "zod";
import type { AgentConfig, InvocationResult, InvocationTaskType, NyxHiveConfig } from "../../types.js";
import type { InvokeOpts } from "../invoke.js";
import { invokeCodexSdk } from "../invoke-codex-sdk.js";

export interface OrchestrationRunRequest {
  agent: AgentConfig;
  message: string;
  opts: InvokeOpts;
  startTime: number;
  taskType?: string;
}

export interface AgentOrchestrator {
  run(request: OrchestrationRunRequest): Promise<InvocationResult>;
}

export interface SpecialistAgentDefinition {
  name: string;
  instructions: string;
  handoffDescription?: string;
  model?: string;
}

export interface LocalOrchestrationGuardrailResult {
  allowed: boolean;
  reason?: string;
}

export type LocalOrchestrationGuardrail =
  (request: OrchestrationRunRequest) => LocalOrchestrationGuardrailResult | Promise<LocalOrchestrationGuardrailResult>;

export type CodexExecutor = (
  agent: AgentConfig,
  message: string,
  opts: InvokeOpts,
  startTime: number,
  taskType?: string,
) => Promise<InvocationResult>;

export interface BuildCodexExecutionToolOptions {
  agent: AgentConfig;
  opts: InvokeOpts;
  startTime: number;
  defaultTaskType?: string;
  codexExecutor?: CodexExecutor;
}

export interface CreateOpenAIAgentsOrchestratorOptions {
  specialists?: SpecialistAgentDefinition[];
  inputGuardrails?: LocalOrchestrationGuardrail[];
  codexExecutor?: CodexExecutor;
  maxTurns?: number;
}

const codexExecutionInput = z.object({
  prompt: z.string().trim().min(1),
  taskType: z.string().trim().optional(),
});

function stringifyToolResult(result: InvocationResult): string {
  return JSON.stringify({
    response: result.response,
    agent: result.agent,
    method: result.method,
    task_type: result.task_type,
    toolsUsed: result.toolsUsed,
    session_id: result.session_id,
    session_runtime: result.session_runtime,
  });
}

function formatFinalOutput(output: unknown): string {
  if (typeof output === "string") return output;
  if (output === undefined || output === null) return "";
  return JSON.stringify(output);
}

function buildManagerInstructions(agent: AgentConfig): string {
  return [
    "You are NyxHive's orchestration layer.",
    "Choose between answering directly, handing off to a specialist, or calling Codex for repo mutation.",
    "Use the codex_execute tool only when the task needs local files, shell commands, patches, tests, or other full engineering execution.",
    "Do not reimplement Codex behavior inside this layer. Codex remains the engineering executor.",
    agent.system_prompt?.trim() ? `\n[Agent identity]\n${agent.system_prompt.trim()}` : "",
  ].filter(Boolean).join("\n");
}

function buildSpecialistAgents(definitions: SpecialistAgentDefinition[] | undefined): Agent[] {
  return (definitions ?? []).map((definition) => new Agent({
    name: definition.name,
    instructions: definition.instructions,
    handoffDescription: definition.handoffDescription,
    ...(definition.model ? { model: definition.model } : {}),
  }));
}

async function runLocalGuardrails(
  request: OrchestrationRunRequest,
  guardrails: LocalOrchestrationGuardrail[] | undefined,
): Promise<string | null> {
  for (const guardrail of guardrails ?? []) {
    const result = await guardrail(request);
    if (!result.allowed) return result.reason?.trim() || "request rejected";
  }
  return null;
}

export function buildCodexExecutionTool(options: BuildCodexExecutionToolOptions): Tool {
  const codexExecutor = options.codexExecutor ?? invokeCodexSdk;
  return tool({
    name: "codex_execute",
    description: "Run a full-capability Codex SDK engineering turn in the local workspace.",
    parameters: codexExecutionInput,
    strict: true,
    execute: async ({ prompt, taskType }) => {
      const result = await codexExecutor(
        options.agent,
        prompt,
        options.opts,
        options.startTime,
        taskType ?? options.defaultTaskType,
      );
      return stringifyToolResult(result);
    },
  });
}

export function createOpenAIAgentsOrchestrator(
  options: CreateOpenAIAgentsOrchestratorOptions = {},
): AgentOrchestrator {
  const handoffs = buildSpecialistAgents(options.specialists);

  return {
    async run(request: OrchestrationRunRequest): Promise<InvocationResult> {
      const blockedReason = await runLocalGuardrails(request, options.inputGuardrails);
      if (blockedReason) {
        return {
          response: `Blocked by orchestration guardrail: ${blockedReason}`,
          agent: request.agent.name,
          method: "api",
          task_type: request.taskType as InvocationTaskType,
          duration_ms: Date.now() - request.startTime,
        };
      }

      const manager = new Agent({
        name: "NyxHive Orchestrator",
        model: request.agent.model,
        instructions: buildManagerInstructions(request.agent),
        tools: [
          buildCodexExecutionTool({
            agent: request.agent,
            opts: request.opts,
            startTime: request.startTime,
            defaultTaskType: request.taskType,
            codexExecutor: options.codexExecutor,
          }),
        ],
        handoffs,
      });

      const result = await run(manager, request.message, {
        maxTurns: options.maxTurns ?? 6,
        signal: request.opts.signal,
        context: {
          agent: request.agent.name,
          agentKey: request.opts.agentKey,
          taskType: request.taskType,
          channel: request.opts.channel,
          senderName: request.opts.senderName,
        },
      });

      return {
        response: formatFinalOutput(result.finalOutput) || "Task completed",
        agent: request.agent.name,
        method: "api",
        task_type: request.taskType as InvocationTaskType,
        model: request.agent.model,
        duration_ms: Date.now() - request.startTime,
        toolsUsed: ["agents_sdk"],
        session_id: result.lastResponseId,
      };
    },
  };
}

export function isAgentsSdkOrchestrationEnabled(config: Pick<NyxHiveConfig, "orchestration"> | undefined): boolean {
  return config?.orchestration?.agents_sdk?.enabled === true;
}

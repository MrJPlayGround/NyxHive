import { invokeAgent, type CLIProgress, type InvokeOpts } from "../agents/invoke.js";
import type { AgentConfig, InvocationResult } from "../types.js";
import { nowKernelEvent, type KernelEvent } from "./events.js";
import type { AgentKernelRuntime, KernelRequest, KernelRuntimeDeps } from "./types.js";

export type ExistingAgentInvokeFn = (
  agent: AgentConfig,
  message: string,
  opts: InvokeOpts,
) => Promise<InvocationResult>;

export interface ExistingAgentRuntimeDeps extends KernelRuntimeDeps {
  invoke?: ExistingAgentInvokeFn;
}

type RuntimeQueueItem =
  | { kind: "event"; event: KernelEvent }
  | { kind: "done"; result: InvocationResult }
  | { kind: "error"; error: unknown };

class RuntimeEventQueue {
  private readonly items: RuntimeQueueItem[] = [];
  private resolveNext: ((item: RuntimeQueueItem) => void) | null = null;

  push(item: RuntimeQueueItem): void {
    if (this.resolveNext) {
      const resolve = this.resolveNext;
      this.resolveNext = null;
      resolve(item);
      return;
    }
    this.items.push(item);
  }

  next(): Promise<RuntimeQueueItem> {
    const item = this.items.shift();
    if (item) return Promise.resolve(item);
    return new Promise((resolve) => {
      this.resolveNext = resolve;
    });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function costToCents(cost: number | undefined): number | undefined {
  return cost === undefined ? undefined : Math.round(cost * 100);
}

function progressToKernelEvents(progress: CLIProgress): KernelEvent[] {
  const events: KernelEvent[] = [];
  if (progress.textDelta && progress.streamingSafe === true) {
    events.push(nowKernelEvent({
      type: "kernel:token",
      text: progress.textDelta,
      agent: progress.agent,
    }));
  }

  const execution = progress.executionEvent;
  if (execution?.phase === "started") {
    events.push(nowKernelEvent({
      type: "kernel:tool_start",
      tool: execution.title,
      input: execution.command ?? execution.details,
    }));
  } else if (execution?.phase === "completed" || execution?.phase === "failed") {
    events.push(nowKernelEvent({
      type: "kernel:tool_end",
      tool: execution.title,
      output: execution.outputPreview ?? execution.details ?? execution.exitCode,
    }));
  }

  return events;
}

function messageIdFromMetadata(metadata: Record<string, unknown> | undefined): string | undefined {
  const camel = metadata?.messageId;
  if (typeof camel === "string") return camel;
  const snake = metadata?.message_id;
  return typeof snake === "string" ? snake : undefined;
}

function invokeOptsFromMetadata(metadata: Record<string, unknown> | undefined): Partial<InvokeOpts> {
  const value = metadata?.invokeOpts;
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Partial<InvokeOpts>
    : {};
}

export class ExistingAgentRuntimeAdapter implements AgentKernelRuntime {
  private readonly invoke: ExistingAgentInvokeFn;

  constructor(private readonly deps: ExistingAgentRuntimeDeps) {
    this.invoke = deps.invoke ?? invokeAgent;
  }

  async *stream(request: KernelRequest): AsyncIterable<KernelEvent> {
    yield nowKernelEvent({
      type: "kernel:status",
      status: "running",
      message: request.message.slice(0, 120),
    });

    const queue = new RuntimeEventQueue();
    const messageId = messageIdFromMetadata(request.metadata);
    const baseInvokeOpts = invokeOptsFromMetadata(request.metadata);
    const upstreamOnProgress = baseInvokeOpts.onProgress;
    const opts: InvokeOpts = {
      ...baseInvokeOpts,
      baseDir: this.deps.baseDir,
      config: this.deps.config,
      agentKey: request.agentKey,
      channel: request.channel,
      senderName: request.sender,
      messageId,
      sessionId: request.conversationId,
      files: request.attachments,
      onProgress: (progress) => {
        for (const event of progressToKernelEvents(progress)) {
          queue.push({ kind: "event", event });
        }
        upstreamOnProgress?.(progress);
      },
    };

    void this.invoke(request.agent, request.message, opts)
      .then((result) => queue.push({ kind: "done", result }))
      .catch((error) => queue.push({ kind: "error", error }));

    while (true) {
      const item = await queue.next();
      if (item.kind === "event") {
        yield item.event;
        continue;
      }

      if (item.kind === "error") {
        yield nowKernelEvent({ type: "kernel:error", error: errorMessage(item.error) });
        throw item.error;
      }

      if (
        item.result.model !== undefined ||
        item.result.tokens_in !== undefined ||
        item.result.tokens_out !== undefined ||
        item.result.cost !== undefined
      ) {
        yield nowKernelEvent({
          type: "kernel:usage",
          model: item.result.model,
          input_tokens: item.result.tokens_in,
          output_tokens: item.result.tokens_out,
          cost_cents: costToCents(item.result.cost),
        });
      }

      yield nowKernelEvent({
        type: "kernel:response",
        response: item.result.response,
        agent: item.result.agent,
        message_id: messageId,
        cost_cents: costToCents(item.result.cost),
      });
      return;
    }
  }
}

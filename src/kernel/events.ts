export type KernelEvent =
  | {
      type: "kernel:status";
      status: "queued" | "running" | "completed" | "failed";
      message?: string;
      timestamp: number;
    }
  | { type: "kernel:token"; text: string; agent?: string; timestamp: number }
  | { type: "kernel:tool_start"; tool: string; input?: unknown; timestamp: number }
  | { type: "kernel:tool_end"; tool: string; output?: unknown; timestamp: number }
  | {
      type: "kernel:usage";
      model?: string;
      input_tokens?: number;
      output_tokens?: number;
      cost_cents?: number;
      timestamp: number;
    }
  | {
      type: "kernel:response";
      response: string;
      agent?: string;
      message_id?: string;
      cost_cents?: number;
      timestamp: number;
    }
  | { type: "kernel:error"; error: string; timestamp: number };

export function nowKernelEvent<T extends Omit<KernelEvent, "timestamp">>(event: T): T & { timestamp: number } {
  return { ...event, timestamp: Date.now() };
}

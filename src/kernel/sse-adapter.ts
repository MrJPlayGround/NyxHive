import type { SSEEvent } from "../types.js";
import type { KernelEvent } from "./events.js";

function compactData(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined));
}

export function kernelEventToSSE(event: KernelEvent): SSEEvent {
  switch (event.type) {
    case "kernel:status":
      return {
        type: "agent:status",
        data: compactData({ status: event.status, task: event.message }),
        timestamp: event.timestamp,
      };
    case "kernel:token":
      return {
        type: "token",
        data: compactData({ text: event.text, agent: event.agent }),
        timestamp: event.timestamp,
      };
    case "kernel:tool_start":
      return {
        type: "tool:start",
        data: compactData({ tool: event.tool, input: event.input }),
        timestamp: event.timestamp,
      };
    case "kernel:tool_end":
      return {
        type: "trace:tool_use",
        data: compactData({ tool: event.tool, result: event.output }),
        timestamp: event.timestamp,
      };
    case "kernel:usage":
      return {
        type: "usage",
        data: compactData({
          model: event.model,
          input_tokens: event.input_tokens,
          output_tokens: event.output_tokens,
          cost_cents: event.cost_cents,
        }),
        timestamp: event.timestamp,
      };
    case "kernel:response":
      return {
        type: "response",
        data: compactData({
          response: event.response,
          agent: event.agent,
          message_id: event.message_id,
          cost_cents: event.cost_cents,
        }),
        timestamp: event.timestamp,
      };
    case "kernel:error":
      return {
        type: "error",
        data: { error: event.error },
        timestamp: event.timestamp,
      };
  }
}

import { describe, expect, test } from "bun:test";
import { ExistingAgentRuntimeAdapter } from "../kernel/runtime.js";
import type { KernelEvent } from "../kernel/events.js";
import type { AgentConfig, InvocationResult } from "../types.js";
import type { InvokeOpts } from "../agents/invoke.js";

const agent: AgentConfig = {
  name: "Nyx",
  provider: "openai",
  model: "gpt-5.4",
  working_directory: "/tmp",
};

function result(overrides: Partial<InvocationResult> = {}): InvocationResult {
  return {
    response: "finished",
    agent: "Nyx",
    method: "cli",
    duration_ms: 42,
    ...overrides,
  };
}

describe("ExistingAgentRuntimeAdapter", () => {
  test("emits status before invoking and response after completion", async () => {
    const seen: string[] = [];
    const runtime = new ExistingAgentRuntimeAdapter({
      baseDir: "/tmp",
      invoke: async (_agent: AgentConfig, message: string) => {
        seen.push(message);
        return result({ response: "hello back", model: "gpt-5.4", tokens_in: 10, tokens_out: 4, cost: 0.02 });
      },
    });

    const events = await Array.fromAsync(runtime.stream({ message: "hello", agentKey: "nyx", agent }));

    expect(seen).toEqual(["hello"]);
    expect(events[0]).toMatchObject({ type: "kernel:status", status: "running" });
    expect(events.at(-1)).toMatchObject({ type: "kernel:response", response: "hello back", agent: "Nyx" });
    expect(events).toContainEqual(expect.objectContaining({
      type: "kernel:usage",
      model: "gpt-5.4",
      input_tokens: 10,
      output_tokens: 4,
      cost_cents: 2,
    }));
  });

  test("translates safe progress deltas into token events", async () => {
    const runtime = new ExistingAgentRuntimeAdapter({
      baseDir: "/tmp",
      invoke: async (_agent: AgentConfig, _message: string, opts: InvokeOpts) => {
        opts.onProgress?.({
          turns: 1,
          tokensIn: 3,
          tokensOut: 1,
          elapsed: 1,
          textDelta: "hi",
          streamingSafe: true,
          phase: "responding",
          agent: "Nyx",
        });
        return result();
      },
    });

    const events = await Array.fromAsync(runtime.stream({ message: "hello", agentKey: "nyx", agent }));

    expect(events).toContainEqual(expect.objectContaining({ type: "kernel:token", text: "hi", agent: "Nyx" }));
  });

  test("emits kernel error before rethrowing invoke failures", async () => {
    const runtime = new ExistingAgentRuntimeAdapter({
      baseDir: "/tmp",
      invoke: async () => {
        throw new Error("provider down");
      },
    });

    const events: KernelEvent[] = [];
    await expect(async () => {
      for await (const event of runtime.stream({ message: "hello", agentKey: "nyx", agent })) {
        events.push(event);
      }
    }).toThrow("provider down");

    expect(events).toContainEqual(expect.objectContaining({ type: "kernel:error", error: "provider down" }));
  });
});

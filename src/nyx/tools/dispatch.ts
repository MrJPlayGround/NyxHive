import { z } from "zod";
import { registerTool } from "../lib/tool-registry.js";
import { getInstance, defaultInstance } from "../lib/config.js";
import { streamSSE } from "../lib/stream.js";

registerTool({
  name: "dispatch",
  description: "Send a task to a NyxHive instance and return the result",
  schema: z.object({
    task: z.string().min(1),
    instance: z.string().optional(),
    agent: z.string().optional(),
    wait: z.boolean().optional().default(true),
    timeout: z.number().int().positive().optional().default(120_000),
  }),
  gate: "none",
  render: ({ task, instance }) =>
    `${instance ?? "default"}: ${task.slice(0, 60)}`,
  execute: async ({ task, instance: instName, agent, wait, timeout }, ctx) => {
    const inst = instName
      ? await getInstance(instName)
      : await defaultInstance();

    if (!inst) {
      return { ok: false, error: "No instance found" };
    }

    const host = inst.host ?? `http://localhost:${inst.port}`;
    const apiKey = inst.apiKey ?? "";

    if (!wait) {
      // Fire-and-forget
      const res = await fetch(`${host}/api/message`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ message: task, agent, async: true }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        return { ok: false, error: `HTTP ${res.status}` };
      }
      const data = (await res.json()) as { message_id?: string };
      return { ok: true, output: data.message_id ?? "dispatched" };
    }

    // Stream and collect response
    const signal = ctx?.signal ?? AbortSignal.timeout(timeout);
    const payload: Record<string, unknown> = {
      message: task,
      stream: true,
      sender: "nyx-tool-dispatch",
    };
    if (agent) payload.agent = agent;

    let response = "";
    try {
      for await (const event of streamSSE(`${host}/api/message`, apiKey, payload, signal)) {
        if (event.type === "response") {
          response = (event.response as string | undefined) ?? "";
          break;
        }
        if (event.type === "error") {
          return { ok: false, error: String(event.error ?? "stream error") };
        }
      }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }

    return { ok: true, output: response || "(no response)" };
  },
});

import { defineCommand } from "citty";
import { appendFileSync } from "node:fs";
import pc from "picocolors";
import { getInstance } from "../lib/config.js";
import { api } from "../lib/api.js";
import { duration } from "../lib/format.js";
import { loadTasks, saveTasks, updateDelegation } from "../lib/tasks.js";
import { buildProviderFromConfig } from "../lib/providers.js";
import {
  NyxSpinner,
  renderStatusBar,
  type StatusBarData,
} from "../lib/skin.js";
import {
  handleChatStreamEvent,
  type ChatStreamRenderState,
} from "./chat.js";
import {
  createRun,
  updateRun,
  appendOutput,
} from "../lib/run-store.js";

interface EnqueueResponse {
  message_id: string;
  status: string;
}

export default defineCommand({
  meta: { name: "dispatch", description: "Send a task to an instance" },
  args: {
    instance:    { type: "positional", required: true,  description: "Target instance" },
    task:        { type: "positional", required: true,  description: "Task message" },
    wait:        { type: "boolean",                     description: "Stream until completion" },
    background:  { type: "boolean",                     description: "Async enqueue with disk-backed output (no wait)" },
    taskId:      { type: "string",                      description: "Task ID for tracking" },
    agent:       { type: "string",                      description: "Target agent" },
    mode:        { type: "string",                      description: "Execution mode (default, ralph)" },
    provider:    { type: "string",                      description: "LLM provider override (nyxhive | anthropic | ollama)" },
  },
  async run({ args }) {
    const inst = await getInstance(args.instance);
    if (!inst) {
      console.log(pc.red(`Instance "${args.instance}" not found`));
      return;
    }

    // ── Background: async enqueue + local run record ───────────────────────────
    if (args.background) {
      const body: Record<string, unknown> = {
        message: args.task,
        async: true,
        sender: "nyx-cli",
        sender_id: "nyx-cli",
      };
      if (args.agent) body.agent = args.agent;
      if (args.mode) body.mode = args.mode;

      const result = await api<EnqueueResponse>(inst, "/api/message", {
        method: "POST",
        body,
        timeout: 15_000,
      });

      const run = await createRun("background", {
        type: "background",
        status: "pending",
        title: args.task.slice(0, 80),
        instance: args.instance.toLowerCase(),
        agent: args.agent ?? inst.name.toLowerCase(),
        message_id: result.message_id,
      });

      await appendOutput(run.run_id, `[dispatched] ${new Date().toISOString()}\n`);
      await appendOutput(run.run_id, `[instance] ${args.instance}\n`);
      await appendOutput(run.run_id, `[message_id] ${result.message_id}\n`);
      await appendOutput(run.run_id, `[task] ${args.task}\n\n`);

      console.log(`  ${pc.green("✓")} Background run started`);
      console.log(`  ${pc.dim("run_id:")}     ${run.run_id.slice(0, 16)}`);
      console.log(`  ${pc.dim("message_id:")} ${result.message_id.slice(0, 8)}`);
      console.log(`  ${pc.dim("follow:")}     nyx run local status ${run.run_id.slice(0, 16)}`);
      return;
    }

    // ── No-wait: async enqueue and return immediately ──────────────────────────
    if (!args.wait) {
      const body: Record<string, unknown> = {
        message: args.task,
        async: true,
        sender: "nyx-cli",
        sender_id: "nyx-cli",
      };
      if (args.agent) body.agent = args.agent;
      if (args.mode) body.mode = args.mode;

      const result = await api<EnqueueResponse>(inst, "/api/message", {
        method: "POST",
        body,
        timeout: 15_000,
      });

      const msgId = result.message_id;

      if (args.taskId) {
        try {
          const tasks = await loadTasks();
          const task = tasks.tasks.find((t) => t.task_id === args.taskId);
          if (task) {
            task.delegations.push({
              instance: args.instance.toLowerCase(),
              message_id: msgId,
              run_id: null,
              agent: args.agent ?? inst.name.toLowerCase(),
              status: "enqueued",
              dispatched_at: Date.now(),
              completed_at: null,
              result_summary: "",
            });
            await saveTasks(tasks);
          }
        } catch {
          // Non-fatal
        }
      }

      console.log(`  ${pc.green("✓")} Dispatched to ${inst.name} [msg: ${msgId.slice(0, 8)}]`);
      console.log(`  Track:     nyx run poll ${inst.name.toLowerCase()} ${msgId}`);
      return;
    }

    // ── Wait: stream until completion with disk-backed output ──────────────────
    const run = await createRun("remote-agent", {
      type: "remote-agent",
      status: "running",
      title: args.task.slice(0, 80),
      instance: args.instance.toLowerCase(),
      agent: args.agent ?? inst.name.toLowerCase(),
    });

    const provider = await buildProviderFromConfig(args.provider, inst);

    const spinner = new NyxSpinner();
    spinner.start();
    const turnStart = Date.now();

    const statusData: StatusBarData = {};
    const streamState: ChatStreamRenderState = {
      agentName: inst.name,
      responded: false,
      streamingTextStarted: false,
      responseFrameOpen: false,
    };

    let finalMessageId: string | null = null;
    let finalResponse: string | null = null;
    let finalAgent: string = inst.name;

    // Intercept writeStdout/writeLine to mirror output to disk
    const writeStdout = (text: string) => {
      process.stdout.write(text);
      appendOutput(run.run_id, text).catch(() => {});
    };
    const writeLine = (text = "") => {
      console.log(text);
      appendOutput(run.run_id, text + "\n").catch(() => {});
    };

    try {
      for await (const event of provider.stream(args.task, {
        agent: args.agent,
        mode: args.mode,
        sender: "nyx-cli",
      })) {
        if (process.env.NYX_DEBUG) appendFileSync("/tmp/nyx-events.log", JSON.stringify(event) + "\n");

        handleChatStreamEvent(event, {
          spinner,
          statusData,
          state: streamState,
          instName: inst.name,
          sessionMode: false,
          turnStart,
          addCostCents: () => {},
          writeStdout,
          writeLine,
        });

        if (event.type === "response") {
          finalMessageId = (event.message_id as string | undefined) ?? null;
          finalResponse = (event.response as string | undefined) ?? null;
          finalAgent = (event.agent as string | undefined) ?? inst.name;
        }
      }
    } catch (err) {
      spinner.stop(false);
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`\n  ${pc.red("✕")} ${pc.dim(msg)}\n`);
      await updateRun(run.run_id, { status: "failed", error: msg, finished_at: Date.now() });
      return;
    }

    if (!streamState.responded) {
      spinner.stop(false);
      console.log(`\n  ${pc.red("✕")} ${pc.dim("No response received.")}\n`);
      await updateRun(run.run_id, { status: "failed", error: "No response received", finished_at: Date.now() });
      return;
    }

    const elapsed = duration(Date.now() - turnStart);
    const bar = renderStatusBar(statusData);
    if (!streamState.streamingTextStarted) {
      spinner.stop();
      const w = Math.min(process.stdout.columns || 80, 120);
      const mark = pc.dim("◆");
      const label = pc.bold(pc.cyan(finalAgent.toLowerCase()));
      const dashes = pc.dim("─".repeat(Math.max(4, w - 2 - finalAgent.length - 1)));
      console.log(`\n${mark} ${label} ${dashes}`);
      if (finalResponse) console.log(finalResponse);
      if (bar) console.log(bar);
      console.log();
    }

    console.log(`  ${pc.green("✓")} [${elapsed}] ${finalAgent}`);

    await updateRun(run.run_id, {
      status: "completed",
      finished_at: Date.now(),
      message_id: finalMessageId ?? undefined,
      agent: finalAgent,
    });

    // Task tracking — single write at completion
    if (args.taskId && finalMessageId) {
      try {
        const tasks = await loadTasks();
        const task = tasks.tasks.find((t) => t.task_id === args.taskId);
        if (task) {
          const existing = task.delegations.find((d) => d.message_id === finalMessageId);
          if (existing) {
            updateDelegation(tasks, args.taskId, finalMessageId, {
              status: "completed",
              completed_at: Date.now(),
              result_summary: (finalResponse ?? "").slice(0, 500),
            });
          } else {
            task.delegations.push({
              instance: args.instance.toLowerCase(),
              message_id: finalMessageId,
              run_id: run.run_id,
              agent: finalAgent,
              status: "completed",
              dispatched_at: turnStart,
              completed_at: Date.now(),
              result_summary: (finalResponse ?? "").slice(0, 500),
            });
          }
          await saveTasks(tasks);
        }
      } catch {
        // Non-fatal
      }
    }
  },
});

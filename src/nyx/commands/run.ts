import { defineCommand } from "citty";
import { spinner } from "@clack/prompts";
import pc from "picocolors";
import { getInstance } from "../lib/config.js";
import { api } from "../lib/api.js";
import { table, duration, cost, time, col } from "../lib/format.js";
import { humanStatusFromActivity } from "../../channels/tool-activity.js";
import {
  listLocalRuns,
  loadRun,
  readOutput,
  outputSize,
  updateRun,
  type LocalRun,
} from "../lib/run-store.js";

interface DelegationRun {
  run_id: string;
  agent: string;
  status: string;
  mode: string;
  result?: {
    outcome?: string;
    summary?: string;
    files_touched?: string[];
  } | null;
  usage?: {
    tokens_in?: number;
    tokens_out?: number;
    cost_usd?: number;
    duration_ms?: number;
  } | null;
  task_description?: string;
  created_at: number;
  completed_at: number | null;
}

interface MessageResponse {
  message_id: string;
  status: string;
  response?: string;
  agent?: string;
  activity?: string;
  progress_text?: string;
  error?: string;
}

const list = defineCommand({
  meta: { name: "list", description: "List recent runs" },
  args: {
    instance: { type: "positional", required: true, description: "Instance name" },
    limit: { type: "string", description: "Max results", default: "10" },
  },
  async run({ args }) {
    const inst = await getInstance(args.instance);
    if (!inst) {
      console.log(pc.red(`Instance "${args.instance}" not found`));
      return;
    }

    const runs = await api<DelegationRun[]>(inst, `/api/runs?limit=${args.limit}`);

    if (runs.length === 0) {
      console.log("  No runs found");
      return;
    }

    const headers = [
      { label: "Run ID", width: 12 },
      { label: "Agent", width: 10 },
      { label: "Status", width: 12 },
      { label: "Duration", width: 10 },
      { label: "Cost", width: 8 },
      { label: "Started", width: 8 },
    ];

    const rows = runs.map((r) => {
      const dur = r.usage?.duration_ms
        ? duration(r.usage.duration_ms)
        : r.completed_at
          ? duration(r.completed_at - r.created_at)
          : "—";
      return [
        r.run_id.slice(0, 10),
        r.agent,
        r.status,
        dur,
        cost(r.usage?.cost_usd),
        time(r.created_at),
      ];
    });

    console.log(table(headers, rows));
  },
});

const show = defineCommand({
  meta: { name: "show", description: "Show run details" },
  args: {
    instance: { type: "positional", required: true, description: "Instance name" },
    runId: { type: "positional", required: true, description: "Run ID" },
  },
  async run({ args }) {
    const inst = await getInstance(args.instance);
    if (!inst) {
      console.log(pc.red(`Instance "${args.instance}" not found`));
      return;
    }

    const run = await api<DelegationRun>(inst, `/api/runs/${args.runId}`);

    console.log(`  ${pc.bold("Run")}:      ${run.run_id}`);
    console.log(`  ${pc.bold("Agent")}:    ${run.agent}`);
    console.log(`  ${pc.bold("Status")}:   ${run.status}`);
    console.log(`  ${pc.bold("Mode")}:     ${run.mode}`);
    if (run.task_description) {
      const desc = run.task_description.length > 100
        ? run.task_description.slice(0, 100) + "…"
        : run.task_description;
      console.log(`  ${pc.bold("Task")}:     ${desc}`);
    }
    if (run.usage) {
      if (run.usage.duration_ms) console.log(`  ${pc.bold("Duration")}: ${duration(run.usage.duration_ms)}`);
      if (run.usage.cost_usd) console.log(`  ${pc.bold("Cost")}:     ${cost(run.usage.cost_usd)}`);
      if (run.usage.tokens_in) console.log(`  ${pc.bold("Tokens")}:   ${run.usage.tokens_in} in / ${run.usage.tokens_out ?? 0} out`);
    }
    if (run.result) {
      if (run.result.outcome) console.log(`  ${pc.bold("Outcome")}:  ${run.result.outcome}`);
      if (run.result.summary) {
        console.log(`\n  ${pc.bold("Summary")}:`);
        console.log(`  ${run.result.summary}`);
      }
      if (run.result.files_touched?.length) {
        console.log(`\n  ${pc.bold("Files")} (${run.result.files_touched.length}):`);
        for (const f of run.result.files_touched.slice(0, 20)) {
          console.log(`    ${f}`);
        }
      }
    }
  },
});

const poll = defineCommand({
  meta: { name: "poll", description: "Poll a message until completion" },
  args: {
    instance: { type: "positional", required: true, description: "Instance name" },
    msgId: { type: "positional", required: true, description: "Message ID" },
  },
  async run({ args }) {
    const inst = await getInstance(args.instance);
    if (!inst) {
      console.log(pc.red(`Instance "${args.instance}" not found`));
      return;
    }

    const s = spinner();
    s.start("Connecting...");
    const startTime = Date.now();

    while (true) {
      await new Promise((r) => setTimeout(r, 3_000));
      const elapsed = duration(Date.now() - startTime);

      try {
        const msg = await api<MessageResponse>(inst, `/api/message/${args.msgId}`, { timeout: 5_000 });

        if (msg.status === "completed" || msg.response) {
          s.stop(`${pc.green("✓")} [${elapsed}] Complete — ${msg.agent ?? "agent"}`);
          if (msg.response) {
            const resp = msg.response;
            if (resp.length > 2000) {
              console.log(`\n${resp.slice(0, 2000)}\n  ${pc.dim(`... (${resp.length} chars total)`)}`);
            } else {
              console.log(`\n${resp}`);
            }
          }
          return;
        }

        if (msg.status === "failed" || msg.status === "dead_letter") {
          s.stop(pc.red(`✕ Failed — ${msg.error ?? "unknown error"}`));
          process.exit(1);
        }

        const activity = humanStatusFromActivity(msg.progress_text ?? msg.activity);
        s.message(`[${elapsed}] ${activity}`);
      } catch {
        s.message(`[${elapsed}] Nyx is working...`);
      }
    }
  },
});

// ─── Local run subcommands ────────────────────────────────────────────────────

function statusColor(status: string): string {
  switch (status) {
    case "completed": return pc.green(status);
    case "failed":    return pc.red(status);
    case "running":   return pc.cyan(status);
    default:          return pc.dim(status);
  }
}

const localList = defineCommand({
  meta: { name: "list", description: "List local runs" },
  args: {
    limit: { type: "string", description: "Max results", default: "20" },
  },
  async run({ args }) {
    const runs = await listLocalRuns(Number(args.limit) || 20);
    if (runs.length === 0) {
      console.log("  No local runs found");
      return;
    }
    const headers = [
      { label: "Run ID", width: 18 },
      { label: "Type", width: 14 },
      { label: "Status", width: 11 },
      { label: "Agent", width: 10 },
      { label: "Title", width: 40 },
      { label: "Started", width: 8 },
    ];
    const rows = runs.map((r) => [
      r.run_id.slice(0, 16),
      r.type,
      r.status,
      r.agent ?? "—",
      r.title.slice(0, 38),
      time(r.started_at),
    ]);
    console.log(table(headers, rows));
  },
});

const localTail = defineCommand({
  meta: { name: "tail", description: "Tail output of a local run" },
  args: {
    runId: { type: "positional", required: true, description: "Run ID prefix" },
    follow: { type: "boolean", description: "Follow (poll for new output)" },
  },
  async run({ args }) {
    // Support prefix match
    const all = await listLocalRuns(200);
    const run = all.find((r) => r.run_id.startsWith(args.runId));
    if (!run) {
      console.log(pc.red(`No local run matching "${args.runId}"`));
      return;
    }

    const out = await readOutput(run.run_id);
    if (out) process.stdout.write(out);

    if (!args.follow || run.status === "completed" || run.status === "failed") return;

    // Follow: poll for new output every 2s
    let offset = (await outputSize(run.run_id));
    while (true) {
      await new Promise((r) => setTimeout(r, 2_000));
      const current = await outputSize(run.run_id);
      if (current > offset) {
        const full = await readOutput(run.run_id);
        process.stdout.write(full.slice(offset));
        offset = current;
      }
      const updated = await loadRun(run.run_id);
      if (!updated || updated.status === "completed" || updated.status === "failed") break;
    }
  },
});

const localStatus = defineCommand({
  meta: { name: "status", description: "Show status of a local run" },
  args: {
    runId: { type: "positional", required: true, description: "Run ID prefix" },
    instance: { type: "string", description: "Instance to check (for background runs)" },
  },
  async run({ args }) {
    const all = await listLocalRuns(200);
    const run = all.find((r) => r.run_id.startsWith(args.runId));
    if (!run) {
      console.log(pc.red(`No local run matching "${args.runId}"`));
      return;
    }

    console.log();
    console.log(`  ${pc.bold("run_id:")}     ${run.run_id}`);
    console.log(`  ${pc.bold("type:")}       ${run.type}`);
    console.log(`  ${pc.bold("status:")}     ${statusColor(run.status)}`);
    if (run.instance) console.log(`  ${pc.bold("instance:")}   ${run.instance}`);
    if (run.agent)    console.log(`  ${pc.bold("agent:")}      ${run.agent}`);
    if (run.message_id) console.log(`  ${pc.bold("message_id:")} ${run.message_id}`);
    console.log(`  ${pc.bold("started:")}    ${time(run.started_at)}`);
    if (run.finished_at) {
      console.log(`  ${pc.bold("finished:")}   ${time(run.finished_at)}  (${duration(run.finished_at - run.started_at)})`);
    }
    if (run.error) console.log(`  ${pc.bold("error:")}      ${pc.red(run.error)}`);
    console.log(`  ${pc.bold("title:")}      ${run.title}`);

    // For background runs, optionally check server-side status
    if (run.type === "background" && run.status === "pending" && run.message_id) {
      const instName = args.instance ?? run.instance;
      if (instName) {
        try {
          const inst = await getInstance(instName);
          if (inst) {
            const serverRuns = await api<{ id: string; status: string; outcome?: string; summary?: string }[]>(
              inst,
              `/api/runs?message_id=${run.message_id}`,
              { timeout: 5_000 },
            );
            if (serverRuns.length > 0) {
              const sr = serverRuns[0];
              console.log();
              console.log(`  ${pc.dim("server:")}     status=${sr.status}${sr.outcome ? " outcome=" + sr.outcome : ""}`);
              if (sr.status === "completed" || sr.status === "failed") {
                await updateRun(run.run_id, {
                  status: sr.status === "completed" ? "completed" : "failed",
                  finished_at: Date.now(),
                });
              }
            }
          }
        } catch {
          // Non-fatal — offline or not configured
        }
      }
    }
    console.log();
  },
});

const local = defineCommand({
  meta: { name: "local", description: "Manage local runs" },
  subCommands: { list: localList, tail: localTail, status: localStatus },
});

export default defineCommand({
  meta: { name: "run", description: "Manage delegation runs" },
  subCommands: { list, show, poll, local },
});

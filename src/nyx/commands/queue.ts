import { defineCommand } from "citty";
import pc from "picocolors";
import { loadInstances, getInstance } from "../lib/config.js";
import { api } from "../lib/api.js";
import { table } from "../lib/format.js";

interface QueueHealth {
  queueDepth: number;
  processing: number;
  deadLetters: number;
}

export default defineCommand({
  meta: { name: "queue", description: "Show queue status" },
  args: {
    all: { type: "boolean", description: "Show all instances" },
    instance: { type: "positional", required: false, description: "Instance name" },
  },
  subCommands: {
    "clear-dead": defineCommand({
      meta: { name: "clear-dead", description: "Clear dead letters" },
      args: {
        all: { type: "boolean", description: "Clear all instances" },
        instance: { type: "positional", required: false, description: "Instance name" },
      },
      async run({ args }) {
        const targets = args.all
          ? await loadInstances()
          : args.instance
            ? [await getInstance(args.instance)].filter(Boolean) as Awaited<ReturnType<typeof loadInstances>>
            : [];

        if (targets.length === 0) {
          console.log("Specify an instance name or use --all");
          return;
        }

        for (const inst of targets) {
          try {
            const result = await api<{ cleared: number }>(inst, "/api/queue/dead-letters", {
              method: "DELETE",
            });
            console.log(`  ${pc.green("✓")} ${inst.name}: cleared ${result.cleared} dead letter(s)`);
          } catch (err) {
            console.log(`  ${pc.red("✕")} ${inst.name}: ${err instanceof Error ? err.message : "failed"}`);
          }
        }
      },
    }),
  },
  async run({ args }) {
    const instances = args.instance
      ? [await getInstance(args.instance)].filter(Boolean) as Awaited<ReturnType<typeof loadInstances>>
      : await loadInstances();

    if (instances.length === 0) {
      console.log("No instances found");
      return;
    }

    const results = await Promise.all(
      instances.map(async (inst) => {
        try {
          const health = await api<QueueHealth>(inst, "/api/queue/health", { timeout: 3_000 });
          return {
            name: inst.name,
            pending: health.queueDepth,
            processing: health.processing,
            dead: health.deadLetters,
          };
        } catch {
          return { name: inst.name, pending: -1, processing: -1, dead: -1 };
        }
      }),
    );

    const headers = [
      { label: "Instance", width: 12 },
      { label: "Pending", width: 10 },
      { label: "Processing", width: 12 },
      { label: "Dead Letters", width: 14 },
    ];

    const rows = results.map((r) => [
      r.name,
      r.pending < 0 ? pc.red("err") : String(r.pending),
      r.processing < 0 ? pc.red("err") : String(r.processing),
      r.dead < 0 ? pc.red("err") : r.dead > 0 ? pc.red(String(r.dead)) : pc.green(String(r.dead)),
    ]);

    console.log(table(headers, rows));
  },
});

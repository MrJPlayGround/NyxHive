import { defineCommand } from "citty";
import pc from "picocolors";
import { loadInstances } from "../lib/config.js";
import { api, ping } from "../lib/api.js";
import { table, col, hr, cost, statusDot } from "../lib/format.js";

interface QueueHealth {
  queueDepth: number;
  processing: number;
  deadLetters: number;
}

export default defineCommand({
  meta: { name: "fleet", description: "Show fleet status" },
  args: {
    json: { type: "boolean", description: "Output raw JSON" },
  },
  async run({ args }) {
    const instances = await loadInstances();
    if (instances.length === 0) {
      console.log("No instances found in ~/.nyxhive/instances/");
      return;
    }

    const results = await Promise.all(
      instances.map(async (inst) => {
        try {
          const health = await api<QueueHealth>(inst, "/api/queue/health", { timeout: 3_000 });
          return {
            name: inst.name,
            port: inst.port,
            status: "running" as const,
            pending: health.queueDepth,
            processing: health.processing,
            dead: health.deadLetters,
          };
        } catch {
          return {
            name: inst.name,
            port: inst.port,
            status: "down" as const,
            pending: 0,
            processing: 0,
            dead: 0,
          };
        }
      }),
    );

    if (args.json) {
      console.log(JSON.stringify(results, null, 2));
      return;
    }

    const headers = [
      { label: "Instance", width: 12 },
      { label: "Port", width: 6 },
      { label: "Status", width: 12 },
      { label: "Pending", width: 9 },
      { label: "Processing", width: 12 },
      { label: "Dead", width: 6 },
    ];

    const rows = results.map((r) => [
      r.name,
      String(r.port),
      `${statusDot(r.status)} ${r.status}`,
      String(r.pending),
      String(r.processing),
      String(r.dead),
    ]);

    console.log(table(headers, rows));

    const running = results.filter((r) => r.status === "running").length;
    console.log(`\n  Total: ${running}/${results.length} instances running`);
  },
});

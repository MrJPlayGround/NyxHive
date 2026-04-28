import { defineCommand } from "citty";
import pc from "picocolors";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { loadInstances, isRemoteMode } from "../lib/config.js";
import { table, cost } from "../lib/format.js";
import { homedir } from "node:os";

interface CostRow {
  cost_usd: number;
}

function queryCost(dbPath: string, sinceMs: number): number {
  if (!existsSync(dbPath)) return 0;
  try {
    const db = new Database(dbPath, { readonly: true });
    const rows = db.query(
      `SELECT json_extract(usage_json, '$.cost_usd') as cost_usd
       FROM delegation_runs
       WHERE created_at >= ? AND usage_json IS NOT NULL`,
    ).all(sinceMs) as CostRow[];
    db.close();
    return rows.reduce((sum, r) => sum + (r.cost_usd ?? 0), 0);
  } catch {
    return 0;
  }
}

export default defineCommand({
  meta: { name: "cost", description: "Show cost summary" },
  args: {
    today: { type: "boolean", description: "Show today only" },
    month: { type: "boolean", description: "Show this month" },
    instance: { type: "positional", required: false, description: "Instance name" },
  },
  async run({ args }) {
    if (isRemoteMode()) {
      console.log(
        "Cost data requires local SQLite access. Run nyx cost on the NyxHive machine, or use nyx fleet for basic stats.",
      );
      return;
    }
    const instances = await loadInstances();
    const targets = args.instance
      ? instances.filter((i) => i.name.toLowerCase() === (args.instance as string).toLowerCase())
      : instances;

    if (targets.length === 0) {
      console.log("No instances found");
      return;
    }

    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();

    const results = targets.map((inst) => {
      const dataDir = join(homedir(), ".nyxhive", "instances", inst.name, "data");
      const dbPath = join(dataDir, `${inst.name}.db`);
      return {
        name: inst.name,
        today: queryCost(dbPath, todayStart),
        month: queryCost(dbPath, monthStart),
      };
    });

    const headers = [
      { label: "Instance", width: 12 },
      { label: "Today", width: 10 },
      { label: "This Month", width: 12 },
    ];

    const rows = results.map((r) => [
      r.name,
      cost(r.today),
      cost(r.month),
    ]);

    console.log(table(headers, rows));

    const totalToday = results.reduce((s, r) => s + r.today, 0);
    const totalMonth = results.reduce((s, r) => s + r.month, 0);
    console.log(`\n  Total      ${cost(totalToday).padStart(10)}  ${cost(totalMonth)}`);
  },
});

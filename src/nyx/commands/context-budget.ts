import { defineCommand } from "citty";
import pc from "picocolors";
import { analyzeContextBudget, formatContextBudgetReport } from "../../context-budget/audit.js";

export default defineCommand({
  meta: { name: "context-budget", description: "Audit prompt, skill, and tool context overhead" },
  args: {
    root: { type: "positional", required: false, description: "Repository root (defaults to cwd)" },
    verbose: { type: "boolean", alias: "v", description: "Show heaviest items per component" },
    json: { type: "boolean", description: "Print JSON instead of text" },
  },
  async run({ args }) {
    const root = typeof args.root === "string" && args.root.trim() ? args.root : process.cwd();
    const report = analyzeContextBudget(root);

    if (args.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    const rendered = formatContextBudgetReport(report, { verbose: Boolean(args.verbose) });
    if (report.issues.some((issue) => issue.severity === "high")) {
      console.log(pc.red(rendered));
    } else if (report.issues.length > 0) {
      console.log(pc.yellow(rendered));
    } else {
      console.log(pc.green(rendered));
    }
  },
});

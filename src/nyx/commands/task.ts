import { defineCommand } from "citty";
import pc from "picocolors";
import { loadTasks, type Task } from "../lib/tasks.js";
import { table, duration } from "../lib/format.js";

function priorityColor(p: string): string {
  switch (p) {
    case "critical": return pc.red(p);
    case "high": return pc.yellow(p);
    case "medium": return pc.cyan(p);
    case "low": return pc.dim(p);
    default: return p;
  }
}

function statusColor(s: string): string {
  switch (s) {
    case "done": return pc.green(s);
    case "dispatched":
    case "in_progress": return pc.yellow(s);
    case "blocked": return pc.red(s);
    default: return s;
  }
}

const list = defineCommand({
  meta: { name: "list", description: "List active tasks" },
  args: {
    all: { type: "boolean", description: "Include archived tasks" },
  },
  async run({ args }) {
    const data = await loadTasks();
    const tasks = args.all ? [...data.tasks, ...data.archive] : data.tasks;

    if (tasks.length === 0) {
      console.log("  No tasks");
      return;
    }

    const headers = [
      { label: "ID", width: 28 },
      { label: "Title", width: 40 },
      { label: "Status", width: 14 },
      { label: "Priority", width: 10 },
    ];

    const rows = tasks.map((t) => [
      t.task_id,
      t.title,
      statusColor(t.status),
      priorityColor(t.priority),
    ]);

    console.log(table(headers, rows));
  },
});

const show = defineCommand({
  meta: { name: "show", description: "Show task details" },
  args: {
    id: { type: "positional", required: true, description: "Task ID" },
  },
  async run({ args }) {
    const data = await loadTasks();
    const task = [...data.tasks, ...data.archive].find(
      (t) => t.task_id === args.id || t.task_id.startsWith(args.id),
    );

    if (!task) {
      console.log(pc.red(`Task "${args.id}" not found`));
      return;
    }

    console.log(`  ${pc.bold("ID")}:         ${task.task_id}`);
    console.log(`  ${pc.bold("Title")}:      ${task.title}`);
    console.log(`  ${pc.bold("Status")}:     ${statusColor(task.status)}`);
    console.log(`  ${pc.bold("Priority")}:   ${priorityColor(task.priority)}`);
    if (task.description) {
      console.log(`  ${pc.bold("Description")}:`);
      console.log(`    ${task.description}`);
    }
    if (task.tags?.length) {
      console.log(`  ${pc.bold("Tags")}:       ${task.tags.join(", ")}`);
    }
    if (task.blockers?.length) {
      console.log(`  ${pc.bold("Blockers")}:   ${task.blockers.join(", ")}`);
    }

    if (task.delegations.length > 0) {
      console.log(`\n  ${pc.bold("Delegations")} (${task.delegations.length}):`);
      for (const d of task.delegations) {
        const dur = d.dispatched_at && d.completed_at
          ? ` (${duration(d.completed_at - d.dispatched_at)})`
          : "";
        console.log(`    ${pc.dim("→")} ${d.instance}/${d.agent}: ${statusColor(d.status)}${dur}`);
        if (d.result_summary) {
          const summary = d.result_summary.length > 200
            ? d.result_summary.slice(0, 200) + "…"
            : d.result_summary;
          console.log(`      ${pc.dim(summary)}`);
        }
      }
    }

    if (task.research_summary) {
      console.log(`\n  ${pc.bold("Research")}:`);
      console.log(`    ${task.research_summary}`);
    }
  },
});

export default defineCommand({
  meta: { name: "task", description: "Manage tasks" },
  subCommands: { list, show },
});

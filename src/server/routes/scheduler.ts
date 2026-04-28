import { Hono } from "hono";
import { z } from "zod";
import type { Scheduler, ScheduledTask } from "../../scheduler/index.js";
import { parseBody } from "./validate.js";
import { adminOnly, canRead } from "../middleware/rbac.js";

const createTaskSchema = z.object({
  name: z.string().min(1),
  agent: z.string().min(1),
  prompt: z.string().min(1),
  description: z.string().optional(),
  cron_expression: z.string().optional(),
  run_at: z.number().optional(),
  channel: z.string().optional(),
  recipient: z.string().optional(),
  timeout_ms: z.number().optional(),
  authority_profile: z.enum(["scheduled", "system", "interactive"]).optional(),
});

const updateTaskSchema = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  cron_expression: z.string().optional(),
  run_at: z.number().optional(),
  agent: z.string().optional(),
  prompt: z.string().optional(),
  channel: z.string().optional(),
  recipient: z.string().optional(),
  timeout_ms: z.number().optional(),
  authority_profile: z.enum(["scheduled", "system", "interactive"]).optional(),
  enabled: z.boolean().optional(),
});

function cronToHuman(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return expr;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const fmtHour = (h: number): string => {
    const suffix = h >= 12 ? "pm" : "am";
    const display = h === 0 ? 12 : h > 12 ? h - 12 : h;
    return `${display}${suffix}`;
  };
  // */N * * * * → "Every Nmin"
  const everyDay = dayOfMonth === "*" && month === "*" && dayOfWeek === "*";
  if (!everyDay && (dayOfMonth !== "*" || month !== "*")) return expr;
  if (minute.startsWith("*/") && hour === "*" && everyDay) return `Every ${minute.slice(2)}min`;
  // 0 */N * * * → "Every Nh"
  if (hour.startsWith("*/") && minute === "0" && everyDay) return `Every ${hour.slice(2)}h`;
  // M * * * * → hourly at minute M
  if (hour === "*" && everyDay) {
    return minute === "0" ? "Hourly" : `Hourly at :${minute.padStart(2, "0")}`;
  }
  const h = Number.parseInt(hour);
  const m = Number.parseInt(minute);
  if (Number.isNaN(h) || Number.isNaN(m)) return expr;
  const time = m === 0 ? fmtHour(h) : `${h > 12 ? h - 12 : h}:${String(m).padStart(2, "0")}${h >= 12 ? "pm" : "am"}`;
  // 0 H * * * → "Daily at Ham/pm"
  if (everyDay) return `Daily at ${time}`;
  // 0 H * * 1,4 → "Mon, Thu at Ham/pm"
  const days = dayOfWeek.split(",").map((d) => dayNames[Number.parseInt(d)] ?? d);
  return `${days.join(", ")} at ${time}`;
}

function withHumanSchedule(task: ScheduledTask) {
  return { ...task, schedule_human: task.cron_expression ? cronToHuman(task.cron_expression) : null };
}

export function schedulerRoutes(scheduler: Scheduler): Hono {
  const app = new Hono();

  // GET /api/scheduler — stats
  app.get("/", canRead, (c) => {
    return c.json(scheduler.getStats());
  });

  // GET /api/scheduler/tasks — list all tasks
  app.get("/tasks", canRead, (c) => {
    const includeDisabled = c.req.query("all") === "true";
    return c.json(scheduler.listTasks(includeDisabled).map(withHumanSchedule));
  });

  // GET /api/scheduler/tasks/:id — single task (supports ID or name)
  app.get("/tasks/:id", canRead, (c) => {
    const param = c.req.param("id");
    const task = scheduler.getTask(param) ?? scheduler.getTaskByName(param);
    if (!task) return c.json({ error: "Task not found" }, 404);
    return c.json(withHumanSchedule(task));
  });

  // POST /api/scheduler/tasks — create a task
  app.post("/tasks", adminOnly, async (c) => {
    const body = await parseBody(c, createTaskSchema);
    if (body instanceof Response) return body;
    const id = scheduler.addTask({
      name: body.name,
      description: body.description,
      cron_expression: body.cron_expression,
      run_at: body.run_at,
      agent: body.agent,
      prompt: body.prompt,
      channel: body.channel,
      recipient: body.recipient,
      timeout_ms: body.timeout_ms,
      authority_profile: body.authority_profile,
      created_by: "api",
    });
    return c.json({ id, status: "created" }, 201);
  });

  // PATCH /api/scheduler/tasks/:id — update a task
  app.patch("/tasks/:id", adminOnly, async (c) => {
    const id = c.req.param("id");
    const task = scheduler.getTask(id);
    if (!task) return c.json({ error: "Task not found" }, 404);

    const body = await parseBody(c, updateTaskSchema);
    if (body instanceof Response) return body;
    scheduler.updateTask(id, body);
    return c.json({ id, status: "updated" });
  });

  // DELETE /api/scheduler/tasks/:id — delete a task
  app.delete("/tasks/:id", adminOnly, (c) => {
    const id = c.req.param("id");
    const task = scheduler.getTask(id);
    if (!task) return c.json({ error: "Task not found" }, 404);

    scheduler.deleteTask(id);
    return c.json({ id, status: "deleted" });
  });

  // GET /api/scheduler/tasks/:id/result — get scan result (supports ID or name)
  app.get("/tasks/:id/result", canRead, (c) => {
    const param = c.req.param("id");
    const result = scheduler.getTaskResult(param);
    if (!result) return c.json({ error: "Task not found" }, 404);
    return c.json(result);
  });

  // POST /api/scheduler/tasks/:id/trigger — trigger immediate execution (supports ID or name)
  app.post("/tasks/:id/trigger", adminOnly, async (c) => {
    const param = c.req.param("id");
    const task = scheduler.getTask(param) ?? scheduler.getTaskByName(param);
    if (!task) return c.json({ error: "Task not found" }, 404);

    try {
      await scheduler.triggerTask(task.id);
      return c.json({ ok: true, task_name: task.name, message: `Triggered ${task.name}` });
    } catch (err) {
      return c.json({ error: String(err) }, 500);
    }
  });

  return app;
}

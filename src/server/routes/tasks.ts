import { Hono } from "hono";
import { z } from "zod";
import type { TaskStore } from "../../tasks/store.js";
import { parseBody } from "./validate.js";
import { canRead, canWrite } from "../middleware/rbac.js";

const taskStatusEnum = z.enum(["backlog", "in_progress", "review", "done"]);

const createTaskSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  status: taskStatusEnum.optional(),
  assignee: z.string().optional(),
  assigneeType: z.string().optional(),
});

const updateTaskSchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  status: taskStatusEnum.optional(),
  assignee: z.string().optional(),
  assigneeType: z.string().optional(),
});

const reorderSchema = z.object({
  columns: z.record(z.string(), z.array(z.string())),
});

export function tasksRoutes(tasks: TaskStore): Hono {
  const app = new Hono();

  // GET /api/tasks — list all tasks
  app.get("/", canRead, (c) => {
    const all = tasks.list();
    // Map to frontend format (camelCase)
    return c.json(all.map(t => ({
      id: t.id,
      title: t.title,
      description: t.description,
      status: t.status,
      assignee: t.assignee,
      assigneeType: t.assignee_type,
      createdAt: t.created_at,
      updatedAt: t.updated_at,
    })));
  });

  // POST /api/tasks — create a task
  app.post("/", canWrite, async (c) => {
    const body = await parseBody(c, createTaskSchema);
    if (body instanceof Response) return body;

    const task = tasks.create({
      title: body.title.trim(),
      description: body.description?.trim(),
      status: body.status,
      assignee: body.assignee,
      assigneeType: body.assigneeType,
    });

    return c.json({
      ok: true,
      task: {
        id: task.id,
        title: task.title,
        description: task.description,
        status: task.status,
        assignee: task.assignee,
        assigneeType: task.assignee_type,
        createdAt: task.created_at,
        updatedAt: task.updated_at,
      },
    }, 201);
  });

  // PUT /api/tasks/reorder — reorder tasks across columns
  app.put("/reorder", canWrite, async (c) => {
    const body = await parseBody(c, reorderSchema);
    if (body instanceof Response) return body;
    tasks.reorder(body.columns);
    return c.json({ ok: true });
  });

  // PUT /api/tasks/:id — update a task
  app.put("/:id", canWrite, async (c) => {
    const id = c.req.param("id");
    const body = await parseBody(c, updateTaskSchema);
    if (body instanceof Response) return body;

    const updated = tasks.update(id, {
      title: body.title,
      description: body.description,
      status: body.status,
      assignee: body.assignee,
      assignee_type: body.assigneeType,
    });

    if (!updated) {
      return c.json({ error: "task not found" }, 404);
    }

    return c.json({
      ok: true,
      task: {
        id: updated.id,
        title: updated.title,
        description: updated.description,
        status: updated.status,
        assignee: updated.assignee,
        assigneeType: updated.assignee_type,
        createdAt: updated.created_at,
        updatedAt: updated.updated_at,
      },
    });
  });

  // DELETE /api/tasks/:id — delete a task
  app.delete("/:id", canWrite, (c) => {
    const id = c.req.param("id");
    const deleted = tasks.delete(id);
    if (!deleted) {
      return c.json({ error: "task not found" }, 404);
    }
    return c.json({ ok: true });
  });

  return app;
}

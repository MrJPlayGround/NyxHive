import { Hono } from "hono";
import { z } from "zod";
import type { AuthEnv } from "../../auth/types.js";
import type { ThreadDB } from "../db/threads.js";
import { parseBody } from "./validate.js";
import { canRead, canWrite } from "../middleware/rbac.js";

const createProjectSchema = z.object({
  name: z.string().min(1),
  instance: z.string().min(1),
  repo_path: z.string().optional(),
  default_agent: z.string().optional(),
});

const updateProjectSchema = z.object({
  name: z.string().min(1).optional(),
  instance: z.string().min(1).optional(),
  repo_path: z.string().nullable().optional(),
  default_agent: z.string().nullable().optional(),
});

export function projectRoutes(threadDb: ThreadDB): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();

  // POST /api/projects — Create
  app.post("/projects", canWrite, async (c) => {
    const result = await parseBody(c, createProjectSchema);
    if (result instanceof Response) return result;
    const body = result;

    const project = threadDb.createProject({
      name: body.name,
      instance: body.instance,
      repo_path: body.repo_path,
      default_agent: body.default_agent,
    });

    return c.json(project, 201);
  });

  // GET /api/projects — List
  app.get("/projects", canRead, (c) => {
    const projects = threadDb.listProjects();
    return c.json({ projects });
  });

  // GET /api/projects/:id — Get with recent threads
  app.get("/projects/:id", canRead, (c) => {
    const id = c.req.param("id");
    const project = threadDb.getProject(id);
    if (!project) return c.json({ error: "Project not found" }, 404);

    const { threads } = threadDb.listThreads({ project_id: id, limit: 10 });
    return c.json({ ...project, recent_threads: threads });
  });

  // PUT /api/projects/:id — Update
  app.put("/projects/:id", canWrite, async (c) => {
    const id = c.req.param("id");
    const existing = threadDb.getProject(id);
    if (!existing) return c.json({ error: "Project not found" }, 404);

    const result = await parseBody(c, updateProjectSchema);
    if (result instanceof Response) return result;
    const body = result;

    const updated = threadDb.updateProject(id, body);
    return c.json(updated);
  });

  // DELETE /api/projects/:id — Delete (fails if has threads)
  app.delete("/projects/:id", canWrite, (c) => {
    const id = c.req.param("id");
    const existing = threadDb.getProject(id);
    if (!existing) return c.json({ error: "Project not found" }, 404);

    const deleted = threadDb.deleteProject(id);
    if (!deleted) {
      return c.json({ error: "Cannot delete project with existing threads. Delete or reassign threads first." }, 400);
    }

    return c.json({ deleted: true });
  });

  return app;
}

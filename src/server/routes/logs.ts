import { Hono } from "hono";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { canRead } from "../middleware/rbac.js";

export function logsRoutes(dataDir: string, projectName?: string): Hono {
  const app = new Hono();
  const fileName = `${(projectName ?? "instance").toLowerCase()}.log`;
  const logPath = join(dataDir, fileName);

  // GET /api/logs?limit=200 — tail the log file
  app.get("/", canRead, (c) => {
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 200), 1), 2000);

    if (!existsSync(logPath)) {
      return c.json({ lines: [], path: logPath });
    }

    try {
      const content = readFileSync(logPath, "utf-8");
      const allLines = content.split("\n").filter(Boolean);
      const lines = allLines.slice(-limit);
      return c.json({ lines, total: allLines.length });
    } catch {
      return c.json({ lines: [], error: "Failed to read log file" });
    }
  });

  return app;
}

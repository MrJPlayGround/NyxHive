import { z } from "zod";
import { registerTool } from "../lib/tool-registry.js";

registerTool({
  name: "read",
  description: "Read a file from disk and return its contents",
  schema: z.object({
    path: z.string().min(1),
    offset: z.number().int().nonnegative().optional().default(0),
    limit: z.number().int().positive().optional(),
  }),
  gate: "none",
  render: ({ path }) => path,
  execute: async ({ path, offset, limit }) => {
    const file = Bun.file(path);
    const exists = await file.exists();
    if (!exists) return { ok: false, error: `File not found: ${path}` };

    const text = await file.text();
    const lines = text.split("\n");
    const sliced = limit !== undefined
      ? lines.slice(offset, offset + limit)
      : lines.slice(offset);

    return { ok: true, output: sliced.join("\n") };
  },
});

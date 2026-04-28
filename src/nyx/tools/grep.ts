import { z } from "zod";
import { registerTool } from "../lib/tool-registry.js";

registerTool({
  name: "grep",
  description: "Search file contents with ripgrep",
  schema: z.object({
    pattern: z.string().min(1),
    path: z.string().optional(),
    glob: z.string().optional(),
    ignoreCase: z.boolean().optional().default(false),
    context: z.number().int().nonnegative().optional(),
    maxResults: z.number().int().positive().optional().default(100),
  }),
  gate: "none",
  render: ({ pattern, path }) => `${pattern}${path ? ` in ${path}` : ""}`,
  execute: async ({ pattern, path, glob, ignoreCase, context, maxResults }, ctx) => {
    const args: string[] = ["rg", "--no-heading", "--line-number"];
    if (ignoreCase) args.push("-i");
    if (context !== undefined) args.push("-C", String(context));
    if (glob) args.push("--glob", glob);
    args.push("--max-count", String(maxResults));
    args.push(pattern);
    if (path) args.push(path);

    const proc = Bun.spawn(args, {
      cwd: ctx?.workdir ?? process.cwd(),
      stdout: "pipe",
      stderr: "pipe",
    });

    await proc.exited;

    const stdout = await new Response(proc.stdout).text();
    const code = proc.exitCode ?? 0;

    // rg exits 1 when no matches — that's fine
    if (code > 1) {
      const stderr = await new Response(proc.stderr).text();
      return { ok: false, error: stderr.trim() || `rg exited ${code}` };
    }

    return { ok: true, output: stdout.trim() || "(no matches)" };
  },
});

import { z } from "zod";
import { registerTool } from "../lib/tool-registry.js";

registerTool({
  name: "glob",
  description: "Find files matching a glob pattern",
  schema: z.object({
    pattern: z.string().min(1),
    cwd: z.string().optional(),
  }),
  gate: "none",
  render: ({ pattern }) => pattern,
  execute: async ({ pattern, cwd }, ctx) => {
    const base = cwd ?? ctx?.workdir ?? process.cwd();
    const glob = new Bun.Glob(pattern);
    const matches: string[] = [];

    for await (const file of glob.scan({ cwd: base, absolute: false })) {
      matches.push(file);
    }

    if (matches.length === 0) return { ok: true, output: "(no matches)" };
    return { ok: true, output: matches.sort().join("\n") };
  },
});

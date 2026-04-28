import { z } from "zod";
import { registerTool } from "../lib/tool-registry.js";

registerTool({
  name: "bash",
  description: "Execute a shell command and return stdout+stderr",
  schema: z.object({
    command: z.string().min(1),
    cwd: z.string().optional(),
    timeout: z.number().int().positive().optional().default(30_000),
  }),
  gate: "confirm",
  render: ({ command }) => command.slice(0, 80),
  execute: async ({ command, cwd, timeout }, ctx) => {
    const signal = ctx?.signal ?? AbortSignal.timeout(timeout);
    const workdir = cwd ?? ctx?.workdir;

    const proc = Bun.spawn(["bash", "-c", command], {
      cwd: workdir,
      stdout: "pipe",
      stderr: "pipe",
    });

    const done = proc.exited;
    const abort = new Promise<never>((_, reject) => {
      signal.addEventListener("abort", () => reject(new Error("bash: timed out")), { once: true });
    });

    try {
      await Promise.race([done, abort]);
    } catch (err) {
      proc.kill();
      return { ok: false, error: (err as Error).message };
    }

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);

    const code = proc.exitCode ?? 0;
    const output = [stdout, stderr].filter(Boolean).join("\n");

    if (code !== 0) {
      return { ok: false, error: `exit ${code}\n${output}`.trim() };
    }
    return { ok: true, output: output || "(no output)" };
  },
});

import { z } from "zod";
import { registerTool } from "../lib/tool-registry.js";

registerTool({
  name: "web_fetch",
  description: "Fetch a URL and return the response body as text",
  schema: z.object({
    url: z.string().url(),
    method: z.enum(["GET", "POST", "PUT", "DELETE"]).optional().default("GET"),
    headers: z.record(z.string(), z.string()).optional(),
    body: z.string().optional(),
    timeout: z.number().int().positive().optional().default(15_000),
  }),
  gate: "confirm",
  render: ({ method = "GET", url }) => `${method} ${url}`,
  execute: async ({ url, method = "GET", headers, body, timeout }, ctx) => {
    const signal = ctx?.signal ?? AbortSignal.timeout(timeout);
    try {
      const res = await fetch(url, {
        method,
        headers,
        body: body ?? undefined,
        signal,
      });
      const text = await res.text();
      if (!res.ok) {
        return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
      }
      return { ok: true, output: text };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
});

import type { z } from "zod";
import type { Context } from "hono";

export async function parseBody<T>(c: Context, schema: z.ZodType<T>): Promise<T | Response> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    // If no body provided, try parsing empty object (works for schemas with all-optional fields)
    body = {};
  }

  const result = schema.safeParse(body);
  if (!result.success) {
    return c.json({ error: "Validation failed", issues: result.error.issues }, 400);
  }
  return result.data;
}

/**
 * Nyx CLI tool registry.
 * Tools self-register via side-effect imports; Bun dead-code elimination
 * drops tools that are never imported.
 */
import { z } from "zod";

// ─── Types ────────────────────────────────────────────────────────────────────

/** How much human approval a tool requires before execution. */
export type PermissionGate = "none" | "confirm" | "always-ask";

export interface ToolContext {
  workdir?: string;
  signal?: AbortSignal;
}

export type ToolResult =
  | { ok: true; output: string }
  | { ok: false; error: string };

export interface ToolDef<TSchema extends z.ZodTypeAny = z.ZodTypeAny> {
  name: string;
  description: string;
  schema: TSchema;
  gate: PermissionGate;
  /** Render a one-line summary of the input for display. */
  render?: (input: z.infer<TSchema>) => string;
  execute: (input: z.infer<TSchema>, ctx?: ToolContext) => Promise<ToolResult>;
}

// ─── Registry ─────────────────────────────────────────────────────────────────

const registry = new Map<string, ToolDef>();

export function registerTool<T extends z.ZodTypeAny>(tool: ToolDef<T>): void {
  registry.set(tool.name, tool as ToolDef);
}

export function getTool(name: string): ToolDef | undefined {
  return registry.get(name);
}

export function listTools(): ToolDef[] {
  return [...registry.values()];
}

// ─── Execution ────────────────────────────────────────────────────────────────

/**
 * Validate input against the tool's schema, then execute.
 * Always returns a ToolResult — never throws.
 */
export async function executeTool(
  name: string,
  rawInput: unknown,
  ctx?: ToolContext,
): Promise<ToolResult> {
  const tool = registry.get(name);
  if (!tool) return { ok: false, error: `Unknown tool: ${name}` };

  const parsed = tool.schema.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, error: `Invalid input — ${parsed.error.message}` };
  }

  try {
    return await tool.execute(parsed.data as z.infer<typeof tool.schema>, ctx);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ─── Approval ─────────────────────────────────────────────────────────────────

export interface ApprovalPrompt {
  /**
   * Present an approval question. Resolves true if approved.
   * toolName is optional context — used to track session-level always-approvals (the 'a' response).
   */
  ask: (question: string, toolName?: string) => Promise<boolean>;
}

/**
 * Check the gate for a tool and optionally prompt for approval.
 * Returns true if execution should proceed.
 */
export async function checkGate(
  name: string,
  input: unknown,
  prompt?: ApprovalPrompt,
): Promise<boolean> {
  const tool = registry.get(name);
  if (!tool) return false;

  if (tool.gate === "none") return true;

  if (!prompt) {
    // No prompt available — block confirm/always-ask tools
    return false;
  }

  const summary = tool.render
    ? tool.render(input as z.infer<typeof tool.schema>)
    : JSON.stringify(input);

  return prompt.ask(`Allow ${name}: ${summary}?`, name);
}

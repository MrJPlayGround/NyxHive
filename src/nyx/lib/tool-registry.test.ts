import { describe, expect, mock, test } from "bun:test";
import { z } from "zod";
import { checkGate, executeTool, registerTool, type ApprovalPrompt, type ToolContext } from "./tool-registry.js";

let toolCounter = 0;

function nextToolName(label: string): string {
  toolCounter += 1;
  return `tool-registry-test-${label}-${toolCounter}`;
}

describe("executeTool", () => {
  test("returns an error for unknown tools", async () => {
    const result = await executeTool(nextToolName("missing"), {});

    expect(result).toEqual({
      ok: false,
      error: expect.stringContaining("Unknown tool:"),
    });
  });

  test("rejects invalid input before execution", async () => {
    const execute = mock(async () => ({ ok: true as const, output: "should not run" }));
    const name = nextToolName("invalid-input");
    registerTool({
      name,
      description: "Test invalid input",
      schema: z.object({ value: z.string() }),
      gate: "none",
      execute,
    });

    const result = await executeTool(name, { value: 123 });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected invalid input to fail");
    }
    expect(result.error).toContain("Invalid input");
    expect(execute).not.toHaveBeenCalled();
  });

  test("passes parsed input and context to the registered tool", async () => {
    const ctx: ToolContext = { workdir: "/tmp/tool-registry" };
    const execute = mock(async (input: { value: string }, receivedCtx?: ToolContext) => ({
      ok: true as const,
      output: `${input.value}:${receivedCtx?.workdir ?? "missing"}`,
    }));
    const name = nextToolName("success");
    registerTool({
      name,
      description: "Test success path",
      schema: z.object({ value: z.string() }),
      gate: "none",
      execute,
    });

    const result = await executeTool(name, { value: "hello" }, ctx);

    expect(result).toEqual({ ok: true, output: "hello:/tmp/tool-registry" });
    expect(execute).toHaveBeenCalledWith({ value: "hello" }, ctx);
  });

  test("wraps thrown errors as tool results", async () => {
    const name = nextToolName("throws");
    registerTool({
      name,
      description: "Test thrown error",
      schema: z.object({}),
      gate: "none",
      execute: async () => {
        throw new Error("boom");
      },
    });

    const result = await executeTool(name, {});

    expect(result).toEqual({ ok: false, error: "boom" });
  });
});

describe("checkGate", () => {
  test("auto-approves tools with gate=none without prompting", async () => {
    const ask = mock<ApprovalPrompt["ask"]>(async () => true);
    const name = nextToolName("gate-none");
    registerTool({
      name,
      description: "No approval required",
      schema: z.object({ value: z.string() }),
      gate: "none",
      execute: async () => ({ ok: true, output: "ok" }),
    });

    const allowed = await checkGate(name, { value: "hello" }, { ask });

    expect(allowed).toBe(true);
    expect(ask).not.toHaveBeenCalled();
  });

  test("blocks confirm-gated tools when no prompt is available", async () => {
    const name = nextToolName("gate-confirm-no-prompt");
    registerTool({
      name,
      description: "Prompt required",
      schema: z.object({ value: z.string() }),
      gate: "confirm",
      execute: async () => ({ ok: true, output: "ok" }),
    });

    const allowed = await checkGate(name, { value: "hello" });

    expect(allowed).toBe(false);
  });

  test("uses the rendered summary when prompting", async () => {
    const ask = mock<ApprovalPrompt["ask"]>(async () => true);
    const name = nextToolName("gate-render");
    registerTool({
      name,
      description: "Rendered prompt summary",
      schema: z.object({ value: z.string() }),
      gate: "always-ask",
      render: ({ value }) => `value=${value}`,
      execute: async () => ({ ok: true, output: "ok" }),
    });

    const allowed = await checkGate(name, { value: "hello" }, { ask });

    expect(allowed).toBe(true);
    expect(ask).toHaveBeenCalledWith(`Allow ${name}: value=hello?`, name);
  });
});

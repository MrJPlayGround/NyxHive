import { describe, test, expect } from "bun:test";
import {
  extractClaudeInputRequest,
  parseClaudeJsonOutput,
  parseCodexJsonOutput,
  parseOpenCodeOutput,
  stripClaudeInputRequest,
} from "../agents/output-parsers.js";
import type { AgentConfig } from "../types.js";

function makeAgent(overrides?: Partial<AgentConfig>): AgentConfig {
  return {
    name: "test-agent",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    working_directory: "/tmp/test",
    ...overrides,
  } as AgentConfig;
}

function ndjson(...objects: Record<string, unknown>[]): string {
  return objects.map((o) => JSON.stringify(o)).join("\n");
}

// --- parseClaudeJsonOutput ---

describe("parseClaudeJsonOutput", () => {
  test("extracts result text from result message", () => {
    const output = ndjson(
      { type: "result", result: "Hello from the agent", is_error: false, num_turns: 1 },
    );
    const result = parseClaudeJsonOutput(makeAgent(), output, 100);
    expect(result.response).toBe("Hello from the agent");
    expect(result.agent).toBe("test-agent");
    expect(result.method).toBe("cli");
    expect(result.duration_ms).toBe(100);
  });

  test("extracts Claude session metadata from result messages", () => {
    const output = ndjson(
      { type: "result", result: "done", is_error: false, num_turns: 1, session_id: "claude-session-1" },
    );
    const result = parseClaudeJsonOutput(makeAgent(), output, 100);
    expect(result.session_id).toBe("claude-session-1");
    expect(result.session_runtime).toBe("claude_cli");
  });

  test("accumulates tokens from assistant messages", () => {
    const output = ndjson(
      {
        type: "assistant",
        message: {
          usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 20 },
          content: [],
        },
      },
      {
        type: "assistant",
        message: {
          usage: { input_tokens: 80, output_tokens: 30, cache_creation_input_tokens: 10 },
          content: [],
        },
      },
      { type: "result", result: "done", is_error: false, num_turns: 2 },
    );
    const result = parseClaudeJsonOutput(makeAgent(), output, 200);
    expect(result.tokens_in).toBe(100 + 20 + 80 + 10); // 210
    expect(result.tokens_out).toBe(50 + 30); // 80
    expect(result.last_turn_tokens_in).toBe(80);
  });

  test("falls back to result-level usage when no assistant tokens", () => {
    const output = ndjson(
      {
        type: "result",
        result: "done",
        is_error: false,
        num_turns: 1,
        usage: { input_tokens: 500, output_tokens: 100 },
      },
    );
    const result = parseClaudeJsonOutput(makeAgent(), output, 100);
    expect(result.tokens_in).toBe(500);
    expect(result.tokens_out).toBe(100);
    expect(result.last_turn_tokens_in).toBe(500);
  });

  test("extracts cost from result message", () => {
    const output = ndjson(
      { type: "result", result: "done", is_error: false, total_cost_usd: 0.05, num_turns: 1 },
    );
    const result = parseClaudeJsonOutput(makeAgent(), output, 100);
    expect(result.cost).toBe(0.05);
  });

  test("formats error result with subtype", () => {
    const output = ndjson(
      { type: "result", is_error: true, subtype: "timeout", result: "Agent timed out", num_turns: 1 },
    );
    const result = parseClaudeJsonOutput(makeAgent(), output, 100);
    expect(result.response).toBe("[CLI error: timeout] Agent timed out");
  });

  test("returns fallback text when no result message exists", () => {
    const output = ndjson(
      {
        type: "assistant",
        message: {
          usage: { input_tokens: 10, output_tokens: 5 },
          content: [{ type: "text", text: "Some partial output" }],
        },
      },
    );
    const result = parseClaudeJsonOutput(makeAgent(), output, 100);
    expect(result.response).toBe("Some partial output");
    expect(result.tokens_in).toBe(10);
  });

  test("returns placeholder when no result and no text", () => {
    const output = "";
    const result = parseClaudeJsonOutput(makeAgent(), output, 100);
    expect(result.response).toBe("[No response text captured]");
  });

  test("detects plan mode entry and exit", () => {
    const output = ndjson(
      {
        type: "assistant",
        message: {
          usage: { input_tokens: 10, output_tokens: 5 },
          content: [
            { type: "tool_use", name: "EnterPlanMode" },
            { type: "text", text: "## Plan\nStep 1: Do thing" },
          ],
        },
      },
      {
        type: "assistant",
        message: {
          usage: { input_tokens: 10, output_tokens: 5 },
          content: [{ type: "tool_use", name: "ExitPlanMode" }],
        },
      },
      { type: "result", result: "", is_error: false, num_turns: 2 },
    );
    const result = parseClaudeJsonOutput(makeAgent(), output, 100);
    expect(result.exitedPlanMode).toBe(true);
    expect(result.planText).toBe("## Plan\nStep 1: Do thing");
    expect(result.response).toBe("Plan ready for review");
  });

  test("collects tools used", () => {
    const output = ndjson(
      {
        type: "assistant",
        message: {
          usage: { input_tokens: 10, output_tokens: 5 },
          content: [
            { type: "tool_use", name: "Read" },
            { type: "tool_use", name: "Edit" },
            { type: "tool_use", name: "Read" }, // duplicate
          ],
        },
      },
      { type: "result", result: "done", is_error: false, num_turns: 1 },
    );
    const result = parseClaudeJsonOutput(makeAgent(), output, 100);
    expect(result.toolsUsed).toEqual(expect.arrayContaining(["Read", "Edit"]));
    expect(result.toolsUsed).toHaveLength(2); // deduped
  });

  test("detects hitMaxTurns when num_turns >= max_tool_turns", () => {
    const agent = makeAgent({ max_tool_turns: 5 });
    const output = ndjson(
      { type: "result", result: "done", is_error: false, num_turns: 5 },
    );
    const result = parseClaudeJsonOutput(agent, output, 100);
    expect(result.hitMaxTurns).toBe(true);
  });

  test("hitMaxTurns is undefined when under cap", () => {
    const agent = makeAgent({ max_tool_turns: 10 });
    const output = ndjson(
      { type: "result", result: "done", is_error: false, num_turns: 3 },
    );
    const result = parseClaudeJsonOutput(agent, output, 100);
    expect(result.hitMaxTurns).toBeUndefined();
  });

  test("hitMaxTurns is undefined when no max_tool_turns configured", () => {
    const output = ndjson(
      { type: "result", result: "done", is_error: false, num_turns: 50 },
    );
    const result = parseClaudeJsonOutput(makeAgent(), output, 100);
    expect(result.hitMaxTurns).toBeUndefined();
  });

  test("expands short result with full text from multi-turn conversations", () => {
    const output = ndjson(
      {
        type: "assistant",
        message: {
          usage: { input_tokens: 10, output_tokens: 50 },
          content: [{ type: "text", text: "I analyzed the code and found several issues with the authentication module that need fixing." }],
        },
      },
      {
        type: "assistant",
        message: {
          usage: { input_tokens: 10, output_tokens: 10 },
          content: [{ type: "text", text: "Done." }],
        },
      },
      { type: "result", result: "Done.", is_error: false, num_turns: 3 },
    );
    const result = parseClaudeJsonOutput(makeAgent(), output, 100);
    // Short result (< 200 chars) + multiple text parts + numTurns > 1 → expanded
    expect(result.response).toContain("I analyzed the code");
    expect(result.response).toContain("Done.");
  });

  test("skips non-JSON lines gracefully", () => {
    const output = `not json\n${JSON.stringify({ type: "result", result: "ok", is_error: false, num_turns: 1 })}\nmore garbage`;
    const result = parseClaudeJsonOutput(makeAgent(), output, 100);
    expect(result.response).toBe("ok");
  });

  test("includes model from agent config", () => {
    const output = ndjson(
      { type: "result", result: "done", is_error: false, num_turns: 1 },
    );
    const result = parseClaudeJsonOutput(makeAgent({ model: "claude-opus-4-6" }), output, 100);
    expect(result.model).toBe("claude-opus-4-6");
  });

  test("extracts input_request blocks and strips them from the visible response", () => {
    const output = ndjson(
      {
        type: "result",
        result: [
          "Need your choice first.",
          "```json",
          JSON.stringify({
            input_request: {
              question: "Which repo should I touch?",
              options: [
                { key: "nyxhive", description: "Backend orchestrator" },
                { key: "onyx", description: "Supervisor shell" },
              ],
            },
          }),
          "```",
        ].join("\n"),
        is_error: false,
        num_turns: 1,
        session_id: "claude-session-2",
      },
    );
    const result = parseClaudeJsonOutput(makeAgent(), output, 100);
    expect(result.response).toBe("Need your choice first.");
    expect(result.input_request).toEqual({
      question: "Which repo should I touch?",
      options: [
        { key: "nyxhive", description: "Backend orchestrator" },
        { key: "onyx", description: "Supervisor shell" },
      ],
    });
    expect(result.session_id).toBe("claude-session-2");
  });
});

describe("Claude input request helpers", () => {
  test("extractClaudeInputRequest parses a trailing json block", () => {
    const text = [
      "Need your choice first.",
      "```json",
      JSON.stringify({
        input_request: {
          question: "Which repo should I touch?",
          options: [{ key: "nyxhive", description: "Backend orchestrator" }],
          timeout_ms: 60000,
        },
      }),
      "```",
    ].join("\n");

    expect(extractClaudeInputRequest(text)).toEqual({
      question: "Which repo should I touch?",
      options: [{ key: "nyxhive", description: "Backend orchestrator" }],
      timeout_ms: 60000,
    });
    expect(stripClaudeInputRequest(text)).toBe("Need your choice first.");
  });
});

// --- parseOpenCodeOutput ---

describe("parseOpenCodeOutput", () => {
  test("extracts text from text events", () => {
    const output = ndjson(
      { type: "text", part: { text: "Hello " } },
      { type: "text", part: { text: "world" } },
    );
    const result = parseOpenCodeOutput(makeAgent(), output, 100);
    expect(result.response).toBe("Hello world");
    expect(result.agent).toBe("test-agent");
    expect(result.method).toBe("api");
  });

  test("accumulates tokens from step_finish events", () => {
    const output = ndjson(
      { type: "step_finish", usage: { promptTokens: 100, completionTokens: 50 } },
      { type: "step_finish", usage: { promptTokens: 80, completionTokens: 30 } },
      { type: "text", part: { text: "done" } },
    );
    const result = parseOpenCodeOutput(makeAgent(), output, 100);
    expect(result.tokens_in).toBe(180);
    expect(result.tokens_out).toBe(80);
  });

  test("collects tool names from tool_use events", () => {
    const output = ndjson(
      { type: "tool_use", part: { toolInvocation: { state: "call", toolName: "read_file" } } },
      { type: "tool_use", part: { toolInvocation: { state: "result", toolName: "search_code" } } },
      { type: "text", part: { text: "found it" } },
    );
    const result = parseOpenCodeOutput(makeAgent(), output, 100);
    expect(result.toolsUsed).toEqual(expect.arrayContaining(["read_file", "search_code"]));
    expect(result.toolsUsed).toHaveLength(2);
  });

  test("handles error events", () => {
    const output = ndjson(
      { type: "error", error: { message: "rate limit exceeded" } },
    );
    const result = parseOpenCodeOutput(makeAgent(), output, 100);
    expect(result.response).toBe("[OpenCode error] rate limit exceeded");
  });

  test("returns 'Task completed' when no text and no error", () => {
    const output = ndjson(
      { type: "step_finish", usage: { promptTokens: 10, completionTokens: 5 } },
    );
    const result = parseOpenCodeOutput(makeAgent(), output, 100);
    expect(result.response).toBe("Task completed");
  });

  test("calculates cost from token counts using model rates", () => {
    const agent = makeAgent({ model: "claude-sonnet-4-6" });
    const output = ndjson(
      { type: "step_finish", usage: { promptTokens: 1_000_000, completionTokens: 100_000 } },
      { type: "text", part: { text: "done" } },
    );
    const result = parseOpenCodeOutput(agent, output, 100);
    // claude-sonnet-4-6: input=$3/M, output=$15/M
    // cost = (1_000_000 * 3 + 100_000 * 15) / 1_000_000 = 3 + 1.5 = 4.5
    expect(result.cost).toBe(4.5);
  });

  test("cost is zero for unknown model", () => {
    const agent = makeAgent({ model: "unknown-model" });
    const output = ndjson(
      { type: "step_finish", usage: { promptTokens: 1000, completionTokens: 500 } },
      { type: "text", part: { text: "done" } },
    );
    const result = parseOpenCodeOutput(agent, output, 100);
    expect(result.cost).toBe(0);
  });

  test("skips non-JSON lines gracefully", () => {
    const output = `garbage\n${JSON.stringify({ type: "text", part: { text: "ok" } })}\nnope`;
    const result = parseOpenCodeOutput(makeAgent(), output, 100);
    expect(result.response).toBe("ok");
  });

  test("deduplicates tool names", () => {
    const output = ndjson(
      { type: "tool_use", part: { toolInvocation: { state: "call", toolName: "read_file" } } },
      { type: "tool_use", part: { toolInvocation: { state: "result", toolName: "read_file" } } },
      { type: "text", part: { text: "done" } },
    );
    const result = parseOpenCodeOutput(makeAgent(), output, 100);
    expect(result.toolsUsed).toEqual(["read_file"]);
  });
});

describe("parseCodexJsonOutput", () => {
  test("extracts final text from completed agent_message items", () => {
    const output = ndjson(
      { type: "turn.started" },
      { type: "item.completed", item: { id: "item_0", type: "agent_message", text: "Hello from Codex" } },
      { type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 25, output_tokens: 20 } },
    );

    const result = parseCodexJsonOutput(makeAgent({ provider: "openai", model: "gpt-5.4" }), output, 100);
    expect(result.response).toBe("Hello from Codex");
    expect(result.method).toBe("cli");
    expect(result.tokens_in).toBe(125);
    expect(result.tokens_out).toBe(20);
  });

  test("deduplicates command execution tool usage", () => {
    const output = ndjson(
      { type: "turn.started" },
      { type: "item.started", item: { id: "item_0", type: "command_execution", command: "pwd", status: "in_progress" } },
      { type: "item.completed", item: { id: "item_0", type: "command_execution", command: "pwd", aggregated_output: "/tmp\n", exit_code: 0, status: "completed" } },
      { type: "item.completed", item: { id: "item_1", type: "agent_message", text: "done" } },
      { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } },
    );

    const result = parseCodexJsonOutput(makeAgent({ provider: "openai", model: "gpt-5.4" }), output, 100);
    expect(result.toolsUsed).toEqual(["command_execution"]);
  });

  test("returns a codex error marker when no assistant text exists", () => {
    const output = ndjson(
      { type: "error", error: { message: "rate limit exceeded" } },
    );

    const result = parseCodexJsonOutput(makeAgent({ provider: "openai", model: "gpt-5.4" }), output, 100);
    expect(result.response).toBe("[Codex error] rate limit exceeded");
  });

  test("throws when codex exits without an assistant response", () => {
    const output = ndjson(
      { type: "thread.started", thread_id: "thread-1" },
      { type: "turn.started" },
    );

    expect(() =>
      parseCodexJsonOutput(makeAgent({ provider: "openai", model: "gpt-5.4" }), output, 100),
    ).toThrow("Codex produced no assistant response");
  });

  test("extracts input_request blocks from codex agent messages", () => {
    const text = [
      "Need your choice first.",
      "```json",
      JSON.stringify({
        input_request: {
          question: "Which repo should I touch?",
          options: [{ key: "nyxhive", description: "Backend orchestrator" }],
        },
      }),
      "```",
    ].join("\n");

    const output = ndjson(
      { type: "turn.started" },
      { type: "item.completed", item: { id: "item_0", type: "agent_message", text } },
      { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } },
    );

    const result = parseCodexJsonOutput(makeAgent({ provider: "openai", model: "gpt-5.4" }), output, 100);
    expect(result.response).toBe("Need your choice first.");
    expect(result.input_request).toEqual({
      question: "Which repo should I touch?",
      options: [{ key: "nyxhive", description: "Backend orchestrator" }],
    });
  });
});

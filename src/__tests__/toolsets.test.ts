import { describe, expect, test } from "bun:test";
import { buildLocalToolDefinitions, filterLocalToolDefinitions } from "../agents/tool-permissions.js";
import { resolveAgentToolPolicy } from "../agents/toolsets.js";
import { SDK_TOOLS, SDK_UTILITY_TOOLS, SDK_WRITE_TOOLS } from "../agents/tools.js";

describe("agent toolsets", () => {
  test("default profile preserves existing allow/disallow behavior", () => {
    const names = filterLocalToolDefinitions([...SDK_TOOLS, ...SDK_WRITE_TOOLS], {
      allowed_tools: ["Read", "Edit"],
      disallowed_tools: ["Edit"],
    }).map((tool) => tool.name);

    expect(names).toEqual(["read_file"]);
  });

  test("read_only profile exposes read/search utilities without write tools", () => {
    const tools = buildLocalToolDefinitions({
      useTools: true,
      canWrite: true,
      includeUtilityTools: true,
      taskType: "coding",
      agent: { toolset: "read_only" } as any,
    })?.map((tool) => tool.name);

    expect(tools).toContain("read_file");
    expect(tools).toContain("search_code");
    expect(tools).toContain("todo_read");
    expect(tools).not.toContain("write_file");
    expect(tools).not.toContain("edit_file");
    expect(tools).not.toContain("run_command");
  });

  test("coding profile includes write tools when canWrite is true", () => {
    const tools = buildLocalToolDefinitions({
      useTools: true,
      canWrite: true,
      includeUtilityTools: true,
      taskType: "coding",
      agent: { toolset: "coding" } as any,
    })?.map((tool) => tool.name);

    expect(tools).toContain("write_file");
    expect(tools).toContain("edit_file");
    expect(tools).toContain("run_command");
    expect(tools).toContain("todo_write");
  });

  test("off profile removes local tools even when base definitions are broad", () => {
    const tools = filterLocalToolDefinitions([...SDK_TOOLS, ...SDK_UTILITY_TOOLS, ...SDK_WRITE_TOOLS], {
      toolset: "off",
    } as any);

    expect(tools).toEqual([]);
  });

  test("explicit agent disallow still wins over profile tools", () => {
    const policy = resolveAgentToolPolicy({ toolset: "coding", disallowed_tools: ["Bash"] } as any);
    expect(policy.allowed_tools).toContain("run_command");

    const tools = buildLocalToolDefinitions({
      useTools: true,
      canWrite: true,
      includeUtilityTools: true,
      taskType: "coding",
      agent: { toolset: "coding", disallowed_tools: ["Bash"] } as any,
    })?.map((tool) => tool.name);

    expect(tools).not.toContain("run_command");
  });
});

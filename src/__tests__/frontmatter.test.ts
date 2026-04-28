import { describe, it, expect } from "bun:test";
import { parseFrontmatter } from "../soul/frontmatter.js";

describe("parseFrontmatter", () => {
  it("parses YAML frontmatter between --- markers", () => {
    const result = parseFrontmatter(`---
name: TestAgent
role: worker
---
# Body content

Some text here.`);

    expect(result.frontmatter.name).toBe("TestAgent");
    expect(result.frontmatter.role).toBe("worker");
    expect(result.body).toBe("# Body content\n\nSome text here.");
  });

  it("returns empty frontmatter when no --- markers", () => {
    const result = parseFrontmatter("# Just a markdown file\n\nNo frontmatter.");
    expect(result.frontmatter).toEqual({});
    expect(result.body).toBe("# Just a markdown file\n\nNo frontmatter.");
  });

  it("returns empty frontmatter when only opening --- exists", () => {
    const result = parseFrontmatter("---\nname: test\nno closing marker");
    expect(result.frontmatter).toEqual({});
    expect(result.body).toContain("name: test");
  });

  it("handles empty frontmatter block", () => {
    const result = parseFrontmatter("---\n---\n# Body");
    expect(result.frontmatter).toEqual({});
    expect(result.body).toBe("# Body");
  });

  it("handles leading whitespace before ---", () => {
    const result = parseFrontmatter(`  ---
name: Agent
---
Body text`);

    expect(result.frontmatter.name).toBe("Agent");
    expect(result.body).toBe("Body text");
  });

  it("parses nested YAML structures", () => {
    const result = parseFrontmatter(`---
name: Agent
mcp_tools:
  - brave_search
  - obsidian
allowed_directories:
  - /home/user/dev
---
Content`);

    expect(result.frontmatter.name).toBe("Agent");
    expect(result.frontmatter.mcp_tools).toEqual(["brave_search", "obsidian"]);
    expect(result.frontmatter.allowed_directories).toEqual(["/home/user/dev"]);
  });

  it("parses boolean and numeric values", () => {
    const result = parseFrontmatter(`---
can_delegate: true
can_write_files: false
max_tool_turns: 15
---
Body`);

    expect(result.frontmatter.can_delegate).toBe(true);
    expect(result.frontmatter.can_write_files).toBe(false);
    expect(result.frontmatter.max_tool_turns).toBe(15);
  });

  it("trims body content", () => {
    const result = parseFrontmatter(`---
key: value
---

  Body with whitespace

`);

    expect(result.body).toBe("Body with whitespace");
  });

  it("handles empty content", () => {
    const result = parseFrontmatter("");
    expect(result.frontmatter).toEqual({});
    expect(result.body).toBe("");
  });

  it("handles frontmatter-only content (no body)", () => {
    const result = parseFrontmatter(`---
name: Agent
---`);

    expect(result.frontmatter.name).toBe("Agent");
    expect(result.body).toBe("");
  });
});

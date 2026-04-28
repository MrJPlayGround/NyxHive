import { describe, test, expect } from "bun:test";
import { parseFrontmatter } from "../soul/frontmatter.js";

describe("parseFrontmatter", () => {
  test("parses frontmatter and body from markdown", () => {
    const input = `---
name: Forge
role: coder
---
# Forge

Engineering agent.`;
    const result = parseFrontmatter(input);
    expect(result.frontmatter).toEqual({ name: "Forge", role: "coder" });
    expect(result.body).toBe("# Forge\n\nEngineering agent.");
  });

  test("returns empty frontmatter if no delimiters", () => {
    const input = "# Just a title\n\nSome body text.";
    const result = parseFrontmatter(input);
    expect(result.frontmatter).toEqual({});
    expect(result.body).toBe("# Just a title\n\nSome body text.");
  });

  test("handles empty body after frontmatter", () => {
    const input = `---
merge: extend
mcp_tools:
  - search_knowledge
---`;
    const result = parseFrontmatter(input);
    expect(result.frontmatter).toEqual({ merge: "extend", mcp_tools: ["search_knowledge"] });
    expect(result.body).toBe("");
  });

  test("handles empty frontmatter with body", () => {
    const input = `---
---
# Identity

Just prose.`;
    const result = parseFrontmatter(input);
    expect(result.frontmatter).toEqual({});
    expect(result.body).toBe("# Identity\n\nJust prose.");
  });

  test("preserves markdown formatting in body", () => {
    const input = `---
name: Test
---
## Rules

- Rule one
- Rule two

## Guidelines

1. First
2. Second`;
    const result = parseFrontmatter(input);
    expect(result.body).toContain("## Rules");
    expect(result.body).toContain("- Rule one");
    expect(result.body).toContain("## Guidelines");
  });

  test("handles nested YAML arrays and booleans in frontmatter", () => {
    const input = `---
merge: extend
mcp_tools:
  - search_knowledge
  - list_proposals
allowed_directories:
  - /home/user/dev
  - /home/user/.nyxhive
can_read_files: true
can_write_files: false
---
# Tools`;
    const result = parseFrontmatter(input);
    expect(result.frontmatter.mcp_tools).toEqual(["search_knowledge", "list_proposals"]);
    expect(result.frontmatter.allowed_directories).toEqual(["/home/user/dev", "/home/user/.nyxhive"]);
    expect(result.frontmatter.can_read_files).toBe(true);
    expect(result.frontmatter.can_write_files).toBe(false);
  });
});

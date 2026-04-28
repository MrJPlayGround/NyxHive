import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { resolve } from "path";
import { loadSoulV2Directory } from "../soul/loader-v2.js";

const TEST_DIR = resolve(import.meta.dir, "../../.test-souls-v2-loader");

beforeAll(() => {
  mkdirSync(resolve(TEST_DIR, "_base"), { recursive: true });
  mkdirSync(resolve(TEST_DIR, "forge"), { recursive: true });
  mkdirSync(resolve(TEST_DIR, "analyst"), { recursive: true });

  // _base files
  writeFileSync(resolve(TEST_DIR, "_base/rules.md"), `---
---
# Rules

## You MUST
- Be direct and concise
- Deliver complete work products`);

  writeFileSync(resolve(TEST_DIR, "_base/tools.md"), `---
mcp_tools:
  - search_knowledge
  - list_proposals
allowed_directories:
  - /home/user/dev
can_read_files: true
can_write_files: true
can_run_commands: true
---`);

  writeFileSync(resolve(TEST_DIR, "_base/context.md"), `---
domains:
  - TypeScript / Bun backend
---
# Context

## Projects
- **NyxHive**: /home/user/dev/nyxhive`);

  // forge files (overrides some base)
  writeFileSync(resolve(TEST_DIR, "forge/identity.md"), `---
name: Forge
role: coder
invocation: cli
min_model: opus
default_model: opus
max_model: opus
---
# Forge

Engineering agent.`);

  writeFileSync(resolve(TEST_DIR, "forge/rules.md"), `---
merge: additive
---
# Rules

## You MUST
- Read code before changes`);

  writeFileSync(resolve(TEST_DIR, "forge/tools.md"), `---
merge: extend
mcp_tools:
  - claim_work
  - release_work
can_delegate: false
---`);

  // analyst — minimal overrides (identity + memory only)
  writeFileSync(resolve(TEST_DIR, "analyst/identity.md"), `---
name: Analyst
role: worker
invocation: sdk
min_model: haiku
default_model: sonnet
max_model: sonnet
---
# Analyst

Research agent. Evidence-first.`);

  writeFileSync(resolve(TEST_DIR, "analyst/memory.md"), `---
fresh_context: true
context_budget: 0
---`);
});

afterAll(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("loadSoulV2Directory", () => {
  test("loads agent files with _base fallback", () => {
    const result = loadSoulV2Directory(TEST_DIR, "forge");
    expect(result.agent.identity).toBeDefined();
    expect(result.agent.identity!.frontmatter.name).toBe("Forge");
    expect(result.agent.identity!.body).toContain("Engineering agent");
  });

  test("provides base files separately for merge logic", () => {
    const result = loadSoulV2Directory(TEST_DIR, "forge");
    expect(result.base.rules).toBeDefined();
    expect(result.base.rules!.body).toContain("Be direct and concise");
    expect(result.base.tools).toBeDefined();
    expect(result.base.tools!.frontmatter.mcp_tools).toContain("search_knowledge");
  });

  test("resolved files use agent when present, base when not", () => {
    const result = loadSoulV2Directory(TEST_DIR, "forge");
    // forge has rules.md — resolved uses agent's
    expect(result.resolved.rules!.frontmatter.merge).toBe("additive");
    // forge has no context.md — resolved uses _base
    expect(result.resolved.context!.body).toContain("NyxHive");
  });

  test("loads agent with minimal overrides (inherits most from base)", () => {
    const result = loadSoulV2Directory(TEST_DIR, "analyst");
    expect(result.agent.identity!.frontmatter.name).toBe("Analyst");
    // No rules.md — inherits from _base
    expect(result.resolved.rules!.body).toContain("Be direct and concise");
    // Has memory.md
    expect(result.resolved.memory!.frontmatter.fresh_context).toBe(true);
  });

  test("returns base files even for nonexistent agent", () => {
    const result = loadSoulV2Directory(TEST_DIR, "nonexistent");
    expect(result.resolved.rules).toBeDefined();
    expect(result.resolved.tools).toBeDefined();
    expect(result.agent.identity).toBeUndefined();
  });
});

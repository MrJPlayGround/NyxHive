import { describe, test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdirSync, writeFileSync, rmSync, readFileSync } from "fs";
import { resolve } from "path";
import { loadAndCompileSoul, getSoulSystemPrompt, clearSoulCache } from "../soul/runtime.js";

const ROOT = resolve(import.meta.dir, "../../.test-souls-v2-runtime");

function write(path: string, content: string) {
  writeFileSync(resolve(ROOT, path), content, "utf-8");
}

beforeAll(() => {
  rmSync(ROOT, { recursive: true, force: true });

  // --- _base (v2) ---
  mkdirSync(resolve(ROOT, "_base"), { recursive: true });

  write("_base/rules.md", `---
{}
---
## You MUST
- Log all actions
- Follow coding standards

## You MUST NOT
- Expose secrets

## Guidelines
- Prefer readability over cleverness
`);

  write("_base/tools.md", `---
mcp_tools:
  - brave_web_search
can_read_files: true
can_write_files: true
can_run_commands: true
can_delegate: true
allowed_directories:
  - /home/user/dev/nyxhive
---
`);

  write("_base/context.md", `---
domains:
  - software-engineering
---
## People
- **User** (founder) — builds NyxAI
`);

  // --- v2 agent: "alpha" ---
  mkdirSync(resolve(ROOT, "alpha"), { recursive: true });

  write("alpha/identity.md", `---
name: Alpha
role: coder
archetype: test coding agent
tone: direct
min_model: sonnet
default_model: sonnet
max_model: opus
---
# Alpha

Alpha is a test agent for runtime integration.
`);

  write("alpha/rules.md", `---
merge: additive
---
## You MUST
- Run tests before committing

## You MUST NOT
- Deploy without review
`);

  write("alpha/tools.md", `---
can_delegate: false
---
`);

  // --- v1 YAML: "beta" ---
  write("base.yaml", `
rules:
  must:
    - Follow base rules
`);

  write("instance.yaml", `
identity:
  name: Instance
`);

  write("beta.yaml", `
identity:
  name: Beta
  role: worker
model_capabilities:
  min_model: haiku
  default_model: haiku
  max_model: sonnet
`);

  // --- Both formats for "gamma": v2 dir + v1 YAML ---
  mkdirSync(resolve(ROOT, "gamma"), { recursive: true });

  write("gamma/identity.md", `---
name: GammaV2
role: coder
default_model: sonnet
max_model: opus
---
# GammaV2

Gamma via v2 format.
`);

  write("gamma.yaml", `
identity:
  name: GammaV1
  role: worker
model_capabilities:
  default_model: haiku
  max_model: haiku
`);
});

afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true });
});

beforeEach(() => {
  clearSoulCache();
});

describe("soul v2 runtime integration", () => {
  test("loads v2 directory format when directory exists", () => {
    const soul = loadAndCompileSoul("alpha", ROOT);
    expect(soul).toBeDefined();
    expect(soul!.identity.name).toBe("Alpha");
    expect(soul!.identity.role).toBe("coder");
    expect(soul!.identity.archetype).toBe("test coding agent");
  });

  test("v2 agent has inherited _base rules (additive merge)", () => {
    const soul = loadAndCompileSoul("alpha", ROOT);
    expect(soul).toBeDefined();

    const mustRules = soul!.rules.must.map((r) => r.rule);
    // From _base
    expect(mustRules).toContain("Log all actions");
    expect(mustRules).toContain("Follow coding standards");
    // From agent
    expect(mustRules).toContain("Run tests before committing");

    const mustNotRules = soul!.rules.must_not.map((r) => r.rule);
    // From _base
    expect(mustNotRules).toContain("Expose secrets");
    // From agent
    expect(mustNotRules).toContain("Deploy without review");
  });

  test("falls back to v1 YAML when no directory exists", () => {
    const soul = loadAndCompileSoul("beta", ROOT);
    expect(soul).toBeDefined();
    expect(soul!.identity.name).toBe("Beta");
    expect(soul!.identity.role).toBe("worker");
    expect(soul!.model_capabilities.default_model).toBe("haiku");
  });

  test("v2 directory takes precedence over v1 YAML", () => {
    const soul = loadAndCompileSoul("gamma", ROOT);
    expect(soul).toBeDefined();
    // v2 has "GammaV2", v1 has "GammaV1" — v2 should win
    expect(soul!.identity.name).toBe("GammaV2");
    expect(soul!.identity.role).toBe("coder");
    expect(soul!.model_capabilities.default_model).toBe("sonnet");
  });

  test("returns undefined for agent with neither directory nor YAML", () => {
    const soul = loadAndCompileSoul("nonexistent", ROOT);
    expect(soul).toBeUndefined();
  });

  test("caches v2 soul (second call uses cache)", () => {
    const first = loadAndCompileSoul("alpha", ROOT);
    const second = loadAndCompileSoul("alpha", ROOT);
    // Same object reference means cache hit
    expect(first).toBe(second);
  });

  test("invalidates v2 cache when _base files change", () => {
    const first = loadAndCompileSoul("alpha", ROOT);
    const original = readFileSync(resolve(ROOT, "_base/rules.md"), "utf-8");
    write("_base/rules.md", `${original}\n## Guidelines\n- Rebuild after base change\n`);
    const second = loadAndCompileSoul("alpha", ROOT);
    expect(second).not.toBe(first);
    expect(second?.rules.guidelines).toContain("Rebuild after base change");
  });

  test("invalidates v1 cache when instance layer changes", () => {
    const first = loadAndCompileSoul("beta", ROOT, ROOT);
    write("instance.yaml", `
identity:
  name: Instance Updated
rules:
  must:
    - Use the updated instance layer
`);
    const second = loadAndCompileSoul("beta", ROOT, ROOT);
    expect(second).not.toBe(first);
    expect(second?.rules.must.map((rule) => rule.rule)).toContain("Use the updated instance layer");
  });

  test("getSoulSystemPrompt works for v2 agents", () => {
    const prompt = getSoulSystemPrompt("alpha", ROOT);
    expect(prompt).toBeDefined();
    expect(prompt).toContain("You are Alpha");
    expect(prompt).toContain("test coding agent");
  });

  test("getSoulSystemPrompt works for v1 agents", () => {
    const prompt = getSoulSystemPrompt("beta", ROOT);
    expect(prompt).toBeDefined();
    expect(prompt).toContain("Beta");
  });

  test("getSoulSystemPrompt returns undefined for missing agents", () => {
    const prompt = getSoulSystemPrompt("nonexistent", ROOT);
    expect(prompt).toBeUndefined();
  });
});

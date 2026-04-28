# Skills System & Worktree Isolation — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give NyxHive agents the valuable parts of Claude Code's workflow discipline and isolate proposal execution in git worktrees.

**Architecture:** Skills live in `skills/` as SKILL.md files (superpowers format). CLI agents get them via a `.claude-plugin/plugin.json` in their workspace. Non-Claude backends get the same skill content injected into the prompt. Worktrees are managed by a new `src/agents/worktree.ts` module, integrated into the proposal executor via `cwdOverride`.

**Tech Stack:** TypeScript / Bun, git CLI for worktrees, fs for skill loading. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-03-14-skills-and-worktrees-design.md`

---

## Migration Call

This plan is for selective Claude Code migration, not platform duplication.

**Bring over:**
- Skills and workflow prompts (`using-skills`, `verify`, `debug`, `test-suite`, `evolve`, `propose`)
- Repo-local instruction surfaces that improve execution quality in local sessions
- Lightweight lead-agent parity where it strengthens coding behavior

**Keep in NyxHive:**
- Routing, queueing, claims, approvals, scheduler state
- Persistent memory, thread/session management, channel integrations
- Autonomous browser behavior and any cross-channel agent coordination

Implementation rule: define workflows once in NyxHive, then project them into Claude Code and other backends as needed.

---

## Chunk 1: Skill Loader & Plugin Infrastructure

### Task 1: Add `skills` field to AgentConfig

**Files:**
- Modify: `src/types.ts:8-32` (AgentConfig interface)

- [ ] **Step 1: Write the failing test**

Create test file for skill loader (we'll add the loader in Task 2, but start with the type):

```typescript
// src/__tests__/skill-loader.test.ts
import { describe, it, expect } from "bun:test";
import type { AgentConfig } from "../types.js";

describe("AgentConfig skills field", () => {
  it("accepts optional skills array", () => {
    const config: AgentConfig = {
      name: "Test",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      working_directory: "./workspace/test",
      skills: ["verify", "debug"],
    };
    expect(config.skills).toEqual(["verify", "debug"]);
  });

  it("allows omitting skills (defaults to all)", () => {
    const config: AgentConfig = {
      name: "Test",
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      working_directory: "./workspace/test",
    };
    expect(config.skills).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/user/dev/nyxhive && bun test src/__tests__/skill-loader.test.ts`
Expected: FAIL — `skills` doesn't exist on `AgentConfig`

- [ ] **Step 3: Add skills field to AgentConfig**

In `src/types.ts`, add to the `AgentConfig` interface after `effort`:

```typescript
  skills?: string[];             // Available skills for this agent. Omit = all skills.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/user/dev/nyxhive && bun test src/__tests__/skill-loader.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /home/user/dev/nyxhive && git add src/types.ts src/__tests__/skill-loader.test.ts && git commit -m "feat: add skills field to AgentConfig"
```

---

### Task 2: Create skill-loader.ts

**Files:**
- Create: `src/agents/skill-loader.ts`
- Modify: `src/__tests__/skill-loader.test.ts`

- [ ] **Step 1: Create test skills for testing**

Create minimal test skill files:

```bash
mkdir -p /home/user/dev/nyxhive/skills/verify
mkdir -p /home/user/dev/nyxhive/skills/debug
```

`skills/verify/SKILL.md`:
```markdown
---
name: verify
description: Use when about to claim work is complete - pre-completion verification checklist
---

# Verification Before Completion

## The Rule
Before claiming any work is done, verify it actually works.

## Checklist
1. Run `bunx tsc --noEmit` — all types check
2. Run `bun test` — all tests pass
3. Check git diff — only intended changes present
4. No TODO/FIXME left behind from this session
```

`skills/debug/SKILL.md`:
```markdown
---
name: debug
description: Use when encountering bugs or test failures - systematic debugging with NyxHive patterns
---

# Systematic Debugging

## The Rule
Complete root cause investigation before proposing a fix.

## Process
1. Reproduce the failure with exact error output
2. Trace from symptom to root cause — don't guess
3. Check all call sites (incomplete call-site fix pattern)
4. Fix and verify — run full test suite, not just the failing test
```

- [ ] **Step 2: Write failing tests for skill-loader**

Add to `src/__tests__/skill-loader.test.ts`:

```typescript
import { loadSkillContent, listAvailableSkills, getSkillsDir } from "../agents/skill-loader.js";

describe("skill-loader", () => {
  it("getSkillsDir returns the skills directory path", () => {
    const dir = getSkillsDir();
    expect(dir).toEndWith("/skills");
  });

  it("listAvailableSkills returns skill names from the skills directory", () => {
    const skills = listAvailableSkills();
    expect(skills).toContain("verify");
    expect(skills).toContain("debug");
  });

  it("loadSkillContent reads SKILL.md for a named skill", () => {
    const content = loadSkillContent("verify");
    expect(content).toContain("Verification Before Completion");
    expect(content).toContain("name: verify");
  });

  it("loadSkillContent returns null for nonexistent skill", () => {
    const content = loadSkillContent("nonexistent-skill-xyz");
    expect(content).toBeNull();
  });

  it("loadSkillContent works with multiple skills", () => {
    const verify = loadSkillContent("verify");
    const debug = loadSkillContent("debug");
    expect(verify).not.toBeNull();
    expect(debug).not.toBeNull();
    expect(verify).not.toBe(debug);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd /home/user/dev/nyxhive && bun test src/__tests__/skill-loader.test.ts`
Expected: FAIL — module not found

- [ ] **Step 4: Implement skill-loader.ts**

```typescript
// src/agents/skill-loader.ts
import { readdirSync, readFileSync, existsSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Get the absolute path to the skills directory (repo root / skills/) */
export function getSkillsDir(): string {
  // Walk up from src/agents/ to repo root
  return resolve(__dirname, "../../skills");
}

/** List all available skill names (directory names under skills/) */
export function listAvailableSkills(): string[] {
  const skillsDir = getSkillsDir();
  if (!existsSync(skillsDir)) return [];

  return readdirSync(skillsDir, { withFileTypes: true })
    .filter(d => d.isDirectory() && existsSync(resolve(skillsDir, d.name, "SKILL.md")))
    .map(d => d.name);
}

/** Load the SKILL.md content for a named skill. Returns null if not found. */
export function loadSkillContent(skillName: string): string | null {
  const skillPath = resolve(getSkillsDir(), skillName, "SKILL.md");
  if (!existsSync(skillPath)) return null;

  try {
    return readFileSync(skillPath, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Load all skill content for an agent, filtered by their configured skills.
 * If agentSkills is undefined, loads all available skills.
 */
export function loadAgentSkills(agentSkills?: string[]): string {
  const available = listAvailableSkills();
  const toLoad = agentSkills
    ? available.filter(s => agentSkills.includes(s))
    : available;

  const parts: string[] = [];
  for (const name of toLoad) {
    const content = loadSkillContent(name);
    if (content) {
      parts.push(`\n--- SKILL: ${name} ---\n${content}\n--- END SKILL ---\n`);
    }
  }
  return parts.join("\n");
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /home/user/dev/nyxhive && bun test src/__tests__/skill-loader.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
cd /home/user/dev/nyxhive && git add src/agents/skill-loader.ts src/__tests__/skill-loader.test.ts skills/verify/SKILL.md skills/debug/SKILL.md && git commit -m "feat: add skill-loader module and initial skills"
```

---

### Task 3: Plugin generation in ensureWorkspace

**Files:**
- Modify: `src/agents/workspace.ts:38-64`
- Modify: `src/__tests__/skill-loader.test.ts` (add workspace plugin tests)

- [ ] **Step 1: Write failing test**

Add to `src/__tests__/skill-loader.test.ts`:

```typescript
import { mkdirSync, existsSync, readFileSync, rmSync } from "fs";
import { resolve } from "path";
import { generatePluginJson } from "../agents/skill-loader.js";

describe("plugin generation", () => {
  const tmpDir = resolve("/tmp", `nyxhive-test-plugin-${Date.now()}`);

  afterAll(() => {
    try { rmSync(tmpDir, { recursive: true }); } catch {}
  });

  it("generatePluginJson creates .claude-plugin/plugin.json with absolute skills path", () => {
    mkdirSync(tmpDir, { recursive: true });
    generatePluginJson(tmpDir);

    const pluginPath = resolve(tmpDir, ".claude-plugin", "plugin.json");
    expect(existsSync(pluginPath)).toBe(true);

    const plugin = JSON.parse(readFileSync(pluginPath, "utf-8"));
    expect(plugin.name).toBe("nyxhive-skills");
    expect(plugin.skills).toEndWith("/skills/");
    expect(plugin.skills.startsWith("/")).toBe(true); // absolute path
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd /home/user/dev/nyxhive && bun test src/__tests__/skill-loader.test.ts`
Expected: FAIL — `generatePluginJson` doesn't exist

- [ ] **Step 3: Add generatePluginJson to skill-loader.ts**

Add to `src/agents/skill-loader.ts`:

```typescript
import { mkdirSync, writeFileSync } from "fs";

/** Generate .claude-plugin/plugin.json in a target directory */
export function generatePluginJson(targetDir: string): void {
  const pluginDir = resolve(targetDir, ".claude-plugin");
  mkdirSync(pluginDir, { recursive: true });

  const pluginJson = {
    name: "nyxhive-skills",
    description: "NyxHive agent skills — structured workflows for agent tasks",
    skills: getSkillsDir() + "/",
  };

  writeFileSync(
    resolve(pluginDir, "plugin.json"),
    JSON.stringify(pluginJson, null, 2),
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd /home/user/dev/nyxhive && bun test src/__tests__/skill-loader.test.ts`
Expected: PASS

- [ ] **Step 5: Integrate into ensureWorkspace**

In `src/agents/workspace.ts`, add after the `.claude/settings.json` block (after line 63):

```typescript
import { generatePluginJson } from "./skill-loader.js";

// Inside ensureWorkspace(), after the settings.json block:

  // .claude-plugin/plugin.json — skills plugin (regenerated on every boot, CLI agents only)
  if (isCoder) {
    generatePluginJson(workDir);
    logger.debug(`[workspace] Updated .claude-plugin/plugin.json in ${workDir}`);
  }
```

- [ ] **Step 6: Run full test suite**

Run: `cd /home/user/dev/nyxhive && bun test`
Expected: All tests PASS

- [ ] **Step 7: Commit**

```bash
cd /home/user/dev/nyxhive && git add src/agents/workspace.ts src/agents/skill-loader.ts src/__tests__/skill-loader.test.ts && git commit -m "feat: generate .claude-plugin/plugin.json in agent workspaces"
```

---

### Task 4: Skill injection for non-Claude backends

**Files:**
- Modify: `src/agents/invoke-cli.ts` (codex system prompt building)
- Modify: `src/agents/invoke-codex.ts` (codex invoke — system prompt)
- Modify: `src/agents/invoke.ts` (InvokeOpts — add skills to opts)

The `appendPrompt` variable in invoke-cli.ts is Claude-specific (used with `--append-system-prompt`). For Codex, skill content must be appended to the system prompt string. For OpenCode, it goes into the opencode config's system prompt. Each backend has its own prompt construction path.

- [ ] **Step 1: Write failing test**

Add to `src/__tests__/skill-loader.test.ts`:

```typescript
import { loadAgentSkills } from "../agents/skill-loader.js";

describe("loadAgentSkills", () => {
  it("loads all skills when no filter", () => {
    const content = loadAgentSkills();
    expect(content).toContain("SKILL: verify");
    expect(content).toContain("SKILL: debug");
  });

  it("loads only filtered skills", () => {
    const content = loadAgentSkills(["verify"]);
    expect(content).toContain("SKILL: verify");
    expect(content).not.toContain("SKILL: debug");
  });

  it("returns empty string for empty filter", () => {
    const content = loadAgentSkills([]);
    expect(content).toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it passes** (already implemented in Task 2)

Run: `cd /home/user/dev/nyxhive && bun test src/__tests__/skill-loader.test.ts`
Expected: PASS

- [ ] **Step 3: Integrate skill injection into invoke-codex.ts**

In `src/agents/invoke-codex.ts`, find where `systemPrompt` is built (around line 734). After the existing system prompt construction, append skill content:

```typescript
import { loadAgentSkills } from "./skill-loader.js";

// After systemPrompt is constructed:
if (agent.skills?.length) {
  const skillContent = loadAgentSkills(agent.skills);
  if (skillContent) {
    systemPrompt += `\n\n# Available Skills\n${skillContent}`;
  }
}
```

- [ ] **Step 4: Integrate skill injection into invoke-cli.ts for OpenCode path**

In `src/agents/invoke-cli.ts`, find the OpenCode config generation (function `invokeOpenCode`, around line 1110). Skills should be appended to the system prompt used in the OpenCode config:

```typescript
import { loadAgentSkills } from "./skill-loader.js";

// In the opencode system prompt construction:
if (agent.skills?.length) {
  const skillContent = loadAgentSkills(agent.skills);
  if (skillContent) {
    systemPrompt += `\n\n# Available Skills\n${skillContent}`;
  }
}
```

- [ ] **Step 5: Run full test suite**

Run: `cd /home/user/dev/nyxhive && bun test`
Expected: All tests PASS

- [ ] **Step 6: Commit**

```bash
cd /home/user/dev/nyxhive && git add src/agents/invoke-cli.ts src/agents/invoke-codex.ts src/agents/skill-loader.ts src/__tests__/skill-loader.test.ts && git commit -m "feat: inject skills into Codex and OpenCode system prompts"
```

---

## Chunk 2: Worktree Module

### Task 5: Create worktree.ts — core functions

**Files:**
- Create: `src/agents/worktree.ts`
- Create: `src/__tests__/worktree.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/__tests__/worktree.test.ts
import { describe, it, expect, afterAll } from "bun:test";
import { createWorktree, cleanupWorktree, listWorktrees, type WorktreeEntry } from "../agents/worktree.js";
import { mkdirSync, existsSync } from "fs";

// Create a temp git repo for testing
const testRepoDir = `/tmp/nyxhive-wt-test-${Date.now()}`;

function initTestRepo(): void {
  mkdirSync(testRepoDir, { recursive: true });
  Bun.spawnSync(["git", "init"], { cwd: testRepoDir });
  Bun.spawnSync(["git", "commit", "--allow-empty", "-m", "init"], { cwd: testRepoDir });
}

afterAll(() => {
  // Clean up all worktrees before removing repo
  const worktrees = listWorktrees(testRepoDir);
  for (const wt of worktrees) {
    if (wt.path !== testRepoDir) {
      Bun.spawnSync(["git", "worktree", "remove", "--force", wt.path], { cwd: testRepoDir });
    }
  }
  try { Bun.spawnSync(["rm", "-rf", testRepoDir]); } catch {}
});

describe("worktree", () => {
  initTestRepo();

  it("createWorktree creates a worktree at /tmp path with branch", () => {
    const result = createWorktree(testRepoDir, "proposal/test-123");
    expect(result).not.toBeNull();
    expect(result!.path).toStartWith("/tmp/nyxhive-wt-");
    expect(result!.branch).toBe("proposal/test-123");
    expect(existsSync(result!.path)).toBe(true);

    // Clean up
    cleanupWorktree(testRepoDir, result!.path, result!.branch);
  });

  it("listWorktrees includes the new worktree", () => {
    const result = createWorktree(testRepoDir, "proposal/list-test");
    const worktrees = listWorktrees(testRepoDir);
    const found = worktrees.find(w => w.branch === "refs/heads/proposal/list-test");
    expect(found).toBeDefined();

    cleanupWorktree(testRepoDir, result!.path, result!.branch);
  });

  it("cleanupWorktree removes worktree and branch", () => {
    const result = createWorktree(testRepoDir, "proposal/cleanup-test");
    expect(existsSync(result!.path)).toBe(true);

    const cleanup = cleanupWorktree(testRepoDir, result!.path, result!.branch);
    expect(cleanup.ok).toBe(true);
    expect(existsSync(result!.path)).toBe(false);
  });

  it("createWorktree returns null if branch already exists", () => {
    const first = createWorktree(testRepoDir, "proposal/dup-test");
    const second = createWorktree(testRepoDir, "proposal/dup-test");
    expect(second).toBeNull();

    cleanupWorktree(testRepoDir, first!.path, first!.branch);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /home/user/dev/nyxhive && bun test src/__tests__/worktree.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement worktree.ts**

```typescript
// src/agents/worktree.ts
import { existsSync } from "fs";
import { logger } from "../utils/logger.js";

export type WorktreeEntry = {
  path: string;
  branch: string | null;
};

export interface WorktreeResult {
  path: string;
  branch: string;
}

/** Create a git worktree with a new branch. Returns null on failure. */
export function createWorktree(repoPath: string, branchName: string): WorktreeResult | null {
  // Sanitize branch for filesystem: proposal/abc123 → abc123
  const shortId = branchName.replace(/\//g, "-");
  const worktreePath = `/tmp/nyxhive-wt-${shortId}-${Date.now()}`;

  const result = Bun.spawnSync(
    ["git", "worktree", "add", "-b", branchName, worktreePath, "HEAD"],
    { cwd: repoPath },
  );

  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString().trim();
    logger.error(`[worktree] Failed to create worktree ${branchName}: ${stderr}`);
    return null;
  }

  logger.info(`[worktree] Created worktree at ${worktreePath} on branch ${branchName}`);
  return { path: worktreePath, branch: branchName };
}

/** Remove a worktree and delete its branch. */
export function cleanupWorktree(
  repoPath: string,
  worktreePath: string,
  branch: string,
): { ok: boolean; error?: string } {
  // Remove the worktree
  if (existsSync(worktreePath)) {
    const removeResult = Bun.spawnSync(
      ["git", "worktree", "remove", "--force", worktreePath],
      { cwd: repoPath },
    );
    if (removeResult.exitCode !== 0) {
      const err = removeResult.stderr.toString().trim();
      return { ok: false, error: `Failed to remove worktree: ${err}` };
    }
  }

  // Delete the branch
  const deleteBranch = Bun.spawnSync(
    ["git", "branch", "-D", branch],
    { cwd: repoPath },
  );
  if (deleteBranch.exitCode !== 0) {
    const stderr = deleteBranch.stderr.toString().trim();
    if (!stderr.includes("not found")) {
      return { ok: false, error: `Failed to delete branch: ${stderr}` };
    }
  }

  logger.info(`[worktree] Cleaned up worktree ${worktreePath} and branch ${branch}`);
  return { ok: true };
}

/** List all worktrees for a repo. */
export function listWorktrees(repoPath: string): WorktreeEntry[] {
  const result = Bun.spawnSync(
    ["git", "worktree", "list", "--porcelain"],
    { cwd: repoPath },
  );
  if (result.exitCode !== 0) return [];

  const entries: WorktreeEntry[] = [];
  let current: WorktreeEntry | null = null;

  for (const line of result.stdout.toString().split("\n")) {
    if (!line.trim()) {
      if (current) entries.push(current);
      current = null;
      continue;
    }
    if (line.startsWith("worktree ")) {
      if (current) entries.push(current);
      current = { path: line.slice("worktree ".length), branch: null };
      continue;
    }
    if (line.startsWith("branch ") && current) {
      current.branch = line.slice("branch ".length);
    }
  }
  if (current) entries.push(current);
  return entries;
}

/** Clean up stale worktrees from /tmp. Run at startup. */
export function cleanupStaleWorktrees(repoPath: string, activeProposalIds?: Set<string>): void {
  const worktrees = listWorktrees(repoPath);
  for (const wt of worktrees) {
    if (!wt.path.startsWith("/tmp/nyxhive-wt-")) continue;

    // Check if this worktree is associated with an active proposal
    if (activeProposalIds && wt.branch) {
      const branchShort = wt.branch.replace("refs/heads/", "");
      const proposalId = `proposal-${branchShort.replace("proposal/", "")}`;
      if (activeProposalIds.has(proposalId)) continue;
    }

    logger.info(`[worktree] Cleaning up stale worktree: ${wt.path}`);
    const branch = wt.branch?.replace("refs/heads/", "");
    cleanupWorktree(repoPath, wt.path, branch ?? "");
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /home/user/dev/nyxhive && bun test src/__tests__/worktree.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
cd /home/user/dev/nyxhive && git add src/agents/worktree.ts src/__tests__/worktree.test.ts && git commit -m "feat: add worktree module for isolated agent execution"
```

---

### Task 6: Migrate pr-utils worktree functions to worktree.ts

**Files:**
- Modify: `src/proposals/pr-utils.ts:85-138`
- Modify: `src/agents/worktree.ts` (verify exports match)

- [ ] **Step 1: Update pr-utils to import from worktree.ts**

In `src/proposals/pr-utils.ts`:

1. Remove the local `listWorktrees` function (lines 85-113) and `WorktreeEntry` type (lines 23-26)
2. Remove the `cleanupProposalBranchWorktree` function (lines 115-138)
3. Import from worktree.ts instead:

```typescript
import { listWorktrees, cleanupWorktree, type WorktreeEntry } from "../agents/worktree.js";

/** Clean up worktree and branch for a proposal. Wraps worktree.cleanupWorktree. */
export function cleanupProposalBranchWorktree(branch: string, repoPath: string): string | null {
  const ref = `refs/heads/${branch}`;
  const worktrees = listWorktrees(repoPath);

  for (const wt of worktrees) {
    if (wt.branch !== ref) continue;
    const result = cleanupWorktree(repoPath, wt.path, branch);
    if (!result.ok) return result.error ?? `Failed to clean up worktree for ${branch}`;
    return null;
  }

  // No worktree found, just try to delete the branch
  const result = cleanupWorktree(repoPath, "", branch);
  if (!result.ok) return result.error ?? `Failed to delete branch ${branch}`;
  return null;
}
```

- [ ] **Step 2: Run tests to verify nothing breaks**

Run: `cd /home/user/dev/nyxhive && bun test`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
cd /home/user/dev/nyxhive && git add src/proposals/pr-utils.ts src/agents/worktree.ts && git commit -m "refactor: consolidate worktree code into src/agents/worktree.ts"
```

---

## Chunk 3: Executor Integration & Skill Content

### Task 7: Add cwdOverride to processImmediate and executor

**Files:**
- Modify: `src/proposals/executor.ts:35-38` (ExecutorContext interface)
- Modify: `src/proposals/executor.ts:134-162` (executeProposal)
- Modify: `src/queue/processor.ts:1644-1656` (processImmediate signature)

- [ ] **Step 1: Add cwdOverride to ExecutorContext.processImmediate**

In `src/proposals/executor.ts`, update the `ExecutorContext` interface:

```typescript
export interface ExecutorContext {
  processImmediate: (opts: {
    channel: string; sender: string; message: string; agent: string;
    cwdOverride?: string;  // Worktree path for isolated execution
  }) => Promise<{ response: string; agent: string }>;
  // ... rest unchanged
}
```

- [ ] **Step 2: Add cwdOverride to QueueProcessor.processImmediate**

In `src/queue/processor.ts`:

1. Add `cwdOverride?: string` to the processImmediate opts parameter at line 1644
2. Find the `invokeAgent()` call at line 1916-1939. This is an inline object literal passed directly to invokeAgent (there is NO `invokeOpts` variable). Add `cwdOverride: opts.cwdOverride,` to this object, after the `baseDir` field:

```typescript
// At processor.ts line 1916:
invokeAgent(effectiveConfig, route.strippedMessage, {
  baseDir: this.config.baseDir,
  cwdOverride: opts.cwdOverride,  // <-- ADD THIS LINE
  systemPrompt: systemPromptResult.prompt,
  // ... rest unchanged
})
```

- [ ] **Step 3: Update executor to use worktrees**

In `src/proposals/executor.ts`, update `executeProposal()`:

```typescript
import { createWorktree, cleanupWorktree, type WorktreeResult } from "../agents/worktree.js";
import { generatePluginJson } from "../agents/skill-loader.js";

// In executeProposal(), replace the taskMessage construction (around line 155):

      // Create worktree for isolated execution
      let worktree: WorktreeResult | null = null;
      try {
        worktree = createWorktree(repoPath, branch);
      } catch (err) {
        logger.warn(`[executor] Failed to create worktree for ${proposalId}, falling back to prompt-based branching: ${err}`);
      }

      // Install skills plugin in worktree
      if (worktree) {
        generatePluginJson(worktree.path);
      }

      const workingDir = worktree?.path ?? repoPath;
      const gitInstructions = worktree
        ? `## Git Workflow
Working in isolated worktree at: ${worktree.path}
Branch: ${branch}

1. Make the changes
2. Run \`bunx tsc --noEmit\` — fix ALL type errors
3. Run \`bun test\` — fix ALL test failures
4. Commit (feat/fix/chore as appropriate)
5. git push -u origin ${branch}

CRITICAL: Do NOT push if tests or type check fail.`
        : `## Git Workflow — follow these steps exactly:
1. cd ${repoPath}
2. git checkout main || git checkout master && git pull
3. git checkout -b ${branch}
4. Make the changes
5. Run \`bunx tsc --noEmit\` — fix ALL type errors
6. Run \`bun test\` — fix ALL test failures
7. Commit (feat/fix/chore as appropriate)
8. git push -u origin ${branch}
9. gh pr create --title "${proposal.title}" --body "Implements proposal ${proposal.proposal_id}"

CRITICAL: Do NOT push if tests or type check fail. Do NOT merge the PR.`;

      const taskMessage = `[Executing proposal ${proposal.proposal_id}]\n\n${proposal.description}\n\n${filesInfo}${patternsContext}\n\n${gitInstructions}`;

      let result = await this.ctx.processImmediate({
        channel: "system",
        sender: "proposal-executor",
        message: taskMessage,
        agent,
        cwdOverride: workingDir,
      });
```

**IMPORTANT:** Also find the retry `processImmediate` call (around line 178, inside the review gate retry block) and add `cwdOverride: workingDir` there too:

```typescript
          result = await this.ctx.processImmediate({
            channel: "system",
            sender: "proposal-executor",
            message: retryMessage,
            agent,
            cwdOverride: workingDir,  // <-- MUST also pass here for retry
          });
```

Both calls must use `workingDir` — otherwise the retry executes in the default workspace instead of the worktree.

Also update the catch block to clean up worktrees on failure. The `worktree` variable must be declared BEFORE the `try` block so it's accessible in `catch`:

```typescript
      // Declare before try so catch can access it
      let worktree: WorktreeResult | null = null;

      try {
        // ... existing code ...
        worktree = createWorktree(repoPath, branch);
        // ... rest of try ...
      } catch (err) {
        logger.error(`[executor] Failed ${proposalId}: ${err}`);
        this.store.markFailed(proposalId, String(err), "proposal-executor");

        // Clean up worktree on failure
        if (worktree) {
          cleanupWorktree(repoPath, worktree.path, worktree.branch);
        }

        // ... existing outcome recording
      } finally {
        this.activeCount--;
```

- [ ] **Step 4: Run full test suite**

Run: `cd /home/user/dev/nyxhive && bun test`
Expected: All tests PASS

- [ ] **Step 5: Type check**

Run: `cd /home/user/dev/nyxhive && bunx tsc --noEmit`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
cd /home/user/dev/nyxhive && git add src/proposals/executor.ts src/queue/processor.ts && git commit -m "feat: integrate worktree isolation into proposal executor"
```

---

### Task 8: Plugin generation for cwdOverride targets

**Files:**
- Modify: `src/agents/invoke-cli.ts:306-308`

- [ ] **Step 1: Add plugin generation when cwdOverride is used**

In `src/agents/invoke-cli.ts`, after line 308 where `workDir` is resolved:

```typescript
import { generatePluginJson } from "./skill-loader.js";

  // Ensure skills plugin exists in the working directory (for cwdOverride scenarios)
  if (workDir !== workspace && cli === "claude") {
    generatePluginJson(workDir);
  }
```

- [ ] **Step 2: Run full test suite**

Run: `cd /home/user/dev/nyxhive && bun test`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
cd /home/user/dev/nyxhive && git add src/agents/invoke-cli.ts && git commit -m "feat: install skills plugin in cwdOverride directories for CLI agents"
```

---

### Task 9: Create remaining skill files

**Files:**
- Create: `skills/using-skills/SKILL.md`
- Create: `skills/evolve/SKILL.md`
- Create: `skills/propose/SKILL.md`
- Create: `skills/test-suite/SKILL.md`

- [ ] **Step 1: Create using-skills meta-skill**

`skills/using-skills/SKILL.md` — this is the meta-skill that teaches agents how to find and use skills:

```markdown
---
name: using-skills
description: Use at the start of every task - teaches how to find and invoke relevant skills before acting
---

# Using Skills

You have access to NyxHive skills — structured workflows for common tasks. Before starting work, check if a relevant skill exists.

## Available Skills

Use the `Skill` tool to invoke any of these:

| Skill | When to use |
|-------|-------------|
| `verify` | Before claiming work is complete — run verification checklist |
| `debug` | When encountering bugs or test failures — systematic root cause analysis |
| `evolve` | When running evolution scans — audit, find bugs, create proposals |
| `propose` | When creating proposals — structure, priority, success criteria |
| `test-suite` | When running or analyzing tests — execution, failure analysis, coverage |

## The Rule

If a skill applies to your current task, invoke it BEFORE starting work. Even if you think the task is simple enough to skip — use the skill. Skills prevent common mistakes and ensure consistent quality.

## How

1. Read the task
2. Check if any skill above matches
3. Invoke via `Skill` tool: `Skill(skill: "verify")`
4. Follow the skill's process
```

- [ ] **Step 2: Create evolve skill**

`skills/evolve/SKILL.md`:

```markdown
---
name: evolve
description: Use when running evolution scans - systematic codebase audit, bug finding, and proposal creation
---

# Evolution Scan

Systematic codebase audit to find bugs, dead code, and improvement opportunities.

## Process

1. **Audit the test suite**
   - Run `bun test` — record pass/fail counts
   - Note any flaky or skipped tests

2. **Check working tree**
   - Run `git status` — note uncommitted changes (may be User's in-progress work, leave alone)
   - Run `git log --oneline -10` — understand recent work

3. **Scan for issues**
   - Focus on recently changed files (`git diff --name-only HEAD~10`)
   - Look for: unchecked errors, race conditions, dead code, missing null checks
   - Check for incomplete call-site fixes (common pattern — see patterns.md)
   - Check rate limiters fire on start, not on success

4. **Create proposals**
   - Use `[@propose:]` tag for each finding
   - Include: title, category, priority (high/medium/low), effort (small/medium/large)
   - Include: description, files_affected, success criteria
   - One proposal per issue — don't bundle

5. **Verify findings before proposing**
   - Always check if the "bug" is actually guarded elsewhere
   - Check if tests already cover the scenario
   - Don't propose things that aren't real

## Anti-patterns
- Proposing refactors as bugs
- Not verifying agent findings before proposing
- Auto-classifying features as maintenance to bypass approval
- Bundling multiple issues into one proposal
```

- [ ] **Step 3: Create propose skill**

`skills/propose/SKILL.md`:

```markdown
---
name: propose
description: Use when creating proposals - ensures proper structure, priority assessment, and success criteria
---

# Creating Proposals

## Format

Use the `[@propose:]` action tag:

```
[@propose: {
  "title": "Short descriptive title",
  "category": "bugfix|feature|refactor|test|security|performance",
  "priority": "high|medium|low",
  "effort": "small|medium|large",
  "description": "What the issue is and how to fix it",
  "files_affected": ["src/path/to/file.ts"],
  "success_criteria": ["Tests pass", "Type check clean", "Specific behavior verified"]
}]
```

## Priority Guide

- **high**: Crashes, data loss, security issues, test suite failures
- **medium**: Bugs that don't crash, dead code, performance issues
- **low**: Code quality, minor improvements, cosmetic

## Effort Guide

- **small**: < 30 min, 1-3 files, clear fix
- **medium**: 30min-2h, 3-10 files, some design needed
- **large**: 2h+, 10+ files, significant design

## Rules

- One issue per proposal
- Always include files_affected
- Always include success_criteria that are testable
- Don't auto-classify features as maintenance
- Verify the issue is real before proposing
```

- [ ] **Step 4: Create test-suite skill**

`skills/test-suite/SKILL.md`:

```markdown
---
name: test-suite
description: Use when running tests or analyzing test results - execution, failure analysis, coverage reporting
---

# Test Suite Management

## Running Tests

```bash
bun test                              # Full suite
bun test src/__tests__/specific.test.ts  # Single file
bun test --watch                       # Watch mode
```

## Failure Analysis

When tests fail:

1. **Read the actual error** — not just "N tests failed"
2. **Check if it's a test issue or code issue** — stale assertions? Mock pollution?
3. **Check for mock.module() contamination** — NEVER use `mock.module()` for core Node modules (fs, path, crypto). Use `spyOn` with `.mockRestore()`.
4. **Check for incomplete call-site fixes** — did you fix the function but miss callers?
5. **Run the specific failing test in isolation** — does it pass alone? If so, it's test pollution.

## Common Patterns

- `spyOn` accumulates calls across tests — always `mockRestore()` in `afterEach`
- `mock.module()` is process-global and permanent in Bun — never use for core modules
- Soul config evolves faster than tests — test structure, not specific config values
- Test files mirror source modules (e.g., `delegation.test.ts` tests delegation engine)

## After Fixing

- Run the FULL suite, not just the fixed test
- Run `bunx tsc --noEmit` — type errors can hide behind test failures
```

- [ ] **Step 5: Verify all skills load correctly**

Run: `cd /home/user/dev/nyxhive && bun test src/__tests__/skill-loader.test.ts`
Expected: PASS — listAvailableSkills should now include all 6 skills

- [ ] **Step 6: Commit**

```bash
cd /home/user/dev/nyxhive && git add skills/ && git commit -m "feat: add NyxHive agent skills (using-skills, evolve, propose, test-suite)"
```

---

### Task 10: Add skills config to nyxhive.toml

**Files:**
- Modify: `config/nyxhive.toml:16-49`

- [ ] **Step 1: Add skills arrays to agent configs**

In `config/nyxhive.toml`, add `skills` to agent definitions:

For `[agents.nyx]` (after line 24):
```toml
skills = ["verify", "debug", "evolve", "propose"]
```

For `[agents.analyst]` — no skills (SDK agent, no Skill tool access)

For Tester agent if it exists:
```toml
skills = ["verify", "debug", "test-suite"]
```

- [ ] **Step 2: Run full test suite and type check**

Run: `cd /home/user/dev/nyxhive && bun test && bunx tsc --noEmit`
Expected: All PASS, no type errors

- [ ] **Step 3: Commit**

```bash
cd /home/user/dev/nyxhive && git add config/nyxhive.toml && git commit -m "feat: configure agent skills in nyxhive.toml"
```

---

### Task 11: Startup worktree cleanup

**Files:**
- Modify: `src/index.ts` (server startup)

- [ ] **Step 1: Add cleanup call at startup**

In `src/index.ts`, add the import at the top:
```typescript
import { cleanupStaleWorktrees } from "./agents/worktree.js";
```

Then add the cleanup call after the proposalStore is initialized (after line 284, before the executor is created):

```typescript
  // Clean up stale worktrees from previous runs
  const defaultProject = config.daemon.projects?.find(p => p.default) ?? config.daemon.projects?.[0];
  if (defaultProject) {
    const activeProposals = proposalStore.listByStatus("executing");
    const activeIds = new Set(activeProposals.map(p => p.proposal_id));
    cleanupStaleWorktrees(defaultProject.repo_path, activeIds);
  }
```

Note: Use `listByStatus("executing")` (or whatever method lists active proposals) rather than `listActive()` — verify the actual method name on the ProposalStore class before implementing.

- [ ] **Step 2: Run full test suite**

Run: `cd /home/user/dev/nyxhive && bun test`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
cd /home/user/dev/nyxhive && git add src/index.ts && git commit -m "feat: clean up stale worktrees on startup"
```

---

### Task 12: Final verification

- [ ] **Step 1: Run full test suite**

Run: `cd /home/user/dev/nyxhive && bun test`
Expected: All tests PASS

- [ ] **Step 2: Run type check**

Run: `cd /home/user/dev/nyxhive && bunx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Verify skills directory structure**

```bash
ls -la /home/user/dev/nyxhive/skills/*/SKILL.md
```

Expected: 6 skill files (using-skills, verify, debug, evolve, propose, test-suite)

- [ ] **Step 4: Verify plugin generation works**

```bash
# Check that agent workspaces would get plugin.json
cat /home/user/dev/nyxhive/workspace/nyx/.claude-plugin/plugin.json 2>/dev/null || echo "Will be generated on next boot"
```

- [ ] **Step 5: Final commit if any loose changes**

```bash
cd /home/user/dev/nyxhive && git status
```

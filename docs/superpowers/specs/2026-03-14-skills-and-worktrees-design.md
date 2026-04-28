# Skills System & Worktree Isolation for NyxHive Agents

**Date:** 2026-03-14
**Status:** Design
**Approach:** Selective migration — bring Claude Code's workflow discipline into NyxHive agents, but keep NyxHive's platform state and autonomy in NyxHive.

---

## Problem

NyxHive agents have no structured workflow guidance. They execute tasks based on soul instructions and system prompts, but lack the disciplined skill-based workflows (brainstorming, TDD, debugging, verification) that superpowers provides to interactive Claude Code sessions.

Additionally, proposal execution and delegated coding tasks run in the agent's main workspace — there's no isolation, so a failed task can leave dirty state.

## Goals

1. Give CLI agents access to superpowers-style skills during their sessions
2. Add NyxHive-specific skills (evolve, propose, test-suite, verify)
3. Provide skill content to non-Claude backends (Codex, OpenCode, SDK) via prompt injection
4. Enable worktree isolation for proposal execution and delegated tasks
5. Keep the NyxHive repo root clean — User uses Codex there directly, no conflicts

## Migration Boundary

This plan only migrates the parts of Claude Code that improve execution quality inside a local coding session.

| Migrate from Claude Code | Keep in NyxHive | Do not duplicate |
|--------------------------|-----------------|------------------|
| Skills and workflow prompts | Routing, queueing, and delegation state | Persistent threads/session model |
| Verification/debugging discipline | Proposal execution and review flow | Channel integrations |
| Repo-local instruction surfaces | Worktree lifecycle and task isolation | Memory graph, knowledge store, Obsidian |
| Lightweight soul/persona parity for lead agents | Agent registry, scheduler, approvals, claims | Autonomous browser as a Claude Code feature |

Claude Code is a consumer of NyxHive workflows, not a second control plane. The source of truth stays in NyxHive.

---

## Part 1: Skills System

### Skill Storage

Skills live in `nyxhive/skills/` — flat namespace, same format as superpowers:

```
nyxhive/skills/
  using-skills/SKILL.md          # Meta-skill: how agents discover and use skills
  evolve/SKILL.md                # Evolution scan workflow
  propose/SKILL.md               # Proposal creation with structure and gates
  test-suite/SKILL.md            # Run tests, analyze failures, report coverage
  verify/SKILL.md                # Pre-completion verification checklist
  debug/SKILL.md                 # Systematic debugging (NyxHive-specific patterns)
```

Each `SKILL.md` has YAML frontmatter:

```yaml
---
name: evolve
description: Use when running evolution scans - systematic codebase audit, bug finding, proposal creation
---
```

Supporting files (subagent prompts, scripts, references) go alongside `SKILL.md` in the skill directory.

### Claude Code Path (CLI Agents)

`ensureWorkspace()` gains a new step: install a Claude Code plugin in each CLI agent's workspace.

**Plugin structure** (generated per agent workspace):

```
workspace/nyx/.claude-plugin/
  plugin.json
```

```json
{
  "name": "nyxhive-skills",
  "description": "NyxHive agent skills",
  "skills": "/absolute/path/to/nyxhive/skills/"
}
```

This makes all skills available via the `Skill` tool during CLI sessions. The agent's soul or `CLAUDE.md` includes a `using-skills` bootstrap that teaches the agent how to find and use skills.

The plugin is intentionally narrow. It exposes workflow guidance and instruction scaffolding only. It does not carry NyxHive runtime state, memory, queue visibility, or orchestration logic into Claude Code.

**Scoping:** The plugin is installed in `workspace/nyx/.claude-plugin/`, NOT in the NyxHive repo root. This prevents conflicts with User's own Claude/Codex sessions at the repo level.

**cwd handling:** Claude Code discovers plugins relative to `cwd`. When `cwdOverride` is set (proposals, delegated tasks), the agent runs from the repo root, not the workspace. When worktrees are used, `cwd` is the worktree path. In both cases, the workspace plugin won't be discovered automatically.

Solution: `ensureWorkspace()` also writes `.claude-plugin/plugin.json` into the `cwdOverride` target (repo root) if one is configured. For worktrees, the worktree setup copies the plugin into the worktree directory. The plugin.json always uses an absolute path to `nyxhive/skills/`, so skill content is found regardless of where the plugin.json lives.

**Skill filtering:** All skills are always available via the plugin. The `AgentConfig.skills` field is used by the `using-skills` meta-skill to guide the agent toward relevant skills, and by the prompt injection fallback to decide which skills to inject. No per-agent filtered directories — that's unnecessary filesystem complexity.

### Codex/OpenCode/SDK Fallback Path

For non-Claude backends, NyxHive injects skill content directly into the prompt. This happens in the invoke path (`invoke.ts` or `invoke-cli.ts`):

1. A new `loadSkillContent(skillName: string): string` function reads `skills/{name}/SKILL.md`
2. Task classification determines which skills are relevant:
   - `coding` → `verify`
   - Evolution scan scheduled tasks → `evolve`
   - Proposal execution → `propose`
   - Test-related tasks → `test-suite`
3. Relevant skill content is appended to the prompt via `--append-system-prompt` (Codex/OpenCode) or injected into the SDK system prompt

This path is the canonical one. Claude Code plugin support is an ergonomic projection of the same workflows, not the primary architecture.

Agents don't get on-demand skill loading here, but they do get the same operating discipline without depending on Claude-specific runtime features.

For the prompt injection path, inject ALL skills the agent has access to (per `AgentConfig.skills`), not just the task-type-matched one. Skill content is small (frontmatter + markdown), and injecting 2-3 skills is cheaper than building a classification layer. The agent picks which to follow.

### Agent Config Extension

```typescript
// In AgentConfig (src/types.ts)
skills?: string[];  // Skills available to this agent. Omit = all skills.
```

Example in `nyxhive.toml`:

```toml
[agents.nyx]
skills = ["evolve", "propose", "verify", "debug"]

[agents.tester]
skills = ["test-suite", "verify", "debug"]
```

### Initial Skills to Create

| Skill | Purpose | Primary agents |
|-------|---------|---------------|
| `using-skills` | Meta-skill: teaches agents to check for and invoke relevant skills | All CLI agents |
| `evolve` | Evolution scan: audit codebase, find bugs, create proposals | Nyx |
| `propose` | Proposal creation: structure, priority, size, success criteria | Nyx, Tester |
| `test-suite` | Run tests, analyze failures, generate coverage reports | Tester |
| `verify` | Pre-completion checks: tests pass, types check, no regressions | Nyx, Tester |
| `debug` | Systematic debugging with NyxHive-specific patterns (references patterns.md) | Nyx, Tester |

---

## Part 2: Worktree Isolation

### When Worktrees Are Used

1. **Proposal execution** — always uses a worktree (non-negotiable isolation)
2. **Delegated coding tasks** with `shouldCommit: true` in the delegation contract
3. **Any invocation** where `AgentConfig.worktree` is `true`

### Worktree Lifecycle

```
1. Create:
   git worktree add -b proposal/{id} /tmp/nyxhive-wt-{id} HEAD

2. Invoke:
   CLI subprocess cwd = worktree path (not agent workspace)
   All --add-dir paths still valid (vault, allowed_directories)

3. On success:
   - If review gate enabled: leave worktree for review
   - If review gate passes or disabled: merge branch, remove worktree
   - Branch naming: proposal/{proposal-id} or task/{message-id}

4. On failure:
   git worktree remove /tmp/nyxhive-wt-{id}
   git branch -D proposal/{id}
```

### Implementation

**Consolidated module:** `src/agents/worktree.ts`

Consolidates with existing worktree code in `src/proposals/pr-utils.ts` (`listWorktrees()`, `cleanupProposalBranchWorktree()`). The new module becomes the single source of truth — pr-utils imports from it.

```typescript
interface WorktreeResult {
  path: string;       // Worktree directory path
  branch: string;     // Branch name
}

function createWorktree(repoPath: string, branchName: string): WorktreeResult
function mergeWorktree(repoPath: string, branch: string): { ok: boolean; error?: string }
function cleanupWorktree(repoPath: string, worktreePath: string, branch: string): { ok: boolean; error?: string }
function listWorktrees(repoPath: string): WorktreeEntry[]  // moved from pr-utils
function cleanupStaleWorktrees(repoPath: string): void      // startup scan for orphans
```

Error handling follows `pr-utils` pattern — returns error strings rather than throwing.

**Proposal executor integration:**

The proposal executor (`src/proposals/executor.ts`) already has a try/finally block (line 290) and calls `processImmediate()`. The flow:

1. Executor creates worktree via `createWorktree(repoPath, proposalBranchName(id))`
2. Passes worktree path as `cwdOverride` to `processImmediate()` — this field already exists and flows through to `invokeCLI()` (invoke-cli.ts line 308)
3. Executor's existing try/finally handles cleanup on failure
4. On success, executor handles PR creation (already does this) — worktree stays until PR is merged, then `cleanupWorktree()` runs

This replaces the current approach where the executor embeds git branch instructions in the prompt (line 155).

**Thread integration:** The `Thread` type already has `worktree_path: string | null`. When a worktree is created for a task, update the thread record so the worktree lifecycle is tracked.

**Startup cleanup:** `cleanupStaleWorktrees()` runs on NyxHive boot, scanning for `/tmp/nyxhive-wt-*` directories that aren't associated with active proposals. Prevents orphaned worktrees from accumulating after crashes.

**Config:**

Per-invocation via `InvokeOptions.useWorktree?: boolean`. No `AgentConfig.worktree` field for now — only proposal execution needs worktrees today, and the executor controls that directly. Add the config flag when there's a real use case beyond proposals.

### Worktree Location

Worktrees created at `/tmp/nyxhive-wt-{id}` by default. Short-lived, cleaned up on completion or failure. The NyxHive repo path is derived from the agent's working directory (walk up to find `.git`).

---

## Part 3: Integration Points

### ensureWorkspace() Changes

```typescript
// Existing steps:
// 1. Create workDir
// 2. Write AGENTS.md (once)
// 3. Write .claude/settings.json (once, CLI agents)
// 4. Write .claude/CLAUDE.md (every boot, soul-compiled)
// 5. Write PLATFORM.md (every boot)

// New steps:
// 6. Write .claude-plugin/plugin.json (every boot, CLI agents)
//    - Uses absolute path to nyxhive/skills/ directory
//    - Also writes plugin to cwdOverride target if configured
// 7. Append using-skills bootstrap content to CLAUDE.md
//    - Injected by renderClaudeMd() in src/soul/compiler.ts
//    - Gated on agent being CLI with skills available
//    - Lists agent's available skills (from AgentConfig.skills)
```

### invoke-cli.ts Changes

```typescript
// Before subprocess spawn:
// - If useWorktree: create worktree, set cwdOverride to worktree path
// - Copy .claude-plugin/ into worktree directory

// For non-Claude backends (Codex/OpenCode):
// - loadSkillContent() for agent's configured skills
// - Append all skill content to --append-system-prompt
```

### Types Changes

```typescript
// AgentConfig additions:
skills?: string[];    // Available skills (omit = all)

// InvokeOptions addition:
useWorktree?: boolean; // Per-invocation worktree override
```

---

## File Changes Summary

| File | Change |
|------|--------|
| `src/types.ts` | Add `skills?` to `AgentConfig`, `useWorktree?` to invoke options |
| `src/agents/workspace.ts` | Add plugin.json generation step (workspace + cwdOverride) |
| `src/agents/invoke-cli.ts` | Worktree creation/cleanup, skill injection for non-Claude, plugin copy to worktree |
| `src/agents/worktree.ts` | **New** — worktree create/merge/cleanup/list/startup-scan (consolidates pr-utils worktree code) |
| `src/proposals/pr-utils.ts` | Remove `listWorktrees()` and `cleanupProposalBranchWorktree()`, import from worktree.ts |
| `src/proposals/executor.ts` | Use worktree via `cwdOverride` instead of prompt-embedded git instructions |
| `src/agents/skill-loader.ts` | **New** — load skill content by name, task-type mapping |
| `skills/using-skills/SKILL.md` | **New** — meta-skill for agent skill discovery |
| `skills/evolve/SKILL.md` | **New** — evolution scan workflow |
| `skills/propose/SKILL.md` | **New** — proposal creation workflow |
| `skills/test-suite/SKILL.md` | **New** — test execution and analysis |
| `skills/verify/SKILL.md` | **New** — pre-completion verification |
| `skills/debug/SKILL.md` | **New** — systematic debugging for NyxHive |
| `config/nyxhive.toml` | Add `skills` arrays to agent configs |

---

## Constraints

- Plugin setup is per-agent-workspace only — never touches repo root (User uses Codex there)
- Worktree branches follow naming convention: `proposal/{id}` or `task/{id}`
- Skill content for SDK agents is injected as system prompt, not as a tool
- No new npm dependencies — uses git CLI for worktrees, fs for skill loading
- Skills directory is part of the NyxHive repo — version-controlled, same for all instances
- Instance-specific skills are out of scope — all instances share the same skill set for now
- Existing `Thread.worktree_path` field is used to track active worktrees
- Startup cleanup scans for orphaned worktrees at `/tmp/nyxhive-wt-*`

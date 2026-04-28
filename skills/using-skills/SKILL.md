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
| `search-first` | At the start of codebase work — targeted discovery before broad traversal |
| `codex-harness` | When touching Codex runtime behavior or porting Claude Code patterns |
| `bun-runtime` | When working in Bun/TypeScript packages — command and runtime defaults |
| `tdd-workflow` | When changing behavior, fixing bugs, or adding testable features |
| `security-review` | When touching auth, secrets, input boundaries, SQL, files, network, approvals, or proposal execution |
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

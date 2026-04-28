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
- Proposals are for governance decisions, not a general backlog. Use a proposal only when User must approve policy, product direction, user-facing behavior, security/auth/billing/data risk, budget/model-spend changes, protected-file work, or creating/changing a standing order or skill.
- Safe bounded work belongs in a task/direct fix/report lane. Recurring proactive work belongs in a standing order candidate. Reusable procedures belong in a skill candidate only when they replace a repeatable decision.

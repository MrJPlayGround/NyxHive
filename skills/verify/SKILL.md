---
name: verify
description: Use when about to claim work is complete - pre-completion verification checklist
---

# Verification Before Completion

## The Rule
Before claiming any work is done, verify it with fresh output from this session. Stale terminal results do not count.

## Checklist
1. Run the narrowest relevant test first when one exists.
2. Run `bun run typecheck` and confirm it exits cleanly.
3. Run `bun test` and confirm the full suite exits cleanly.
4. Run any touched package build/lint command when the package defines one.
5. Run `git diff --check` to catch whitespace damage.
6. Run `git status --short --branch` and inspect the changed files.
7. Confirm no TODO/FIXME/debug logging was left behind from this session.

## Evidence
Final responses must name the commands run and the outcome. If verification cannot run, state the exact blocker and what remains unverified.

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
   - Include: description, files_affected, success_criteria
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

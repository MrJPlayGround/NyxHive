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
- Run `bun run typecheck` — type errors can hide behind test failures

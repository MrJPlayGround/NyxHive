---
merge: additive
---
# Rules

## You MUST

- Test edge cases and error paths before the happy path
- Write tests that fail first (RED), then confirm the fix (GREEN)
- Test behavior, not implementation details
- One behavior per test — if the name has "and", split it
- Add regression tests when fixing bugs

## You MUST NOT

- Mark tests as passing without actually running them
- Use mocks when real code is available — mock only external boundaries
- Claim tests pass without showing actual test output

## Guidelines

- NyxHive test runner: bun test
- Coverage targets: happy path, null/empty, boundaries, error states

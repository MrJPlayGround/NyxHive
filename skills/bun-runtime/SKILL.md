---
name: bun-runtime
description: Use when working in Bun or TypeScript projects inside NyxHive
---

# Bun Runtime

## The Rule
NyxHive is a Bun TypeScript codebase. Use Bun-native commands and APIs unless the repo already requires another tool.

## Defaults
1. Install with `bun install` when dependencies change.
2. Run scripts with `bun run <script>`.
3. Run tests with `bun test`.
4. Use `bun x` instead of `npx`.
5. Prefer Bun built-ins and existing repo helpers over adding packages.
6. Commit lockfile changes only when dependency changes require them.

## Verification
Run `bun run typecheck` and `bun test` before claiming code changes are complete.

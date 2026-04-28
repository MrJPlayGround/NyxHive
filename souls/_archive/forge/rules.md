---
merge: additive
---
# Rules

## You MUST

- Read the relevant code before making any changes
- Run the FULL test suite (bun test) before committing — not just tests for your changes
- Run the type checker (bunx tsc --noEmit) before committing — CI will reject type errors
- Commit with conventional style (feat:, fix:, chore:) after ALL tests pass AND type check is clean
- When debugging, complete root cause investigation before proposing any fix
- End your response with a summary of what you did and the outcome
- When creating proposal PRs: branch from master, implement, test, only push if ALL tests pass

## You MUST NOT

- Use the Agent tool for exploration — use Read, Glob, Grep directly
- Over-engineer — build what's needed now, not hypothetical future requirements
- Add docstrings, comments, or error handling for code you didn't change
- Guess-and-check debug — no 'quick fix' without root cause analysis
- Push a PR without running bun test AND bunx tsc --noEmit and confirming zero failures
- Leave temporary files or cloned repos behind after completing work

## Guidelines

- Multi-project — adapt to each stack:
  - NyxHive: Bun + TypeScript, prefer built-in over npm, SQLite
  - nyx-ios: SwiftUI, Apple HIG
  - NyxLabs: React + Vite + TailwindCSS + Supabase
  - Deft Voice: Tauri + Rust + React
- Batch related edits into fewer, larger changes to control cost
- PR workflow: git checkout -b proposal/<id> -> implement -> bun test -> git push -u -> gh pr create
- If git operations are blocked, report the blocker clearly instead of retrying

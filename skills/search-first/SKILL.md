---
name: search-first
description: Use at the start of codebase work to find relevant files before broad exploration
---

# Search First

## The Rule
Start with targeted semantic search, then read the files it finds. Directory tours come after evidence, not before it.

## Workflow
1. Pick two or three keywords from the task, API name, error text, route, or feature.
2. Run `rg` or `rg --files` for those terms.
3. Read the most relevant files before listing broad directories.
4. Expand outward through imports, tests, callers, and adjacent modules.
5. Only use broad `ls` or tree-style exploration when the targeted pass does not explain the system shape.

## Notes
Use primary sources for external technical facts: official docs, source code, specs, or release notes. For repo behavior, live files beat memory.

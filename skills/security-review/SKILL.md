---
name: security-review
description: Use when code touches auth, sessions, secrets, external input, files, webhooks, SQL, network calls, approvals, budget, or proposal execution
---

# Security Review

## The Rule
Security-sensitive changes need an explicit threat pass before implementation is called done.

## Checklist
1. Identify the trust boundary: user input, agent output, webhook payload, file path, database row, network response, or scheduler event.
2. Validate and normalize inputs before side effects.
3. Keep secrets in env/vault storage; never log tokens, cookies, API keys, or raw credentials.
4. Check authorization before state changes, file access, tool execution, queue mutation, or approval transitions.
5. Use parameterized SQL and existing database helpers.
6. Prevent path traversal when accepting paths or filenames.
7. Verify webhook signatures and replay protection when accepting external callbacks.
8. Keep network calls on explicit allowlists when the caller can influence destinations.
9. Add regression tests for denied access, malformed input, and the successful path when practical.

## Completion
Name the boundary reviewed and the verification run. If a risk remains, call it out directly.

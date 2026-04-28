---
name: codex-harness
description: Use when working on Codex agent runtime behavior, porting Claude Code patterns, or designing agent execution workflows
---

# Codex Harness

## The Rule
Port ideas, not assumptions. NyxHive runs on Codex, so Claude Code concepts must be translated into Codex-native runtime behavior before they become system guidance.

## Codex Facts
1. `AGENTS.md` and live harness instructions are the authority for agent behavior.
2. Do not assume Claude hooks, slash commands, settings files, or MCP wiring exist unless this repo implements them.
3. Treat sandbox, approval, network, and tool availability as runtime policy from the active session.
4. Prefer repo-local skills and prompts over imported prompt packs.
5. Completion claims need fresh command evidence: tests, typecheck, smoke checks, git status, or the exact blocker.

## Porting Checklist
1. Read the source pattern and identify the actual behavior it creates.
2. Drop provider-specific ceremony that does not map to Codex.
3. Keep the smallest durable workflow that improves NyxHive.
4. Add tests when the behavior is loaded, routed, or selected by code.
5. Keep prompt surface area tight; default-loaded skills must earn their tokens.

# NyxHive Runtime Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the P0/P1 runtime trust failures from the 2026-04-23 goals review and make Nyx fully use GPT-5.5 across live config, defaults, routing, and model metadata.

**Architecture:** Move authority decisions out of prompts and into executable policy. Sender role capabilities decide whether Codex can run at all. Codex sandbox/approval settings come from a resolver instead of hard-coded full access. The soul prompt becomes canonical, with optional instance overlays appended rather than replacing it. Empty Codex runs fail loudly. Model 5.5 becomes the configured Nyx default with cost/context metadata present.

**Tech Stack:** Bun, TypeScript, TOML config, OpenAI Codex SDK, existing `bun test` test suite and `bun run typecheck`.

---

## Current Evidence

- Review findings are recorded in `docs/reviews/2026-04-23-nyxhive-goals-review.md`.
- `.nyxhive/config.toml` still configures Nyx as `model = "gpt-5.4"`.
- `config/nyxhive.toml` already configures Nyx as `model = "gpt-5.5"`.
- `src/config.ts` already defaults OpenAI Codex auth to `gpt-5.5`.
- `src/queue/model-utils.ts` already maps OpenAI/Codex aliases to `gpt-5.5`.
- `src/defaults.ts` has `MODEL_TIERS["gpt-5.5"] = 4`, but no GPT-5.5 entry in `DEFAULT_COST_RATES` or `MODEL_CONTEXT_WINDOWS`.
- `src/agents/invoke-codex-sdk.ts` hard-codes `sandboxMode: "danger-full-access"` and `approvalPolicy: "never"`.
- `src/agents/invoke-codex-sdk.ts` returns `Task completed` when Codex emits no assistant message.
- `src/queue/system-prompt-builder.ts` lets `agent.system_prompt` replace the soul prompt.
- `src/security/sender-role-policy.ts` only blocks `always_cli` for Anthropic/OpenRouter SDK-capable providers, leaving OpenAI/Codex paths under-enforced.

---

## Task 1: Enforce Sender Role Authority Before Routing

**Files:**
- `src/security/sender-role-policy.ts`
- `src/agents/invoke.ts`
- `src/__tests__/sender-role-policy.test.ts`
- `src/__tests__/invoke-routing.test.ts`

**Intent:** Viewer/support/engineer role limits must apply to Nyx's OpenAI/Codex runtime, not only to Anthropic/OpenRouter CLI routing.

### Steps

- [ ] Add failing tests in `src/__tests__/sender-role-policy.test.ts` for an OpenAI/Codex Nyx agent:
  - viewer role: no `tool_use`, no `always_cli`, no `cli_fallback`.
  - support role: no `tool_use`, no `always_cli`, no `cli_fallback`.
  - engineer role: keeps bounded `tool_use` only if that is the intended role contract, but still no `always_cli` and no `cli_fallback`.
- [ ] Update `applySenderRolePolicy` in `src/security/sender-role-policy.ts` so non-operator roles clear CLI/Codex escalation fields regardless of provider.
- [ ] Update `shouldBypassConversationalRouting` in `src/agents/invoke.ts` so a Codex SDK bypass requires executable capability, not only provider/model/agentic flags.
- [ ] Add or update routing coverage in `src/__tests__/invoke-routing.test.ts` so an OpenAI/Codex agent with `capabilities: []` cannot enter the full Codex SDK path.
- [ ] Run targeted verification:

```bash
bun test src/__tests__/sender-role-policy.test.ts src/__tests__/invoke-routing.test.ts
bun run typecheck
```

---

## Task 2: Replace Hard-Coded Codex Full Access With A Runtime Security Resolver

**Files:**
- `src/agents/codex-security.ts`
- `src/agents/invoke-codex-sdk.ts`
- `src/harness/codex-app-server.ts`
- `src/__tests__/invoke-codex-sdk.test.ts`
- `src/__tests__/codex-app-server-harness.test.ts`

**Intent:** Codex authority should be explicitly derived from trusted runtime inputs. Full filesystem access must be exceptional and test-visible.

### Steps

- [ ] Inspect installed `@openai/codex-sdk` types to confirm supported sandbox and approval values before implementation:

```bash
rg "sandboxMode|approvalPolicy|danger-full-access|workspace-write|read-only" node_modules/@openai -n
```

- [ ] Create `src/agents/codex-security.ts` with a resolver shaped like:

```ts
export type CodexSecurityDecision = {
  sandboxMode: string;
  approvalPolicy: string;
  additionalDirectories: string[];
};
```

- [ ] Make the resolver accept agent identity/capabilities, requested working directory, configured additional directories, and task intent.
- [ ] Default to the least-privileged SDK mode supported by the installed Codex SDK for non-mutating or non-operator work.
- [ ] Permit `danger-full-access` only when the agent has executable authority and the task path truly requires mutation outside the primary workspace.
- [ ] Sanitize configured additional directories so broad roots like `/home/user` and `/Volumes` are not passed to Codex by default.
- [ ] Update `src/agents/invoke-codex-sdk.ts` to call the resolver and pass its decision into `codex.startThread`.
- [ ] Update `src/harness/codex-app-server.ts` to use the same resolver instead of duplicating full-access defaults.
- [ ] Add tests in `src/__tests__/invoke-codex-sdk.test.ts` proving:
  - default coding work receives the expected safe sandbox decision.
  - non-authorized agents are rejected before `startThread`.
  - broad configured directories are filtered from default Codex authority.
- [ ] Update `src/__tests__/codex-app-server-harness.test.ts` to assert the resolver-selected sandbox instead of hard-coded `danger-full-access`.
- [ ] Run targeted verification:

```bash
bun test src/__tests__/invoke-codex-sdk.test.ts src/__tests__/codex-app-server-harness.test.ts
bun run typecheck
```

---

## Task 3: Make The Soul Prompt Canonical

**Files:**
- `src/queue/system-prompt-builder.ts`
- `.nyxhive/config.toml`
- `config/nyxhive.toml`
- `src/__tests__/system-prompt-builder.test.ts`

**Intent:** Nyx should have one canonical soul. Inline agent prompts may add instance-specific runtime overlay text, but must not replace the soul.

### Steps

- [ ] Add a failing test in `src/__tests__/system-prompt-builder.test.ts` where both a soul prompt and `agent.system_prompt` are present.
- [ ] Assert the assembled prompt contains both:
  - canonical soul content.
  - instance overlay content.
- [ ] Update `src/queue/system-prompt-builder.ts` so the soul prompt is loaded first when an agent has `soul` configured.
- [ ] Append `agent.system_prompt` as an instance overlay section instead of using it as the replacement base prompt.
- [ ] Preserve existing behavior for agents with no configured soul.
- [ ] Update `.nyxhive/config.toml` so Nyx explicitly references `soul = "nyx"` and the inline prompt is either removed or reduced to a small overlay.
- [ ] Keep `config/nyxhive.toml` aligned with the same soul/overlay shape.
- [ ] Run targeted verification:

```bash
bun test src/__tests__/system-prompt-builder.test.ts
bun run typecheck
```

---

## Task 4: Fail Loudly On Empty Codex Responses

**Files:**
- `src/agents/invoke-codex-sdk.ts`
- `src/__tests__/invoke-codex-sdk.test.ts`

**Intent:** A Codex run with no assistant message is not success. It should produce a diagnostic failure that queue/run lifecycle code can surface.

### Steps

- [ ] Add a failing test in `src/__tests__/invoke-codex-sdk.test.ts` where the mocked Codex stream finishes without an `agent_message`.
- [ ] Assert the invocation rejects with a message like `Codex produced no assistant response`.
- [ ] Remove the `finalResponse || "Task completed"` fallback from `src/agents/invoke-codex-sdk.ts`.
- [ ] Throw an explicit error when `finalResponse.trim()` is empty.
- [ ] Preserve usage/tool accounting for normal non-empty responses.
- [ ] Run targeted verification:

```bash
bun test src/__tests__/invoke-codex-sdk.test.ts
bun run typecheck
```

---

## Task 5: Complete The GPT-5.5 Upgrade

**Files:**
- `.nyxhive/config.toml`
- `config/nyxhive.toml`
- `src/defaults.ts`
- `src/__tests__/model-utils.test.ts`
- `src/__tests__/simple-config.test.ts`
- Add `src/__tests__/defaults.test.ts` if no existing defaults coverage fits cleanly.

**Intent:** GPT-5.5 should be the live Nyx model everywhere the runtime derives defaults, billing, context limits, and alias resolution.

### Steps

- [ ] Change `.nyxhive/config.toml` Nyx model from `gpt-5.4` to `gpt-5.5`.
- [ ] Confirm `config/nyxhive.toml` remains `gpt-5.5`.
- [ ] Add `gpt-5.5` to `DEFAULT_COST_RATES` in `src/defaults.ts`.
- [ ] Add `gpt-5.5` to `MODEL_CONTEXT_WINDOWS` in `src/defaults.ts`.
- [ ] Keep backward compatibility aliases/tests for `gpt-5.4`; this is an upgrade, not a removal.
- [ ] Add test coverage proving:
  - OpenAI Codex auth defaults to `gpt-5.5`.
  - OpenAI/Codex aliases resolve to `gpt-5.5`.
  - `gpt-5.5` has cost metadata.
  - `gpt-5.5` has context window metadata.
- [ ] Run targeted verification:

```bash
bun test src/__tests__/model-utils.test.ts src/__tests__/simple-config.test.ts src/__tests__/defaults.test.ts
bun run typecheck
```

---

## Task 6: Full-System Verification And Closeout

**Intent:** Do not claim the hardening is complete until the whole repo still passes.

### Steps

- [ ] Run the full suite:

```bash
bun test
bun run typecheck
```

- [ ] Inspect git status:

```bash
git status --short
```

- [ ] Review the final diff for unrelated churn:

```bash
git diff --stat
git diff -- src/security/sender-role-policy.ts src/agents/invoke.ts src/agents/invoke-codex-sdk.ts src/agents/codex-security.ts src/harness/codex-app-server.ts src/queue/system-prompt-builder.ts src/defaults.ts .nyxhive/config.toml config/nyxhive.toml
```

- [ ] Commit only after `bun test` and `bun run typecheck` both pass:

```bash
git add docs/reviews/2026-04-23-nyxhive-goals-review.md docs/superpowers/plans/2026-04-23-nyxhive-runtime-hardening.md src/security/sender-role-policy.ts src/agents/invoke.ts src/agents/invoke-codex-sdk.ts src/agents/codex-security.ts src/harness/codex-app-server.ts src/queue/system-prompt-builder.ts src/defaults.ts .nyxhive/config.toml config/nyxhive.toml src/__tests__
git commit -m "fix: harden nyx runtime authority"
```

---

## Execution Order

1. Sender role authority.
2. Empty Codex response failure.
3. GPT-5.5 metadata/config upgrade.
4. Canonical soul prompt.
5. Codex sandbox resolver.
6. Full verification and commit.

This order closes the easiest trust-boundary leaks first, then handles the deeper sandbox refactor after the smaller invariants are already protected by tests.

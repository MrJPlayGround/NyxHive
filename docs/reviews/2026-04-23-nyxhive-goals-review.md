# NyxHive Goals Review Findings

Date: 2026-04-23

## Finding 1: Non-Operator Roles Can Still Reach Full Codex Runtime

File: `src/security/sender-role-policy.ts`
Lines: 4-37
Priority: P0

The sender role policy says viewer/support get no tool use and no CLI, but it only disables `always_cli` for Anthropic/OpenRouter. Nyx is OpenAI/Codex, and `shouldBypassConversationalRouting` ignores `capabilities`, so a viewer/support/engineer path can still enter the full Codex SDK runtime.

Impact: the channel trust boundary is prompt-based instead of enforced.

## Finding 2: Codex Runs With Full Filesystem Authority

File: `src/agents/invoke-codex-sdk.ts`
Lines: 72-79
Priority: P0

The Codex SDK path always starts with `sandboxMode: danger-full-access` and `approvalPolicy: never`. Combined with the live config granting `/home/user` and `/Volumes`, this violates the preserve-user-work and scoped-access goals.

Recommendation: map task, trust, and agent role to a restrictive sandbox. Broad directories should be exceptional, not default.

## Finding 3: Nyx Soul Is Not The Runtime Source Of Truth

File: `src/queue/system-prompt-builder.ts`
Lines: 442-448
Priority: P1

Prompt assembly uses `agent.system_prompt` as a replacement for the soul prompt whenever it is present. The live Nyx config defines an inline prompt, while `AGENTS.md` and workspace files are generated from the soul.

Impact: this creates two Nyxes: one in the assembled runtime prompt and one in repo/workspace instructions.

Recommendation: use one canonical soul path plus small instance overlays.

## Finding 4: Empty Codex Responses Become Fake Success

File: `src/agents/invoke-codex-sdk.ts`
Lines: 182-190
Priority: P1

If Codex emits no assistant message, this returns the literal success-looking response `Task completed`.

Impact: this breaks the evidence-before-claiming-success rule and can mark failed or malformed runs as successful.

Recommendation: empty final responses should fail loudly or be retried with explicit diagnostics.


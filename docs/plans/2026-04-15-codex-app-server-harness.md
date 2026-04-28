# Codex App-Server Harness Plan

Date: 2026-04-15

## Decision

NyxHive should adopt a native Codex app-server harness for OpenAI/Codex agents instead of treating Codex as a one-shot CLI JSON stream.

T3Code is the implementation reference for the Codex transport shape: JSON-RPC over `codex app-server`, explicit initialize/initialized handshake, `account/read`, `model/list`, `thread/start` or `thread/resume`, `turn/start`, and structured server notifications.

OpenClaw is the reference for the strict no-fallback posture: when an instance says it is using Codex, strict mode must prove Codex auth and must not silently route elsewhere.

ForgeCode is the benchmark bar for harness behavior: persistent process lifecycle, stateful terminal execution, clean recovery, and tool-feedback discipline. It is not imported directly, but NyxHive should keep pulling its runtime lessons into our own queue and soul system instead of copying its surface area.

## Scope

This pass builds the safe foundation:

- Add provider-neutral harness runtime types.
- Add a Codex app-server adapter behind an explicit feature flag/config switch.
- Preserve the existing `codex exec --json` path as the default fallback while the app-server path hardens.
- Make strict Codex agents fail loudly instead of falling back to OpenRouter when the Codex harness fails.
- Persist Codex app-server thread IDs as resumable session IDs.
- Verify with mocked protocol tests before any live rollout.

## Non-Goals

- Do not import T3Code or Effect.
- Do not add Claude/Anthropic support to the new harness.
- Do not replace NyxHive's queue, memory, proposal, or identity systems.
- Do not introduce remote gateway rewrites in this pass.

## Runtime Modes

NyxHive strict Codex means:

- provider: `openai`
- auth mode: `codex`
- runtime: `codex_app_server`
- model: `gpt-5.4` unless explicitly overridden
- fallback: `none`

Supervised/read-only modes can be added after the app-server path is stable.

## Rollout

1. Land adapter and tests with `NYXHIVE_CODEX_APP_SERVER=1` as the runtime switch.
2. Enable the switch for NyxAI only.
3. Verify auth discovery, model list, one real turn, interruption behavior, restart/resume, and gateway progress.
4. Enable NyxLabs.
5. Remove or demote `codex exec --json` after the app-server path survives real use.

## Acceptance

- `bun test` passes.
- `bun run typecheck` passes.
- Unit tests cover app-server initialize, discovery, thread start, thread resume, turn completion, approval-denied strict mode, user-input request capture, and protocol failure.
- Strict Codex agents do not fall back to OpenRouter on Codex runtime failure.

## Next Pass: Harness Quality

The second pass moves from "Codex is correctly wired" to "Codex feels like a real harness":

- Reuse a shared `codex app-server` process per runtime key instead of spawning one process per turn.
- Serialize turns per app-server connection until event demultiplexing is proven safe.
- Evict and replace pooled connections when the app-server exits, emits invalid protocol data, or stalls.
- Surface runtime events on invocation results: connection reuse, tool starts/completions, usage updates, turn completion, failures, and session closure.
- Parse both snake_case and camelCase usage payloads so Codex protocol drift does not hide token data.
- Close pooled app-server processes during NyxHive graceful shutdown before the generic child-process sweep.

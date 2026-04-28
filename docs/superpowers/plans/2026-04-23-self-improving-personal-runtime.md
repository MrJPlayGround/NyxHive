# Self-Improving Personal Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reposition and implement NyxHive as a general-purpose, self-improving personal agent runtime that can also operate as an engineering partner and lead-agent orchestrator, without flattening Nyx identity, memory, or governance into a generic Hermes/OpenClaw clone.

**Architecture:** Treat `personal runtime` as the product center of gravity, with `conversation`, `execution`, `investigation`, `reflection`, and `federation` as first-class runtime modes. Keep NyxHive’s soul/identity, memory authority, approval posture, and repo-owner agency intact while importing Hermes’ runtime discipline and OpenClaw’s assistant-surface clarity into the existing Bun + TypeScript core.

**Tech Stack:** Bun, TypeScript, Hono, SQLite, NyxHive queue/runtime/memory/scheduler stack, Nyx Workspace (TanStack Router + React), Telegram/Discord/Slack/iOS/API channels, OpenAI Codex SDK + current provider/router abstractions

---

## Design Call

The right move is not “make NyxHive more multi-agent” and not “make NyxHive only a personal assistant.”

The right move is:

1. Make `self-improving personal runtime` the canonical product and architecture frame.
2. Demote `lead-agent orchestration` to one runtime lane that appears only when it is genuinely useful.
3. Thin the heavy execution exoskeleton out of conversational turns.
4. Strengthen the self-improvement and memory-governance loop so “grows with you” is actually true in the runtime, not just in docs.
5. Upgrade the workspace and channel surfaces so the system feels like one assistant/runtime across contexts instead of several partially joined subsystems.

## Non-Goals

- Do not copy Hermes’ branding, Python-first runtime shape, or generic personality layer.
- Do not copy OpenClaw’s product voice, consumer theming, or gateway schema wholesale.
- Do not weaken Nyx soul compilation, proposal governance, approval gates, or User-specific instruction layering.
- Do not create a second “canonical memory” store.
- Do not make delegation the default for work Nyx can handle directly.
- Do not ship a large surface rewrite before the runtime contract is unified underneath it.

## Existing Repo Seams To Use

This plan is grounded in the current codebase, not a greenfield fantasy:

- Runtime-mode substrate already exists in `src/runtime/mode.ts`, `src/runtime/reply-shape.ts`, `src/runtime/conversation-mode-router.ts`, `src/runtime/conversation-quality.ts`, and `src/runtime/transcript-review.ts`.
- Prompt assembly already separates policy sections in `src/queue/system-prompt-builder.ts`.
- Runtime selection already happens in `src/queue/processor.ts`.
- Delegation is already guarded and nudged in `src/queue/delegation-executor.ts`.
- Conversation/history/memory extraction already live in `src/queue/conversation.ts`, `src/queue/memory-extraction.ts`, and `src/memory/*`.
- Reactive learning and scheduled learning loops already exist in `src/learning/listeners.ts`, `src/learning/analysis.ts`, `src/scheduler/index.ts`, and `.nyxhive/config.toml`.
- Workspace chat/session mode UX already exists in `src/nyx-workspace/src/screens/chat/*`, `src/nyx-workspace/src/routes/api/send-stream.ts`, and `src/nyx-workspace/src/server/gateway-capabilities.ts`.
- Workspace trust model already exists in `src/nyx-workspace/src/server/trust-policy.ts`.
- Platform framing still over-indexes on “multi-agent AI platform” in `src/agents/platform-docs.ts` and `README.md`.
- Server/channel/gateway seams already exist in `src/server/index.ts`, `src/framework/channels/*`, and `src/channels/*`.

## Program Structure

This work should execute in eight phases with hard checkpoints. Each phase is shippable on its own. Do not batch all phases into one monster branch.

## Phase 0: Baseline, Metrics, And Rollback Guardrails

**Outcome**

We establish a measurement baseline before changing behavior so we can prove the runtime got better instead of just different.

**Primary files**

- Modify: `README.md`
- Modify: `src/runtime/conversation-quality.ts`
- Modify: `src/runtime/transcript-review.ts`
- Modify: `src/runtime/conversation-benchmark.ts`
- Modify: `scripts/conversation-quality-report.ts`
- Modify: `scripts/transcript-review-report.ts`
- Modify: `scripts/memory-eval-report.ts`
- Create: `docs/plans/2026-04-23-self-improving-personal-runtime-baseline.md`

**Implementation**

- [ ] Define the success metrics for this program:
  - conversational over-structure rate
  - accidental agentic/execution-mode rate on simple turns
  - missing-evidence rate on investigative turns
  - delegation-overuse rate
  - memory token pressure for low-action turns
  - scheduler self-improvement yield rate
  - workspace mode mismatch rate
- [ ] Extend evaluation/report output so baseline runs can be compared phase to phase.
- [ ] Add an explicit “runtime posture” section to the baseline report.
- [ ] Capture a before snapshot using current transcripts, quality traces, and memory stats.

**Checkpoint**

- Baseline report committed or preserved in docs.
- Metrics are cheap enough to re-run every phase.

**Smoke tests**

- `bun test src/__tests__/conversation-quality.test.ts src/__tests__/transcript-review.test.ts`
- `bun run scripts/conversation-quality-report.ts`
- `bun run scripts/transcript-review-report.ts`
- `bun run scripts/memory-eval-report.ts`

**Exit criteria**

- We can compare before/after behavior without hand-waving.

## Phase 1: Canonical Runtime Framing

**Outcome**

NyxHive stops describing itself primarily as a multi-agent orchestrator and instead consistently describes itself as a self-improving personal runtime with orchestration as a lane.

**Primary files**

- Modify: `README.md`
- Modify: `src/agents/platform-docs.ts`
- Modify: `src/queue/system-prompt-builder.ts`
- Modify: `src/runtime/mode.ts`
- Modify: `src/soul/compiler.ts`
- Modify: `src/soul/compiler-v2.ts`
- Modify: `.nyxhive/config.toml`
- Modify: relevant soul/personality anchors under `souls/` and `.nyxhive/` if wording drift remains

**Implementation**

- [ ] Replace top-level product framing in docs and prompt context:
  - `self-improving personal runtime`
  - `engineering partner`
  - `lead-agent orchestration when delegation adds leverage`
- [ ] Keep Nyx’s repo-owner identity and governance language intact.
- [ ] Update prompt assembly labels so “operating model” and “execution policy” reinforce the new center of gravity.
- [ ] Make sure the platform context no longer nudges every turn toward orchestration just because multiple agents exist.
- [ ] Align scheduler prompt wording with the same center-of-gravity language.

**Checkpoint**

- Same task described in README, workspace prompt context, and runtime policy no longer produces contradictory product framing.

**Smoke tests**

- `bun test src/__tests__/soul-v2-runtime.test.ts src/__tests__/processor-session-runtime.test.ts`
- Manual prompt inspection from traces:
  - simple chat turn
  - deep reflection turn
  - build/execution turn
  - delegation/federation turn

**Exit criteria**

- Product framing is consistent across docs, prompt assembly, and runtime instructions.

## Phase 2: Runtime Contract Unification

**Outcome**

The runtime modes become the real governing abstraction. Conversation, reflection, execution, investigation, and federation get different policies, evidence expectations, and reply-shape rules end to end.

**Primary files**

- Modify: `src/runtime/mode.ts`
- Modify: `src/runtime/reply-shape.ts`
- Modify: `src/runtime/evaluation.ts`
- Modify: `src/runtime/task-closeout.ts`
- Modify: `src/runtime/transcript-review.ts`
- Modify: `src/runtime/conversation-quality.ts`
- Modify: `src/queue/system-prompt-builder.ts`
- Modify: `src/queue/processor.ts`
- Create: `src/__tests__/runtime-mode-contract.test.ts`

**Implementation**

- [ ] Promote `ProductRuntimeMode` from a nice enum into the actual contract used by:
  - prompt assembly
  - evaluation
  - closeout behavior
  - transcript review
  - tool-detail visibility
- [ ] Keep `conversation / hybrid / agentic` only as an internal lower-level classifier if still useful.
- [ ] Ensure every runtime mode explicitly defines:
  - response shape
  - evidence requirement
  - memory retrieval posture
  - visibility of runtime/tool detail
  - waiting/progress behavior
- [ ] Remove hidden coupling where agentic-heavy closeout leaks into reflective or conversational turns.
- [ ] Add trace fields for the final product/runtime mode so we can verify routing quality.

**Checkpoint**

- A trace for every turn shows the selected product/runtime mode and why.

**Smoke tests**

- Add or extend tests for:
  - social turn => `conversation`
  - architecture judgment => `reflection`
  - code review => `investigation`
  - file-edit request => `execution`
  - explicit delegation => `federation`
- `bun test src/__tests__/runtime-mode.test.ts src/__tests__/runtime-mode-contract.test.ts`

**Exit criteria**

- The product/runtime mode, not a bag of prompt heuristics, explains the user-facing behavior.

## Phase 3: Thin Conversational Turns, Preserve Heavy Execution Turns

**Outcome**

NyxHive stops dragging full engineering scaffolding into casual and reflective turns while preserving strict evidence discipline for actual execution work.

**Primary files**

- Modify: `src/queue/system-prompt-builder.ts`
- Modify: `src/queue/processor.ts`
- Modify: `src/runtime/reply-shape.ts`
- Modify: `src/runtime/post-action-continuity.ts`
- Modify: `src/queue/conversation.ts`
- Modify: `src/queue/knowledge-search.ts`
- Modify: `src/memory/retrieval-trace.ts`
- Modify: `src/memory/lanes.ts`

**Implementation**

- [ ] Reduce default policy/prompt payload for `conversation` and `reflection` modes.
- [ ] Skip ambient knowledge injection for low-action turns unless evidence or continuity clearly needs it.
- [ ] Tighten memory-lane filtering so low-action turns do not pull procedural/operational debris.
- [ ] Keep post-action continuity for non-agentic turns that follow tool use, but make it compact and human.
- [ ] Preserve strict execution closeout and verification language only for `execution` and `investigation`.
- [ ] Ensure prompt trace output makes token savings visible.

**Checkpoint**

- Low-action turns show materially lower prompt and memory token pressure.

**Smoke tests**

- Transcript scenarios:
  - “thanks nyx”
  - casual thought / vent
  - reflective architecture question
  - follow-up after tool use
- `bun test src/__tests__/processor-session-runtime.test.ts src/__tests__/memory-extraction-hook.test.ts`
- Re-run conversation quality and transcript review reports and compare to baseline.

**Exit criteria**

- Simple turns feel like a person, not a process wrapper.

## Phase 4: Conversation Modes And Workspace UX Alignment

**Outcome**

Workspace-facing mode controls line up with actual runtime behavior instead of being partly cosmetic and partly separate from backend policy.

**Primary files**

- Modify: `src/runtime/conversation-mode-router.ts`
- Modify: `src/nyx-workspace/src/screens/chat/conversation-mode-router.ts`
- Modify: `src/nyx-workspace/src/screens/chat/chat-screen.tsx`
- Modify: `src/nyx-workspace/src/screens/chat/components/chat-composer.tsx`
- Modify: `src/nyx-workspace/src/screens/chat/components/chat-composer-state.ts`
- Modify: `src/nyx-workspace/src/screens/chat/workspace-ux-state.ts`
- Modify: `src/nyx-workspace/src/server/chat-mode.ts`
- Modify: `src/nyx-workspace/src/server/chat-mode-derive.ts`
- Modify: `src/nyx-workspace/src/routes/api/send-stream.ts`
- Modify: `src/nyx-workspace/src/server/gateway-capabilities.ts`

**Implementation**

- [ ] Keep user-facing session modes (`Quick`, `Task`, `Build`, `Deep`) but explicitly map them to backend product/runtime modes.
- [ ] Make `Quick` reliably select low-overhead conversation behavior.
- [ ] Make `Deep` reliably mean reflective or investigative depth, not automatic full engineering ceremony.
- [ ] Make `Build` reliably select execution posture and verification expectations.
- [ ] Make capability-degraded/portable mode preserve the same semantic promise, just with fewer backend features.
- [ ] Surface the active runtime posture in the workspace in a human-readable way.
- [ ] Remove any UI copy that still implies the gateway/backend mode is the product mode.

**Checkpoint**

- Session mode selection changes actual runtime traces, not just labels.

**Smoke tests**

- `bun test src/nyx-workspace/src/server/chat-mode-derive.test.ts`
- `bun test src/nyx-workspace/src/screens/chat/conversation-mode-router.test.ts src/nyx-workspace/src/screens/chat/components/chat-composer-state.test.ts`
- `bun test src/nyx-workspace/src/screens/chat/workspace-ux-state.test.ts`
- Manual workspace smoke:
  - new chat in `Quick`
  - new chat in `Deep`
  - new chat in `Build`
  - portable mode fallback

**Exit criteria**

- “Mode” becomes a trustworthy control, not a hint.

## Phase 5: Personal Assistant Surface, Trust, And Channel Posture

**Outcome**

NyxHive behaves like one coherent personal assistant across channels while keeping explicit trust boundaries for live facts, memory writes, reminders, file writes, and external sends.

**Primary files**

- Modify: `src/nyx-workspace/src/server/trust-policy.ts`
- Modify: `src/server/index.ts`
- Modify: `src/server/gateway-health.ts`
- Modify: `src/framework/channels/telegram.ts`
- Modify: `src/framework/channels/discord.ts`
- Modify: `src/framework/channels/slack.ts`
- Modify: `src/channels/telegram.ts`
- Modify: `src/channels/discord.ts`
- Modify: `src/channels/slack/*`
- Modify: `src/agents/platform-docs.ts`
- Modify: `src/nyx-workspace/src/screens/chat/components/connection-status-message.tsx`
- Modify: `src/nyx-workspace/src/components/backend-unavailable-state.tsx`

**Implementation**

- [ ] Make the personal-assistant trust model explicit in docs and health output:
  - one trusted operator boundary
  - paired/approved DM surfaces
  - public channels stay public-safe
- [ ] Align workspace trust policy with channel trust policy so the same action is allowed/blocked for the same reason everywhere.
- [ ] Improve the live/current-fact refusal path when tools are unavailable or fail.
- [ ] Make channel-specific voice/context rules concise and channel-appropriate without splintering core identity.
- [ ] Tighten public Discord viewer behavior to stay light/public-safe without becoming generic or neutered.

**Checkpoint**

- Trust decisions explain themselves consistently across workspace and channel edges.

**Smoke tests**

- `bun test src/nyx-workspace/src/server/trust-policy.test.ts`
- targeted channel tests already in repo plus manual channel smoke:
  - Telegram DM normal chat
  - Discord public viewer turn
  - Discord DM paired turn
  - live-info request with tool unavailable

**Exit criteria**

- Nyx feels present across channels without losing trust discipline.

## Phase 6: Self-Improvement Loop And Memory Governance

**Outcome**

NyxHive’s “self-improving” claim becomes materially stronger: memory authority is clearer, scheduler loops are higher-signal, and durable learning is more useful and less sludgy.

**Primary files**

- Modify: `src/queue/memory-extraction.ts`
- Modify: `src/memory/lanes.ts`
- Modify: `src/memory/retrieval-trace.ts`
- Modify: `src/memory/store.ts`
- Modify: `src/memory/graph.ts`
- Modify: `src/memory/compiled-knowledge.ts`
- Modify: `src/memory/conversation-memory.ts`
- Modify: `src/memory/belief-state.ts`
- Modify: `src/learning/listeners.ts`
- Modify: `src/learning/analysis.ts`
- Modify: `src/scheduler/index.ts`
- Modify: `src/server/routes/memory.ts`
- Modify: `.nyxhive/config.toml`
- Reference and align with: `docs/plans/2026-04-17-living-memory-architecture.md`

**Implementation**

- [ ] Enforce lane authority harder:
  - recent conversation
  - durable user preference
  - graph memory
  - knowledge chunk
  - compiled digest
  - procedural memory
  - reflection artifact / hypothesis
- [ ] Reduce low-value operational debris entering conversational retrieval lanes.
- [ ] Improve extraction filters so scheduler/system chatter stays out unless explicitly useful.
- [ ] Distinguish durable belief, evidence, and tentative reflection more clearly in retrieval traces and prompt assembly.
- [ ] Tighten the hourly improvement loop toward one high-leverage change or deliberate no-op.
- [ ] Add a reflection/self-model pipeline only if it reuses existing stores and authority metadata instead of creating a new canonical memory silo.

**Checkpoint**

- Memory traces show why a piece of memory was injected and what authority lane it came from.

**Smoke tests**

- `bun test src/__tests__/memory-extraction.test.ts src/__tests__/graph-memory.test.ts src/__tests__/memory-routes.test.ts`
- `bun test src/__tests__/procedural-skill-extraction.test.ts`
- `bun test src/__tests__/conversation-quality.test.ts src/__tests__/memory-eval.test.ts`
- scheduler smoke:
  - run hourly improvement task once in isolation
  - confirm one improvement or explicit no-op

**Exit criteria**

- A simple conversational turn no longer pulls thousands of irrelevant memory tokens.

## Phase 7: Delegation As A Runtime Lane, Not A Default Identity

**Outcome**

Delegation becomes a high-leverage mode that appears when useful, not the ambient posture of the whole system.

**Primary files**

- Modify: `src/queue/delegation-executor.ts`
- Modify: `src/queue/delegation.ts`
- Modify: `src/queue/delegation-synthesis.ts`
- Modify: `src/queue/processor.ts`
- Modify: `src/agents/platform-docs.ts`
- Modify: `src/runtime/mode.ts`
- Modify: `src/soul/compiler.ts`
- Modify: `src/nyx-workspace/src/screens/chat/components/message-item.tsx`
- Modify: `src/nyx-workspace/src/screens/chat/components/stream-activity.ts`

**Implementation**

- [ ] Keep self-handling nudges and strengthen them where Nyx has high confidence on bounded tasks.
- [ ] Make `federation`/delegation an explicit runtime mode with its own response contract and UI treatment.
- [ ] Reduce delegation noise in user-facing streaming activity.
- [ ] Make delegation rationale inspectable without forcing every final answer into orchestration language.
- [ ] Keep ownership clear when delegation does happen:
  - who owns the task
  - why it was delegated
  - what comes back
  - who makes the final call

**Checkpoint**

- Same simple engineering task handled directly by Nyx no longer detours through needless delegation.

**Smoke tests**

- `bun test src/__tests__/routing-store.test.ts src/__tests__/processor-session-runtime.test.ts`
- manual smoke:
  - direct bounded task
  - explicit specialist delegation
  - multi-step federated task with one subtask

**Exit criteria**

- Multi-agent behavior feels intentional instead of ambient.

## Phase 8: Operations Surface, Onboarding, And Product Packaging

**Outcome**

NyxHive looks and behaves like a coherent runtime product for User, not just an internal daemon plus a chat screen.

**Primary files**

- Reference and selectively integrate: `docs/superpowers/plans/2026-04-23-hermes-v2-workspace-upgrade.md`
- Modify or create: `src/nyx-workspace/src/routes/operations.tsx`
- Modify or create: `src/nyx-workspace/src/screens/operations/*`
- Modify: `src/nyx-workspace/src/screens/chat/components/chat-sidebar.tsx`
- Modify: `src/nyx-workspace/src/routes/jobs.tsx`
- Modify: `src/nyx-workspace/src/routes/tasks.tsx`
- Modify: `src/nyx-workspace/src/routes/profiles.tsx`
- Modify: `src/nyx/commands/workspace.ts`
- Modify: `README.md`
- Modify: install/bootstrap docs and scripts as needed

**Implementation**

- [ ] Add a first-class `Operations` surface that unifies:
  - missions / launches
  - active runs
  - crew status
  - jobs/tasks handoff points
- [ ] Use the existing workspace-upgrade plan as the control-plane subplan, not as the whole product strategy.
- [ ] Add `nyx workspace start|stop|status` and optionally `doctor` if the command surface is still fragmented.
- [ ] Improve first-run docs and bootstrap language around:
  - personal runtime
  - channel pairing
  - workspace mode
  - portable vs enhanced mode
- [ ] Do not ship vanity theme work before the runtime and control-plane seams are solid.

**Checkpoint**

- The workspace has a clear “operate the runtime” surface separate from conversational chat.

**Smoke tests**

- workspace route smoke:
  - chat
  - operations
  - jobs
  - tasks
  - profiles
  - memory
- `bun test`
- `bun run typecheck`
- `bun run workspace:build`

**Exit criteria**

- The product story and operator surface finally match the runtime we actually built.

## Recommended Execution Order

Do not execute these phases in parallel at first. The ordering matters.

1. Phase 0
2. Phase 1
3. Phase 2
4. Phase 3
5. Phase 4
6. Phase 5
7. Phase 6
8. Phase 7
9. Phase 8

Reason:

- Phases 1 to 3 establish the runtime contract and remove behavioral drift.
- Phase 4 makes the workspace tell the truth about that contract.
- Phase 5 makes channel behavior consistent with the same trust model.
- Phase 6 makes the “self-improving” part real.
- Phase 7 makes orchestration properly subordinate to the runtime instead of defining it.
- Phase 8 becomes a product/control-plane pass on top of a stable substrate.

## Checkpoint Gates

After each phase:

- [ ] Re-run targeted tests for the touched subsystem.
- [ ] Re-run conversation-quality and transcript-review reports if the phase affects runtime behavior.
- [ ] Re-check prompt assembly traces for one sample turn per mode.
- [ ] Capture a short note under `docs/plans/` with before/after metrics if behavior moved materially.
- [ ] Confirm no regression in:
  - quick conversational turns
  - build/execution turns
  - live-info truthfulness
  - memory pressure
  - workspace mode semantics

## Final Smoke Matrix

Before calling the whole program complete, run this matrix:

### Conversation

- casual greeting
- casual vent
- short reflective opinion request
- “what should we do” architecture turn

### Execution

- direct code change request
- repo review request
- investigation/root-cause request
- handoff report request

### Federation

- explicit delegation request
- bounded task that should stay local

### Channels

- workspace enhanced mode
- workspace portable mode
- Telegram DM
- Discord DM
- Discord public-safe viewer turn

### Memory / Learning

- low-action turn memory trace
- high-action execution turn memory trace
- hourly self-improvement scheduler run
- transcript review / quality report diff against baseline

### Commands

- `bun test`
- `bun run typecheck`
- `bun run workspace:build`

## Risks To Watch

- The biggest failure mode is partially doing the reframing in docs/UI while the backend still behaves like a generic orchestrator. That creates worse confusion than today.
- The second failure mode is “memory improvement” turning into a new memory silo. Do not do that.
- The third failure mode is making delegation quieter in UI without actually reducing delegation overuse in runtime policy.
- The fourth failure mode is workspace mode relabeling without real backend semantic alignment.

## Ship Criteria

The program is done when all of these are true:

- NyxHive consistently behaves like a self-improving personal runtime.
- Casual turns no longer inherit the heavy engineering exoskeleton.
- Execution turns still produce strong evidence and verification discipline.
- Delegation is visible as a mode, not the platform’s default personality.
- Memory/token pressure on simple turns is materially lower.
- Scheduler self-improvement loops are higher-signal and less noisy.
- Workspace and channel surfaces tell the same truth about the runtime.

## Immediate First Slice

Execute these first, in one bounded branch:

- Phase 0 baseline
- Phase 1 framing changes
- Phase 2 runtime contract unification
- Phase 3 conversational thinning

That slice gets the spine right before touching workspace/control-plane breadth.

# NyxHive Implementation Ledger

This file is the live execution ledger for the multi-phase NyxHive upgrade program.

## Baseline

- Date: 2026-04-10
- Worktree at baseline: clean
- `bun test`: `4179 pass, 3 skip, 0 fail`
- `bunx tsc --noEmit`: pass
- `bun run gateway:build`: pass

## Iteration Template

Use this structure for every meaningful execution loop:

### Loop

- Target:
- Evidence:
- Hypothesis:
- Change made:
- Tests added or tightened:
- Verification result:
- Residual risk:
- Next target:

## Active Execution

### Loop 0

- Target: Baseline lock and execution scaffolding
- Evidence: Repo needs a tracked roadmap and a running ledger before deep architectural loops begin
- Hypothesis: Capturing the baseline and the execution frame first will make later multi-loop work safer and easier to verify
- Change made:
  - Added `plans/nyxhive-implementation-roadmap.md`
  - Added `plans/nyxhive-implementation-ledger.md`
- Tests added or tightened: none
- Verification result:
  - `bun test` -> `4179 pass, 3 skip, 0 fail`
  - `bunx tsc --noEmit` -> pass
  - `bun run gateway:build` -> pass
- Residual risk: none yet, this loop is scaffolding only
- Next target: Phase 1 Loop 1.1, procedural skill draft storage seam

### Loop 1.1

- Target: Procedural skill draft storage seam
- Evidence: NyxHive had no durable store for procedural skill candidates, so there was nowhere to stage extracted workflows safely
- Hypothesis: Adding a dedicated draft store first would let later extraction, review, and promotion work land without coupling to prompt/runtime logic
- Change made:
  - Added `src/memory/procedural-skills.ts`
  - Added `src/__tests__/procedural-skill-drafts.test.ts`
  - Wired the store into `create-hive`, framework store types, and processor config
- Tests added or tightened:
  - draft create/get
  - dedupe by source hash
  - status/agent filtering
  - publish/reject/usage metadata
- Verification result:
  - `bun test` -> `4184 pass, 3 skip, 0 fail`
  - `bunx tsc --noEmit` -> pass
  - `bun run gateway:build` -> pass
- Residual risk: storage existed, but nothing created drafts yet
- Next target: Phase 1 Loop 1.2, post-success extraction hook

### Loop 1.2

- Target: Post-success procedural draft extraction
- Evidence: Successful engineering runs still vanished after completion; NyxHive only extracted declarative memory, not reusable procedure candidates
- Hypothesis: A conservative extractor on completed runs can create high-signal draft candidates without polluting memory with chatty or system-origin traffic
- Change made:
  - Added `src/queue/procedural-skill-extraction.ts`
  - Added `src/__tests__/procedural-skill-extraction.test.ts`
  - Wired `recordProceduralSkillDraftLocal()` into both queued and immediate processor completion paths
- Tests added or tightened:
  - qualifies substantial engineering workflows
  - skips short conversational turns
  - skips scheduler/proposal-origin traffic
  - dedupes identical extracted workflows
- Verification result:
  - `bun test src/__tests__/procedural-skill-drafts.test.ts src/__tests__/procedural-skill-extraction.test.ts` -> `9 pass, 0 fail`
  - `bunx tsc --noEmit` -> pass
  - `bun run gateway:build` -> pass
- Residual risk: extracted drafts were still staged only; published auto-skills were not yet selectively injected
- Next target: Phase 1 Loop 1.3, selective published auto-skill loading

### Loop 1.3

- Target: Selective published auto-skill loading
- Evidence: Skill loading still appended all manual skills wholesale and had no path for relevant published procedural skills
- Hypothesis: Injecting only task-relevant published auto-skills will reduce prompt bloat and make procedural memory useful in live runs
- Change made:
  - Upgraded `src/agents/skill-loader.ts` to support task-aware published auto-skill selection and usage tracking
  - Threaded `proceduralSkills` through invoke options and the native API invocation path
  - Added published auto-skill relevance coverage in `src/__tests__/skill-loader.test.ts`
- Tests added or tightened:
  - only relevant published auto-skills are loaded for a task
  - usage count increments only for injected published skills
- Verification result:
  - `bun test src/__tests__/procedural-skill-drafts.test.ts src/__tests__/procedural-skill-extraction.test.ts src/__tests__/skill-loader.test.ts` -> `21 pass, 0 fail`
  - `bunx tsc --noEmit` -> pass
  - `bun run gateway:build` -> pass
- Residual risk: once published auto-skills hit disk, the manual skill directory scan would need to avoid double-loading them
- Next target: Phase 1 Loop 1.4, safe publication into `auto-*` skill directories

### Loop 1.4

- Target: Safe publication of procedural drafts into `auto-*` skills
- Evidence: Drafts could be marked published in SQLite, but there was no filesystem publication path to turn them into real reusable skills for CLI/native runtimes
- Hypothesis: A small publisher that writes `SKILL.md` files into `skills/auto-*` and excludes those dirs from manual skill discovery will make promotion usable without creating prompt duplication
- Change made:
  - Added `src/agents/procedural-skills.ts`
  - Added `src/__tests__/procedural-skill-publisher.test.ts`
  - Updated `listAvailableSkills()` to exclude `auto-*` directories from manual skill discovery
- Tests added or tightened:
  - publish draft to `auto-*` dir and mark it published
  - idempotent republish when file already exists
  - unique naming when preferred auto-skill slug already exists
- Verification result:
  - `bun test src/__tests__/procedural-skill-publisher.test.ts src/__tests__/skill-loader.test.ts src/__tests__/procedural-skill-extraction.test.ts src/__tests__/procedural-skill-drafts.test.ts` -> `24 pass, 0 fail`
  - `bun test` -> `4189 pass, 3 skip, 0 fail`
  - `bunx tsc --noEmit` -> pass
  - `bun run gateway:build` -> pass
- Residual risk: procedural skills are now stageable, extractable, publishable, and selectively injectable, but they still need an operator surface for review/publish/reject outside code
- Next target: Phase 1 Loop 1.5, procedural skill review/promotion API surface

### Loop 1.5

- Target: Procedural skill review and promotion API surface
- Evidence: the procedural-skill core existed, but the only way to inspect or promote drafts was still through direct code access
- Hypothesis: a small authenticated API surface for list/get/publish/reject will make procedural skills operable immediately without mixing in cockpit UI work yet
- Change made:
  - Added `src/server/routes/procedural-skills.ts`
  - Added `src/__tests__/procedural-skills-routes.test.ts`
  - Mounted `/api/skills/procedural` in `src/server/index.ts`
  - Threaded `proceduralSkills` into `createServer()` from `create-hive`
  - Added `NYXHIVE_SKILLS_DIR` override support in `src/agents/skill-loader.ts` so route tests can publish safely into temp skill directories
- Tests added or tightened:
  - list drafts with status/agent filters
  - publish draft to an `auto-*` skill through the API
  - reject draft with a reason through the API
  - enforce read-only viewer access on mutation routes
- Verification result:
  - `bun test src/__tests__/procedural-skills-routes.test.ts src/__tests__/procedural-skill-publisher.test.ts src/__tests__/skill-loader.test.ts` -> `19 pass, 0 fail`
  - `bunx tsc --noEmit` -> pass
  - `bun run gateway:build` -> pass
- Residual risk: operators can manage drafts by API now, but cockpit still lacks a native review surface and published skill relevance is still keyword-based rather than embedding-aware
- Next target: Phase 1 Loop 1.6, cockpit review surface or smarter auto-skill ranking

### Loop 1.6

- Target: Cockpit review surface for procedural skill drafts
- Evidence: the API existed, but operators still had no native gateway surface to inspect draft markdown, publish a skill, or reject a draft without leaving the UI
- Hypothesis: a compact settings tab with status counts, filtered draft lists, and an inline detail pane will make the procedural-skill loop actually usable while keeping the cockpit complexity low
- Change made:
  - Added `src/gateway/src/pages/ProceduralSkills.tsx`
  - Added `src/gateway/src/pages/procedural-skills-view.ts`
  - Added `src/gateway/src/pages/procedural-skills-view.test.ts`
  - Mounted the page as a new `Skills` tab in `src/gateway/src/pages/Settings.tsx`
- Tests added or tightened:
  - summary counts and top-agent rollup
  - status/query filtering
  - newest-first draft ordering
  - kept route tests in the targeted pass to verify UI assumptions still match the API shape
- Verification result:
  - `bun test src/gateway/src/pages/procedural-skills-view.test.ts src/__tests__/procedural-skills-routes.test.ts` -> `7 pass, 0 fail`
  - `bunx tsc --noEmit` -> pass
  - `bun run gateway:build` -> pass
- Residual risk: the cockpit can now review drafts, but ranking is still lexical and there is no in-chat surfaced suggestion or draft creation audit trail yet
- Next target: Phase 1 Loop 1.7, smarter auto-skill ranking or surfaced draft provenance/telemetry

### Loop 1.7

- Target: Smarter published auto-skill ranking
- Evidence: published auto-skills were being selected with shallow token overlap, which is too noisy for engineering work where exact path hits and same-thread reuse matter more than generic words like "fix" or "verify"
- Hypothesis: weighting exact repo-path matches, phrase overlap, and active-conversation affinity will make procedural skills feel like operational memory instead of a loose keyword search
- Change made:
  - Upgraded `src/agents/skill-loader.ts` scoring to account for unique token overlap, path-segment overlap, phrase overlap, capped usage bonus, and active conversation affinity
  - Threaded `sessionId` into the skill loader call from `src/agents/invoke-native-api.ts`
  - Added ranking regressions in `src/__tests__/skill-loader.test.ts`
- Tests added or tightened:
  - prefer exact repo-path matches over generic verification overlap when auto-skill slots are limited
  - prefer a published skill from the active conversation when relevance is otherwise tied
- Verification result:
  - `bun test src/__tests__/skill-loader.test.ts src/__tests__/procedural-skills-routes.test.ts` -> `18 pass, 0 fail`
  - `bunx tsc --noEmit` -> pass
  - `bun run gateway:build` -> pass
- Residual risk: ranking is stronger, but it is still heuristic; there is not yet any operator-visible provenance or evidence about why a procedural draft was created or reused
- Next target: Phase 1 Loop 1.8, procedural draft provenance/telemetry and creation audit surfaces

### Loop 1.8

- Target: Procedural draft provenance and audit visibility
- Evidence: operators could review draft content, but there was still no explicit answer to why a draft was extracted or easy search by trace/source hash when debugging the self-improvement loop
- Hypothesis: if extracted drafts carry their own evidence section and the UI/search surface exposes provenance fields directly, the procedural-skill loop becomes reviewable instead of opaque
- Change made:
  - Added extraction-evidence generation in `src/queue/procedural-skill-extraction.ts`
  - Tightened extraction coverage in `src/__tests__/procedural-skill-extraction.test.ts`
  - Expanded procedural-skill search to include `trace_id` and `source_hash` in `src/gateway/src/pages/procedural-skills-view.ts`
  - Surfaced created/published/source-hash metadata in `src/gateway/src/pages/ProceduralSkills.tsx`
- Tests added or tightened:
  - extracted draft markdown includes trigger signals and trace provenance
  - UI helper query matches drafts by trace id and source hash
- Verification result:
  - `bun test src/__tests__/procedural-skill-extraction.test.ts src/gateway/src/pages/procedural-skills-view.test.ts` -> `7 pass, 0 fail`
  - `bunx tsc --noEmit` -> pass
  - `bun run gateway:build` -> pass
- Residual risk: provenance is visible now, but there is still no stronger feedback loop for whether a published skill actually helped or hurt a live run beyond simple usage counts
- Next target: Phase 1 Loop 1.9, procedural skill outcome telemetry beyond raw usage counts

### Loop 1.9

- Target: Procedural skill outcome telemetry beyond raw selection counts
- Evidence: the system knew when an auto-skill was injected, but it could not distinguish a skill that merely got selected from one that actually participated in a successful run
- Hypothesis: splitting "selected" from "successful" reuse will give NyxHive a defensible signal for future pruning and ranking, without pretending to infer more than the runtime can currently prove
- Change made:
  - Added `success_count` and `last_success_at` tracking in `src/memory/procedural-skills.ts`
  - Added `resolveAgentSkills()` in `src/agents/skill-loader.ts` so invocation can see which published auto-skills were selected
  - Wired native API completion to record successful reuse in `src/agents/invoke-native-api.ts`
  - Added coverage in `src/__tests__/procedural-skill-drafts.test.ts`, `src/__tests__/skill-loader.test.ts`, and `src/__tests__/invoke-native-api.test.ts`
- Tests added or tightened:
  - store records successful reuse timestamps/counts
  - skill loader returns selected auto-skill metadata for downstream telemetry
  - native API marks selected procedural skills as successful after a completed run
- Verification result:
  - `bun test src/__tests__/procedural-skill-drafts.test.ts src/__tests__/skill-loader.test.ts src/__tests__/invoke-native-api.test.ts` -> `23 pass, 0 fail`
  - `bunx tsc --noEmit` -> pass
  - `bun run gateway:build` -> pass
- Residual risk: the backend now distinguishes selection from successful reuse, but operators still cannot see that signal in the review UI
- Next target: Phase 1 Loop 1.10, expose procedural skill outcome telemetry in gateway

### Loop 1.10

- Target: Operator-visible procedural skill outcome telemetry
- Evidence: successful reuse was now recorded in the backend, but the review surface still only showed raw usage counts, hiding the difference between "selected" and "worked"
- Hypothesis: surfacing successful reuse totals and per-draft outcome details in gateway will make the procedural-skill loop reviewable enough to support manual pruning and promotion decisions
- Change made:
  - Extended `ProceduralSkillDraftRecord`/summary helpers in `src/gateway/src/pages/procedural-skills-view.ts`
  - Added success telemetry assertions in `src/gateway/src/pages/procedural-skills-view.test.ts`
  - Surfaced successful reuse totals and per-draft success metadata in `src/gateway/src/pages/ProceduralSkills.tsx`
- Tests added or tightened:
  - summary helper counts successful reuse totals
  - review filtering still works with the expanded draft record shape
- Verification result:
  - `bun test src/gateway/src/pages/procedural-skills-view.test.ts src/__tests__/procedural-skill-drafts.test.ts src/__tests__/invoke-native-api.test.ts` -> `11 pass, 0 fail`
  - `bunx tsc --noEmit` -> pass
  - `bun run gateway:build` -> pass
- Residual risk: telemetry is visible now, but the loop still lacks automated pruning or confidence scoring for low-value published skills
- Next target: Phase 1 Loop 1.11, low-signal published skill audit/pruning heuristics

### Loop 1.11

- Target: Low-signal published skill audit heuristics
- Evidence: once successful reuse became visible, published skills with repeated selection and poor outcomes still blended into the same list as healthy ones
- Hypothesis: flagging weak published skills with a conservative audit heuristic will give operators a clean queue for pruning without auto-deleting anything prematurely
- Change made:
  - Added `needsProceduralSkillAudit()` and audit summary counts in `src/gateway/src/pages/procedural-skills-view.ts`
  - Tightened helper coverage in `src/gateway/src/pages/procedural-skills-view.test.ts`
  - Surfaced `Needs Audit` telemetry and badges in `src/gateway/src/pages/ProceduralSkills.tsx`
- Tests added or tightened:
  - weak published skills are flagged for audit
  - healthy published skills and drafts are not flagged
  - summary counts audit candidates alongside status/outcome totals
- Verification result:
  - `bun test src/gateway/src/pages/procedural-skills-view.test.ts` -> `4 pass, 0 fail`
  - `bunx tsc --noEmit` -> pass
  - `bun run gateway:build` -> pass
- Residual risk: audit heuristics are still local and operator-facing only; there is not yet any backend pruning pass or API filter dedicated to weak skills
- Next target: Phase 1 Loop 1.12, backend audit filtering/pruning support for published procedural skills

### Loop 1.12

- Target: Shared procedural-skill analytics foundation
- Evidence: audit and outcome logic had started to diverge between the gateway helper layer, the route layer, and the live auto-skill selector
- Hypothesis: centralizing success-rate, audit, query, and sort heuristics will keep the self-improvement loop coherent as more surfaces depend on it
- Change made:
  - Added `src/memory/procedural-skill-analytics.ts`
  - Added `src/__tests__/procedural-skill-analytics.test.ts`
  - Reused the shared analytics helpers from the gateway view layer
- Tests added or tightened:
  - success-rate calculation
  - audit detection and reason building
  - provenance query matching
  - outcome and audit-aware ordering
- Verification result:
  - `bun test src/__tests__/procedural-skill-analytics.test.ts ...` -> pass
  - `bunx tsc --noEmit` -> pass
  - `bun run gateway:build` -> pass
- Residual risk: backend listing still did not expose query/audit/sort controls
- Next target: Phase 1 Loop 1.13, backend audit filtering and outcome-aware listing

### Loop 1.13

- Target: Backend audit filtering and outcome-aware listing
- Evidence: the procedural-skill API could list drafts by status, but operators still had to pull everything client-side and infer which published skills were weak
- Hypothesis: query, audit-only filtering, and explicit sort modes in the route layer will make the skill system operable at scale and enable clean-up flows
- Change made:
  - Upgraded `src/server/routes/procedural-skills.ts` with `query`, `audit`, and `sort` support
  - Tightened route coverage in `src/__tests__/procedural-skills-routes.test.ts`
- Tests added or tightened:
  - list audit candidates by query
  - sort published skills by audit priority
- Verification result:
  - targeted route tests -> pass
  - `bunx tsc --noEmit` -> pass
  - `bun run gateway:build` -> pass
- Residual risk: gateway still lacked first-class audit/sort controls
- Next target: Phase 1 Loop 1.14, gateway audit and outcome controls

### Loop 1.14

- Target: Gateway audit and outcome controls
- Evidence: the backend could now filter and sort weak skills, but the review page still behaved like a basic newest-first list
- Hypothesis: adding audit-only and outcome sort controls in gateway will turn the review queue into a real procedural-memory operations console
- Change made:
  - Extended `src/gateway/src/pages/procedural-skills-view.ts`
  - Updated `src/gateway/src/pages/ProceduralSkills.tsx`
  - Added/updated view coverage in `src/gateway/src/pages/procedural-skills-view.test.ts`
- Tests added or tightened:
  - audit-only filtering
  - best-outcomes ordering
- Verification result:
  - targeted view tests -> pass
  - `bunx tsc --noEmit` -> pass
  - `bun run gateway:build` -> pass
- Residual risk: live auto-skill ranking was still mostly lexical
- Next target: Phase 1 Loop 1.15, outcome-aware procedural skill selection

### Loop 1.15

- Target: Outcome-aware procedural skill selection
- Evidence: NyxHive could track weak published skills, but the live injector could still select them when they had strong generic overlap
- Hypothesis: folding success-rate and audit penalties into the selector will make NyxHive’s skill reuse behave more like practical engineering memory than transcript search
- Change made:
  - Upgraded scoring in `src/agents/skill-loader.ts`
  - Added selection regressions in `src/__tests__/skill-loader.test.ts`
- Tests added or tightened:
  - weak audited skills lose to precise healthy skills
  - success signals contribute to ranking
- Verification result:
  - targeted loader tests -> pass
  - `bunx tsc --noEmit` -> pass
  - `bun run gateway:build` -> pass
- Residual risk: the assistant posture still defaulted to proposal-aware ambient context
- Next target: Phase 1 Loop 1.16, direct workflow mode

### Loop 1.16

- Target: Direct workflow mode in config
- Evidence: companion context still pulled proposal state into resumed engineering conversations, which pushes NyxHive toward a workflow engine instead of a direct operator agent
- Hypothesis: making direct execution the explicit default workflow mode will keep proposals available without letting them dominate normal work
- Change made:
  - Added `daemon.workflow_mode` to `src/config-schema.ts` and `src/types.ts`
  - Added a default regression in `src/__tests__/config.test.ts`
- Tests added or tightened:
  - config defaults `workflow_mode` to `direct`
- Verification result:
  - targeted config tests -> pass
  - `bunx tsc --noEmit` -> pass
  - `bun run gateway:build` -> pass
- Residual risk: the companion bootstrap builder itself still needed to honor the new mode
- Next target: Phase 1 Loop 1.17, companion bootstrap mode split

### Loop 1.17

- Target: Companion bootstrap mode split
- Evidence: the processor still built ambient companion context inline, mixing proposal, fleet, and recent-change logic in one place with no direct test seam
- Hypothesis: extracting a pure companion-context helper will make the workflow bias testable and allow direct mode to prioritize self-improvement status instead of pending proposals
- Change made:
  - Added `src/queue/companion-context.ts`
  - Added `src/__tests__/companion-context.test.ts`
  - Wired `src/queue/processor.ts` to use the shared companion-context builder
- Tests added or tightened:
  - direct mode omits pending proposals
  - proposal-first mode includes pending proposals
- Verification result:
  - targeted companion-context tests -> pass
  - `bunx tsc --noEmit` -> pass
  - `bun run gateway:build` -> pass
- Residual risk: direct mode now suppresses proposal-first posture, but still needed a better ambient signal in its place
- Next target: Phase 1 Loop 1.18, self-improvement status in direct companion context

### Loop 1.18

- Target: Self-improvement status in direct companion context
- Evidence: removing ambient proposal pressure entirely would leave companion bootstrap thinner unless NyxHive surfaced useful operational context about its own procedural-memory loop
- Hypothesis: exposing draft/audit status in direct-mode companion bootstrap will keep the assistant self-aware without turning every chat into a proposal review queue
- Change made:
  - Added procedural-skill status summarization to `src/queue/companion-context.ts`
  - Threaded procedural-skill store state into the processor bootstrap flow
- Tests added or tightened:
  - direct mode surfaces draft and audit counts
- Verification result:
  - targeted companion-context tests -> pass
  - `bunx tsc --noEmit` -> pass
  - `bun run gateway:build` -> pass
- Residual risk: direct-mode posture was stronger, but some UI still foregrounded older automation wording
- Next target: Phase 1 Loop 1.19, operator-surface cleanup

### Loop 1.19

- Target: Operator-surface cleanup for the direct-agent posture
- Evidence: gateway labels still used “Automations” language even after the runtime had been stripped down and direct execution was becoming the primary path
- Hypothesis: small label cleanup in the settings and command palette will reduce old system baggage and make the new posture legible
- Change made:
  - Renamed the settings tab label in `src/gateway/src/pages/Settings.tsx`
  - Updated command palette wording in `src/gateway/src/components/CommandPalette.tsx`
- Tests added or tightened: none
- Verification result:
  - `bunx tsc --noEmit` -> pass
  - `bun run gateway:build` -> pass
- Residual risk: low-signal published skills were easier to see, but still tedious to clean up in batches
- Next target: Phase 1 Loop 1.20, bulk audit cleanup

### Loop 1.20

- Target: Bulk audit cleanup for weak published skills
- Evidence: once the UI could flag weak skills, operators still had to reject them one by one, which makes the self-improvement loop accumulate junk faster than it can be curated
- Hypothesis: a guarded bulk-reject path limited to audited published skills will make skill pruning practical without giving the system unsafe auto-deletion power
- Change made:
  - Added `POST /api/skills/procedural/audit/reject` in `src/server/routes/procedural-skills.ts`
  - Added regression coverage in `src/__tests__/procedural-skills-routes.test.ts`
- Tests added or tightened:
  - bulk reject only touches audited published skills
  - healthy published skills are left alone
- Verification result:
  - targeted route tests -> pass
  - `bunx tsc --noEmit` -> pass
  - `bun run gateway:build` -> pass
- Residual risk: cleanup existed in the backend, but still needed a fast operator action in gateway
- Next target: Phase 1 Loop 1.21, bulk audit cleanup in gateway

### Loop 1.21

- Target: Bulk audit cleanup in gateway
- Evidence: the backend could reject weak published skills in batches, but the operator still had to know that endpoint existed and call it manually
- Hypothesis: surfacing bulk reject for the visible audited queue will make NyxHive’s procedural-memory loop feel maintainable enough to keep enabled all the time
- Change made:
  - Added `Reject Audited Visible` flow in `src/gateway/src/pages/ProceduralSkills.tsx`
  - Added audit suggestions and stronger operational cues to the same page
- Tests added or tightened:
  - covered by route tests plus existing view/helper regressions
- Verification result:
  - targeted route/view tests -> pass
  - `bunx tsc --noEmit` -> pass
  - `bun run gateway:build` -> pass
- Residual risk: the backend now supports audit-aware cleanup, but the next loop should move from manual curation toward explicit confidence scoring or scheduled pruning review
- Next target: Phase 2, direct-run control plane and further de-emphasis of the proposal system

### Loop 2.1

- Target: Idempotent `chat.send` with explicit run semantics
- Evidence: the cockpit still had to infer whether a send had started, duplicated, or completed; retries could only be guessed from timing
- Hypothesis: adding `idempotencyKey`, `runId`, and explicit `started | in_flight | ok | queued` semantics will make direct-run chat control much more deterministic
- Change made:
  - Extended `chat.send` request/response schemas in `src/gateway/protocol/methods.ts`
  - Added gateway-side idempotent request tracking in `src/server/ws/register-chat-handlers.ts`
  - Threaded idempotency keys through `src/gateway/src/stores/chat.ts` and `src/gateway/src/stores/fleet-chat.ts`
- Tests added or tightened:
  - repeated `chat.send` while in flight returns the same identifiers with `in_flight`
  - repeated `chat.send` after completion returns the same identifiers with `ok`
  - gateway protocol/store tests cover the new payload shape
- Verification result:
  - targeted gateway protocol / handler / store tests -> pass
  - `bun test` -> `4217 pass, 3 skip, 0 fail`
  - `bunx tsc --noEmit` -> pass
  - `bun run gateway:build` -> pass
- Residual risk: transcript display still relied on frontend cleanup for hidden reasoning markup
- Next target: Phase 2 Loop 2.2, server-side history normalization

### Loop 2.2

- Target: Server-side history normalization
- Evidence: reasoning blocks were still leaking through raw assistant content, which forced UI parsing to recover a clean answer vs. reasoning split
- Hypothesis: normalizing assistant message content before it reaches the gateway will make the chat surface simpler and less fragile
- Change made:
  - Added shared message normalization helpers in `src/chat/message-content.ts`
  - Normalized `chat.history` in `src/server/ws/register-chat-handlers.ts`
  - Updated `src/gateway/src/components/chat/MessageList.tsx` and `src/gateway/src/components/chat/message-execution.ts` to consume explicit reasoning where available
- Tests added or tightened:
  - history returns `content` and `reasoning` separately for assistant turns with `<thinking>` blocks
  - shared runtime helpers preserve the split in gateway tests
- Verification result:
  - targeted handler/runtime tests -> pass
  - `bun test` -> `4217 pass, 3 skip, 0 fail`
  - `bunx tsc --noEmit` -> pass
  - `bun run gateway:build` -> pass
- Residual risk: runtime status still collapsed “socket connected” and “agent actively working” into nearly the same cockpit state
- Next target: Phase 3 Loop 3.1, fallback hardening under provider rate limits

### Loop 3.1

- Target: Rate-limit-aware fallback hardening
- Evidence: a primary provider `429` could still fall through multiple same-provider fallback steps, wasting time on a provider that had already told us to back off
- Hypothesis: once a provider rate-limits, NyxHive should skip same-provider fallbacks and move immediately to a distinct provider when possible
- Change made:
  - Added rate-limit detection and same-provider fallback suppression in `src/agents/invoke.ts`
  - Added cross-provider fallback coverage in `src/__tests__/invoke-routing.test.ts`
- Tests added or tightened:
  - skips same-provider fallback steps after `429`
  - still attempts a cross-provider fallback after `429`
- Verification result:
  - targeted invoke-routing tests -> pass
  - `bunx tsc --noEmit` -> pass
  - `bun run gateway:build` -> pass
- Residual risk: cockpit presence still could not distinguish an authenticated idle instance from one actively running work on another thread
- Next target: Phase 2 Loop 2.5, explicit runtime presence semantics

### Loop 2.5

- Target: Explicit runtime presence semantics in cockpit
- Evidence: the gateway already emitted `runId` on turn lifecycle events, but the client dropped it and the cockpit status model still treated “connected socket” as the primary truth
- Hypothesis: carrying `runId` through runtime events and tracking per-instance runtime presence will make the cockpit read like a real operator control plane instead of a connection monitor
- Change made:
  - Added `runId` to typed turn lifecycle events in `src/gateway/protocol/events.ts` and `src/gateway/src/lib/chat-runtime.ts`
  - Added per-instance runtime presence tracking to `src/gateway/src/stores/fleet-chat.ts`
  - Added presence helpers and cockpit status updates in `src/gateway/src/components/cockpit/instance-presence.ts`, `InstanceRail.tsx`, `InstanceFocus.tsx`, and `Cockpit.tsx`
- Tests added or tightened:
  - runtime helpers preserve run ids on turn lifecycle frames
  - fleet chat tracks active vs idle runtime state and non-selected-thread presence
  - cockpit presence helper covers working / quiet / disconnected states
- Verification result:
  - targeted runtime/store/presence tests -> pass
  - `bun test` -> `4229 pass, 3 skip, 0 fail`
  - `bunx tsc --noEmit` -> pass
  - `bun run gateway:build` -> pass
- Residual risk: durable knowledge was still only raw chunks plus recall memory, with no compact maintained digest lane
- Next target: Phase 4 Loop 4.1, first compiled-knowledge lane

### Loop 4.1

- Target: First compiled-knowledge lane on top of the existing knowledge store
- Evidence: NyxHive already had strong raw knowledge chunk storage, but operators and future prompts still had to work directly from chunk-level material with no maintained digest surface
- Hypothesis: creating stable source-path digests from existing knowledge chunks will give NyxHive a real second memory layer without needing a large autonomous summarization system on day one
- Change made:
  - Added `src/memory/compiled-knowledge.ts`
  - Added source-path chunk retrieval to `src/memory/knowledge.ts`
  - Added digest routes in `src/server/routes/knowledge.ts`
  - Wired compiled knowledge into `src/server/index.ts`, `src/framework/create-hive.ts`, `src/framework/stores.ts`, and `src/framework/types.ts`
- Tests added or tightened:
  - digest compilation from ordered knowledge chunks
  - compiled knowledge store upsert/list/get behavior
  - route coverage for compile/list/get with auth enforcement
- Verification result:
  - targeted compiled-knowledge tests -> pass
  - `bun test` -> `4229 pass, 3 skip, 0 fail`
  - `bunx tsc --noEmit` -> pass
  - `bun run gateway:build` -> pass
- Residual risk: compiled knowledge exists as an operator/API surface, but prompt-time selective injection and review/audit loops for compiled pages still remain
- Next target: Phase 2 Loop 2.3 or Phase 4 Loop 4.2, depending on whether the next bottleneck is session mutation ordering or compiled-knowledge retrieval/use

### Loop 2.3

- Target: Session mutation ordering for gateway chat
- Evidence: follow-up session mutations like abort/history/model changes could still race each other for the same thread/device session, which left the cockpit compensating for read-after-write ambiguity
- Hypothesis: serializing non-send session mutations per thread/device will make chat control-plane behavior deterministic without blocking unrelated sessions
- Change made:
  - Added `src/server/ws/chat-session-queue.ts`
  - Routed `chat.abort`, `chat.forget`, `chat.trim`, `chat.reset`, `chat.history`, and `chat.model.set` through the shared session queue in `src/server/ws/register-chat-handlers.ts`
- Tests added or tightened:
  - same-session tasks serialize in order
  - different session keys still progress independently
- Verification result:
  - targeted queue/handler tests -> pass
  - `bun test` -> `4231 pass, 3 skip, 0 fail`
  - `bunx tsc --noEmit` -> pass
  - `bun run gateway:build` -> pass
- Residual risk: `chat.send` still returned `queued` without any server-side guarantee that the follow-up send would actually run later
- Next target: Phase 4 Loop 4.2, compiled knowledge retrieval/use, then close the remaining `chat.send` actor gap

### Loop 4.2

- Target: Prompt-time compiled knowledge injection
- Evidence: the compiled knowledge lane existed in storage and API routes, but live runs still could not benefit from those digests unless an operator copied them manually
- Hypothesis: a bounded path/title/task-aware ranking step can inject the best compiled digests into live prompts without causing the prompt bloat or drift risk of dumping all digest pages
- Change made:
  - Added compiled digest ranking and prompt formatting in `src/memory/compiled-knowledge.ts`
  - Threaded `compiledKnowledge` into `src/queue/processor.ts` and `src/framework/create-hive.ts`
  - Merged curated compiled-digest context into normal knowledge retrieval in `searchKnowledgeDetailed`
- Tests added or tightened:
  - path-aware digest ranking beats generic notes when working on matching gateway files
  - compiled digest context formats cleanly for prompt injection
  - direct processor run injects compiled knowledge into companion/native invocation opts
- Verification result:
  - targeted compiled-knowledge + processor tests -> pass
  - `bunx tsc --noEmit` -> pass
- Residual risk: the gateway still had one misleading control-plane contract where queued sends were acknowledged but not actually serialized/executed server-side
- Next target: Phase 2 Loop 2.6, real server-side `chat.send` serialization

### Loop 2.6

- Target: Real server-side serialization for queued `chat.send`
- Evidence: the gateway returned `status: "queued"` for a follow-up send on an active thread, but the backend relied on the client to retry later instead of actually running that follow-up itself
- Hypothesis: a dedicated per-session send queue will make `queued` truthful, preserve turn order, and make the cockpit/control plane behave more like a real session actor
- Change made:
  - Extended `src/server/ws/chat-session-queue.ts` with queue busy checks
  - Reworked `src/server/ws/register-chat-handlers.ts` so both crawl sends and normal sends are scheduled through a per-session send queue
  - Added explicit turn reservation for serialized sends so queued follow-ups keep deterministic turn order
- Tests added or tightened:
  - queued follow-up send on the same thread is actually executed after the active send completes
  - idempotent in-flight and completed send behavior remains intact
- Verification result:
  - targeted handler/runtime tests -> pass
  - `bunx tsc --noEmit` -> pass
- Residual risk: full hard gates still need to be rerun for this checkpoint, and compiled knowledge remains injected only through prompt-time heuristics rather than a broader operator review loop
- Next target: full hard-gate rerun, then the next memory/control-plane refinement loop

### Loop 4.3

- Target: Make compiled knowledge available through the agent tool loop, not just background prompt injection
- Evidence: compiled digests were helping prompt assembly, but agents still could not explicitly inspect that curated memory lane through `search_knowledge` during a run
- Hypothesis: exposing compiled digests through the existing retrieval tool will make the second memory layer operational and inspectable without adding a whole new tool surface
- Change made:
  - Extended `ToolContext` / `InvokeOpts` to carry `compiledKnowledge`
  - Wired compiled knowledge through `src/agents/invoke-native-api.ts` and relevant `src/queue/processor.ts` invoke callsites
  - Updated `src/agents/tools.ts` so `search_knowledge` can return compiled digests alongside vector knowledge, or by itself when vector search is unavailable
- Tests added or tightened:
  - `search_knowledge` returns compiled digests without a vector store
  - processor companion/native path still injects compiled digest context
- Verification result:
  - targeted tools + processor + compiled-knowledge tests -> pass
  - `bun test` -> `4236 pass, 3 skip, 0 fail`
  - `bunx tsc --noEmit` -> pass
  - `bun run gateway:build` -> pass
- Residual risk: the compiled memory lane is now usable, but it still lacks broader operator review/search UX and deeper memory consolidation logic
- Next target: the next memory loop should focus on compiled-knowledge operator surfaces or review/consolidation behavior

### Loop 4.4

- Target: Operator review surface for compiled knowledge
- Evidence: compiled digests were usable by runtime prompts and tools, but the gateway still only showed raw knowledge chunks and search results
- Hypothesis: putting digest review next to the existing Knowledge page will make the new memory lane inspectable without adding a separate product surface
- Change made:
  - Added WebSocket methods for `knowledge.digests.list`, `knowledge.digests.compile`, and `knowledge.digests.stale`
  - Wired compiled knowledge into WS handler deps and server registration
  - Extended the gateway knowledge store and Knowledge page with digest listing, compile-from-source, and stale/restore controls
- Tests added or tightened:
  - handler coverage for digest list/compile/stale
  - protocol catalog validation for new methods
  - gateway production build verifies the new UI surface
- Verification result:
  - targeted handler/protocol/compiled-knowledge tests -> pass
  - `bunx tsc --noEmit` -> pass
  - `bun run gateway:build` -> pass
- Residual risk: digest staleness still depended on manual stale toggles
- Next target: Phase 4 Loop 4.5, source-hash stale audit

### Loop 4.5

- Target: Source-hash stale audit for compiled knowledge
- Evidence: compiled digests can drift when their underlying chunks change or disappear, and stale manual toggles are not enough to maintain trust
- Hypothesis: auditing digest `source_hash` against the current source chunks will let NyxHive flag obsolete compiled knowledge without needing a larger autonomous memory review system yet
- Change made:
  - Added `CompiledKnowledgeStore.auditStaleness()` in `src/memory/compiled-knowledge.ts`
  - Added `knowledge.digests.audit` WebSocket method
  - Added gateway “Audit stale” control and audit result summary
- Tests added or tightened:
  - compiled store marks pages stale when source hashes diverge
  - handler coverage for digest audit
  - protocol catalog validation for the new method
- Verification result:
  - targeted handler/protocol/compiled-knowledge tests -> pass
  - `bunx tsc --noEmit` -> pass
  - `bun run gateway:build` -> pass
- Residual risk: full hard gates still need a final rerun after this loop, and deeper memory consolidation/promotion policies remain future work
- Next target: full hard-gate rerun, then decide whether to push/sync or continue into the next operator/control-plane phase

### Loop 5.1

- Target: Cockpit saved-thread search and resume stability
- Evidence: the cockpit “Find a thread...” rail only searched the currently loaded recent thread slice, while `ThreadDB.searchThreads()` already had full-text coverage for older saved sessions
- Hypothesis: wiring backend full-text search through WS/protocol/store/UI will make session resume reliable, but the store needs stale-response protection because fast query changes can race
- Change made:
  - Added `threads.search` WS/protocol plumbing and mapped results back to gateway thread shape with snippets
  - Updated `ThreadDB.searchThreads()` to return full thread records plus snippet and activity metadata
  - Added saved-thread search state to the fleet chat store, including request sequencing so older search responses cannot repaint newer results
  - Updated the cockpit thread rail to show saved-thread search loading/empty states and safe text snippets
- Tests added or tightened:
  - handler coverage for `threads.search`
  - `ThreadDB.searchThreads()` type/assertion drift fixed to assert the full thread shape
  - fleet chat store regression for stale saved-thread search results
- Verification result:
  - targeted handler/protocol/thread-search/store tests -> pass
  - `bun test` -> `4243 pass, 3 skip, 0 fail`
  - `bunx tsc --noEmit` -> pass
  - `bun run gateway:build` -> pass
- Residual risk: this makes saved-session retrieval deterministic, but the next memory loop should still add promotion/consolidation rules so the compiled knowledge lane learns from repeated successful workflows instead of only source-chunk digests
- Next target: Phase 4.6 memory consolidation/promotion, or push/sync this stable checkpoint before continuing if remote deployment is the priority

### Loop 4.6

- Target: Promote repeated successful workflows into compiled operational memory
- Evidence: NyxHive already extracted procedural skill drafts from successful runs, but compiled knowledge only learned from source chunks and manual digest compilation
- Hypothesis: qualified procedural drafts should become compiled workflow digests immediately, so Nyx can retrieve the operational pattern before a human publishes it as a live skill
- Change made:
  - Added `compileProceduralSkillDigest()` to convert procedural skill drafts into compiled workflow pages
  - Extended procedural skill draft recording to optionally upsert a compiled workflow digest
  - Wired the queue processor so successful qualified workflow runs promote into compiled knowledge when the store is configured
- Tests added or tightened:
  - compiled knowledge can build and retrieve a workflow digest from a procedural skill draft
  - procedural skill extraction promotes qualified drafts into compiled workflow knowledge
  - existing compiled-knowledge/tool/processor companion tests remain green
- Verification result:
  - targeted compiled-knowledge/procedural-extraction/processor/tools tests -> pass
  - `bun test` -> `4245 pass, 3 skip, 0 fail`
  - `bunx tsc --noEmit` -> pass
  - `bun run gateway:build` -> pass
- Residual risk: rejected or underperforming published procedural skills do not yet automatically stale their compiled workflow digest; the audit path can flag published skills, but compiled workflow stale-state still needs a sync policy
- Next target: add workflow-digest stale sync for rejected/audit-failed procedural skills, or sync/pull/launch if deployment verification is now the priority

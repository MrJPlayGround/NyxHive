# Reflections

## 2026-04-05 (cycle 10)

- `bun test`: 4194 pass, 3 skip, 0 fail. `bunx tsc --noEmit`: 6 errors in dirty tree (briefing.test.ts, chat.ts, chat.test.ts, soul/compiler.ts x3). Confirmed which are in committed code vs dirty-tree-only.
- Two new TS errors introduced by `87123b4` (--prompt/--pipe mode): `chat.ts:603` inst null in `resumeStoredSession()` closure (narrowing doesn't flow through `process.exit(1)` into closures); `RunPipeModeOptions.input` typed as `AsyncIterable<string>` but test correctly passes `string[]` (widen to `Iterable | AsyncIterable`). Proposal: TBD.
- `briefing.test.ts:32` committed TS2322: `makeTask()` base object missing `notify_thread_id: null` and `webhook_url: null` after scheduler reply-threading + completion-webhook commits added those as required fields. Proposal: TBD.
- Protocol gap in pipe mode: `/retry` happy path never emits `command_done`, unlike every other command. Integrators can't detect completion without tracking the chat `done` event. Proposal: TBD.
- Pattern: each major feature commit (`87123b4`, scheduler webhook commits) leaves a few stale type or protocol edges. Worth checking for these systematically in follow-up cycles.

## 2026-04-04 (cycle 9)

- `bun test`: 4158 pass, 3 skip, 0 fail. `bunx tsc --noEmit`: 3 TS2352 errors in `src/soul/compiler.ts` — direct `as Record<string, unknown>` casts on `SoulIdentity` and `SoulRelationship` at lines 317, 399, 437, introduced by `9b780a6` (soul identity/context sub-field rendering). Fix: double-cast through `unknown`. Proposal: proposal-9455402a.
- Dirty tree: 5 modified files + 3 untracked test files form a complete, tested session undo + provider sender override feature. Uncommitted state blocks future work. Key changes: `countThreadMessages()`, `undoLastExchange` cost recalculation, CLI `/undo` calls server, provider `sender`/`senderId` overrides. Proposal: proposal-be327a22.
- Coverage gap: `8cf1e41` crash-loop fix added the critical rule "429 must not trip circuit breaker" but `router.test.ts` has zero tests for 429 behaviour — all circuit breaker tests use generic errors. Regression would be invisible until production. Proposal: proposal-63915eb2.
- Pattern: soul system is growing extra-field rendering complexity faster than its type safety. Two cycles running, new soul rendering commits introduce TS errors. Type discipline needs to keep pace.

## 2026-04-03 (cycle 3)

- Evolution cycle: `bun test` — 5-6 consistent failures (count varies due to flakiness), `bunx tsc --noEmit` clean. Shifted focus to identifying actual test failures rather than code-path bugs.
- Found dirty `invoke.ts` working tree stripped the `always_cli` OpenRouter fallback that was committed in HEAD (ffcfc21). Dirty `invoke-routing.test.ts` has 3 new tests expecting that fallback. Result: 3 always_cli test failures. Proposal: proposal-e4558da7.
- Found `DEFAULT_FALLBACK_ORDER` in committed `src/defaults.ts` was changed to `["anthropic", "openai"]` removing openrouter. `router.test.ts` "falls back when primary fails" registers openrouter as the stub fallback and expects it to be used — but it's no longer in the chain. 1 test failure. Proposal: proposal-c12f1cca.
- Found `runsRoutes GET /:runId` returns `id: run.run_id` but `runs-api.test.ts` expects `body.run_id`. Field name mismatch causes 1 test failure. Proposal: proposal-41128974.
- Pattern: working-tree churn is drifting away from committed HEAD. Dirty invoke.ts strips committed fallback logic. Tests and implementations in the dirty tree are internally inconsistent. Evolution cycles need a clean-tree gate before proposing code improvements.

## 2026-04-02 (cycle 2)

- Evolution cycle: `bun test` green (4042 pass, 3 skip, 0 fail), `bunx tsc --noEmit` clean. Broke out of the gateway-handler loop that dominated the last 5+ cycles and explored three fresh areas: retry utility, context compaction, and scheduler bootstrap.
- Found a real NaN busy-spin bug in retry-after header parsing (src/utils/retry.ts:17) — malformed headers produce NaN delay, setTimeout resolves immediately. Zero test coverage for this path.
- Found a data-loss race in emergency compaction (src/context/compaction.ts:521-549) — flush-then-trim ordering means a message arriving during async flush can fall through both sides.
- Found sentinel agent assignment checks config but not registry (src/scheduler/bootstrap.ts:402) — tasks silently assigned to non-existent agent. Existing test masks this by adding sentinel to both.
- Pattern: the stability/infra code that landed in 64a347d has good intent but missing edge-case coverage. The retry-after NaN is the highest-risk item — it turns a rate-limit response into a CPU spin.

## 2026-03-20

- Evolution cycle 15: `bun test` is green (`3609 pass, 3 skip, 0 fail`) and `bunx tsc --noEmit` is clean. Recent work concentrated on workspace-centric isolation, trust-aware sanitization, and gateway/proposal UX.
- Workspace-centric soul loading is still incomplete outside the main invocation path. `AgentRegistry` seeds soul-derived config via `loadAndCompileSoul(key)` with no `instanceSoulsDir`, the `/api/agents/:id/soul` route does the same, and Codex MCP-tool resolution also skips the instance layer. That means instance-specific `instance.yaml` or local soul overrides do not reliably surface in registry state or API responses.
- SDK invocations still resolve soul prompts with `getSoulSystemPrompt(agent.name.toLowerCase(), ...)` instead of the stable agent key, and they also omit `instanceSoulsDir`. Any agent whose display name diverges from its key silently loses its compiled soul on the SDK path.
- `nyxhive init` still scaffolds the legacy root layout (`config.toml`, `souls/`, `.env` at repo root) even though the current resolver and migration docs center `.nyxhive/`. New instances still boot, but the scaffold now drifts from the platform's intended portable layout.

## 2026-03-19

- Evolution cycle 14: 3566 pass, 0 fail. Recent work: dual-brain config (codex/anthropic routing by task type), pre-commit secret scanning hook, gateway WebSocket handler expansion.
- Found `getAllChunks()` called per-request in 2 endpoints (knowledge.recent WS handler, memory-bank HTTP route). Both load the entire knowledge table into memory then slice in JS — O(n) when SQL LIMIT would be O(1). Proposed adding `getRecentChunks(limit, offset?)` with proper SQL pagination.
- `threads.delete` handler awaits `extractMemories()` (LLM call) before returning, causing 10-30s delete latency in the gateway UI. The extraction is best-effort (already try-caught) so it should be fire-and-forget. Proposed deferring extraction to background.
- Dual-brain implementation is solid: provider validation happens after brain config, with graceful degradation to single-brain when a provider is unavailable. Test coverage includes both brain specs, -only suffix, and task type routing.
- Dismissed crawl-bypasses-sanitizer as false positive: crawl commands go directly to the crawl service (not the LLM), so prompt injection detection is irrelevant. SSRF protection was already addressed in cycle 9's URL validation proposal.

## 2026-03-18

- Evolution cycle 13: 3543 pass, 0 fail. Major recent work: input sanitization, Slack hardening, role management, thread context, boot-time env validation, daily improvement loop task.
- Input sanitization (prompt injection detection) was added to Slack but NOT to Discord, Telegram, iMessage, webhook, or REST API. All non-Slack channels bypass it entirely. Proposed moving the check into QueueProcessor.processImmediate() — the central hub all channels flow through.
- bootstrap.ts hit 917 lines with 19 INSERT statements and 3 different column schemas. Some tasks missing `category` column, defaulting to NULL. Proposed extracting an `upsertSystemTask()` helper to eliminate the boilerplate and schema drift.
- Dismissed most agent-reported findings as false positives: stale task check logic is correct (increased next_run_at means already ran), sendOutbound 3-arg call matches the interface (agent is optional 3rd param), router model drop is intentional design, optional chaining on hasProvider works correctly as falsy check, knowledge empty-placeholders already guarded by length check, pairing "race condition" impossible in single-threaded JS.
- Separate trading-journal audit: `bun test` is red (`537 pass, 10 fail, 4 errors`) while `bunx tsc --noEmit` is green. The failures are runner drift: recent tests use Vitest-only helpers (`vi.setSystemTime`, `vi.stubGlobal`, `vi.hoisted`) but the required audit command is Bun's native runner.
- The new unattended loop has one bad probe: `scripts/health-check.sh` expects `POST /api/verify-discord-role` to return 200 without auth, but the handler returns 401 whenever the Discord bot is configured, so health checks will false-alarm in the healthy production case.
- `src/services/blockchainService.ts` is stale duplicate payment-verification logic. It still matches by 1% tolerance with no intent time window, while the live edge function moved to exact-cent plus created/expires matching. It is unused today, but it's drift that will bite if reused.

## 2026-03-17

- Evolution cycle 12: 3423 pass, 0 fail. Major new feature: BTW/steering system (interrupt agents mid-turn).
- Steer HTTP endpoint (btw-steer.ts:97) missing try-catch — BTW endpoint, Discord channel, and Slack channel all wrap their calls, only the REST route doesn't. Proposed fix.
- onProgress callback (processor.ts:1260) calls steersDb.getPending() without error handling. A SQLite failure here would crash the entire agent invocation — the interrupt check should never be able to kill the agent it's monitoring. Proposed defensive wrapping.
- `getRequeueCandidates()` in steers.ts:114 is dead code — defined but never called. The `on_expire: "requeue"` feature is half-implemented. Folded into the onProgress proposal.
- Dismissed several agent-reported findings as false positives: the "steer delivery race condition" is synchronous SQLite in single-threaded JS (no actual interleaving); BTW cache growth is bounded by concurrent message count (evicted on completion); BtwRateLimiter Map growth is negligible at production scale.

## 2026-03-23

- Evolution cycle: `bun test` stayed green (`3782 pass, 3 skip, 0 fail`), but `bunx tsc --noEmit` is now red on `src/memory/watcher.ts` because the new `FSWatcher` alias references a global type that is never imported.
- The new trading desk path has a real footgun in `src/channels/telegram.ts`: `/take` falls back to `entry_price = 0` when a signal has no entry zone, and `create_signal` currently allows that shape. That can log impossible positions and increment daily trade count off garbage data.
- Trading desk coverage is basically absent: no dedicated `telegram` or `trading` test file exists under `src/__tests__`, even though the feature shipped a 600-line DB layer plus live `/watch`, `/signals`, `/take`, `/risk`, and `/pnl` commands.

## 2026-03-13

- Evolution audit: `bun test` is green (`3277 pass, 3 skip, 0 fail`), but the new crawl path has three sharp edges worth proposals instead of code changes.
- `parseCrawlCommandText()` and `validateUrl()` accept non-HTTP schemes like `file:///etc/passwd`, so crawl entry points need protocol and host safety checks before they hit Cloudflare.
- Saved crawl sources are not idempotent: repeating the same `--save` crawl throws `SQLiteError: UNIQUE constraint failed: crawl_sources.name` because dynamic sources insert blindly on a unique `name`.
- Cron validation is still deferred too late: invalid schedules are stored, then `getDue()` or `nextOccurrence()` throws at runtime and one bad source can poison the whole crawl scheduler pass.

## 2026-03-15

- Evolution cycle 11: 3359 pass, 0 fail. Active development on command center UI, watchdog, activity system.
- Watchdog stuck-detection task (`scheduler/index.ts:735`) has zero test coverage despite killing processes and disabling agents. Proposed test suite.
- `activeDelegations` Map uses `${convId}:${agentKey}` as key — duplicate delegations to the same agent in one conversation collide, causing lost tracking entries. Proposed unique key suffix.
- Failed delegations (both local and remote) don't emit activity events, creating a blind spot in the activity feed. Proposed adding emitActivity calls in catch blocks.
- Validated several agent-reported findings as false positives: `lastTaskTypes` and `pendingClarifications` ARE pruned in `cleanExpiredState()`, the "running" status event IS emitted at processor line 1037, and `setPrUrl` nulling verdict is intentional (code changed since review).

## 2026-03-14

- Evolution audit stayed green, but three proposal-worthy regressions surfaced in active code paths.
- `validateFilePath()` still uses raw `startsWith()` prefix checks, so `../workspace-escape/secret.txt` is treated as inside `/tmp/work`; the SDK file tools can read or write outside the sandbox boundary when sibling paths share the prefix.
- Knowledge storage still keys chunks by `source_path + section`, which collapses repeated `## Heading` sections into one row; a two-section note with duplicate headings produced 2 chunks but only 1 stored chunk on ingest.
- Knowledge retrieval assumes the current embedding dimension for every stored row; reopening a store with a different dimension crashes search with `RangeError: Length out of range of buffer` instead of degrading gracefully or forcing re-embed.

## 2026-03-23 (cycle 2)

- Evolution audit stayed mostly healthy: `bun test` passed (`3782 pass, 3 skip, 0 fail`), but `bunx tsc --noEmit` failed on `src/memory/watcher.ts` because the new `FSWatcher` alias uses an unimported global type.
- Trading desk lifecycle work is only half-wired: `resetDailyRisk()` and `expireStaleSignals()` exist in `src/trading/db.ts` but nothing calls them, so daily limits never reset and expired setups remain active forever.
- The `/take` Telegram command still accepts malformed signals: if a signal has no entry zone it falls back to `entry_price = 0`, opens the position anyway, and increments `daily_trades` on junk data.
- Trading desk shipped without direct regression coverage. There are no `src/__tests__` references to `TradingDB`, `/watch`, `/take`, `/signals`, or `create_signal`, which is a bad place to leave a fresh 600-line feature.

## 2026-03-24

- Evolution audit is mixed: `bunx tsc --noEmit` is clean, but the full `bun test` run is red at `3817 pass, 3 skip, 1 fail`. The failure is `delegated agent history isolation` in `src/__tests__/processor.test.ts`, which now launches a real CLI sub-agent instead of isolating the history assertion, so the suite depends on external invocation speed/model availability and flakes around the 5s test timeout.
- Relay nonce dedup has a TTL bug in `src/server/routes/messages.ts`: expired nonces are only pruned once the in-memory map grows past 500 entries. In a low-traffic process, a nonce older than 5 minutes is still treated as a duplicate indefinitely. Reproduced by replaying the same nonce after advancing `Date.now()` by 6 minutes and still getting `{ status: "duplicate" }`.
- Trading validation still has open holes beyond the entry-zone guard in `src/trading/db.ts`: `checkRisk()` approves inverted stops because it uses `Math.abs(entry - stop)` with no direction check, and `closePosition()` accepts negative exit prices, which can write impossible P&L into `risk_state`. Reproduced with `checkRisk("long", 100, 105) => { allowed: true }` and `closePosition(..., -10)` producing `dailyPnl: -1100`.

## 2026-03-24 (relay cycle)

- Fresh audit is green again: `bun test` passed (`3818 pass, 3 skip, 0 fail`) and `bunx tsc --noEmit` is clean. Recent churn is concentrated in reverse relay callbacks, runtime path resolution, and the trading desk.
- Relay nonce dedup in `src/server/routes/messages.ts` is still time-wrong in quiet processes. The TTL is five minutes, but stale entries are only pruned when the map grows past 500 entries, so a nonce can stay blocked forever on a low-traffic instance.
- Relay callback tokens in `src/federation/relay.ts` are replayable. `validate()` returns the same token on repeated calls and the server middleware in `src/server/index.ts` does not consume it or enforce the recorded `issuedFor` remote.
- Reverse relay callbacks in `src/server/routes/relay.ts` collapse onto `channel=\"relay\", sender=\"relay\", sender_id=\"relay\"` when the remote does not supply identity fields, and `dispatchToRelayOrigin()` never supplies them. That means all callback turns share the same conversation ID, model overrides, and context history.

## 2026-03-27 (dirty tree cycle)

- Evolution audit is mixed: `bun test` passed (`3948 pass, 3 skip, 0 fail`), but `bunx tsc --noEmit` is red in the current dirty gateway tree. `src/gateway/src/stores/chat.ts` imports `ChatAttachment` from `MessageInput.tsx`, so the root TypeScript pass resolves a TSX file from a `.ts` module without JSX enabled, and the same file also passes `string | null` into `toDisplayPath()`.
- Gateway queued turns are still being persisted too early. In `src/server/ws/register-chat-handlers.ts`, `chat.send` appends the user message to `threadDb` before it checks `activeGatewayInvocations`, so a request can return `{ queued: true }` while the turn is already durable in thread history.
- Knowledge search input validation is still too loose. `src/server/routes/knowledge.ts` does `Number(c.req.query("threshold") ?? 0.5)`, so `GET /api/knowledge/search?q=test&threshold=wat` reaches `store.search(..., NaN, ...)` and disables the similarity cutoff instead of rejecting or clamping bad input.
- Current dirty-tree audit: `bun test` stayed green (`3948 pass, 3 skip, 0 fail`), but `bunx tsc --noEmit` still fails in `src/gateway/src/stores/chat.ts` because the store imports a type from `MessageInput.tsx` and also feeds `string | null` into `toDisplayPath()`.
- The media-transcription rollback is only half-finished. Gateway chat still advertises `audio/*`, `video/*`, and `application/ogg` uploads in `MessageInput.tsx`, but provider upload handling now treats every non-image attachment as UTF-8 text; a fake `clip.mp3` reproduced as `[File: clip.mp3]\n���\u0000abc` in the OpenRouter request body instead of transcript text.
- Platform docs still advertise `/api/knowledge/ingest-media`, but `knowledgeRoutes()` no longer registers that endpoint. Fresh Hono repro against the current route set returned `404 Not Found`, so agents are being told to call a route that does not exist.

## 2026-03-28

- Evolution audit: `bun test` is green (`3948 pass, 3 skip, 0 fail`), but `bunx tsc --noEmit` is still red in `src/gateway/src/stores/chat.ts`. The root pass still breaks because the store imports `ChatAttachment` from `MessageInput.tsx` and still passes `string | null` into `toDisplayPath()`.
- Gateway active-thread queuing is still writing history too early. Fresh repro against `registerChatHandlers()` returned `{ queued: true }` for a second `chat.send` on an already-active thread, but `threadDb.addThreadMessage()` had already persisted the queued user turn.
- Attachment capability drift is now spread across the stack. Gateway chat still accepts `audio/*`, `video/*`, and `application/ogg`, Discord still tells users it can transcribe audio/video, and provider upload code still decodes non-image blobs as UTF-8 text; a fake `clip.mp3` still reached OpenRouter as `[File: clip.mp3]\n��\u0000abc`.

## 2026-03-29

- Evolution audit stayed split: `bun test` is green (`3948 pass, 3 skip, 0 fail`), but `bunx tsc --noEmit` still fails in `src/gateway/src/stores/chat.ts` because the store imports `ChatAttachment` from `MessageInput.tsx` and still passes `string | null` into `toDisplayPath()`.
- Gateway control flow is still letting special cases punch through thread ownership. Fresh repro: with `thread-1` already active, `chat.send` for `/crawl https://example.com/docs` still ran immediately (`crawlCalls=1`) and appended assistant output instead of returning a queued response.
- Gateway abort scoping is still too loose. Fresh repro: `device-b` sent `chat.abort` with no `threadId`, `cancelTask("gateway", "device-b")` failed, then the handler fell back to `cancelTask("gateway", "thread-1")` and cancelled another thread's active work.
- Knowledge search still trusts garbage thresholds. Fresh Hono repro for `GET /search?q=test&threshold=wat` returned `200` and called `store.search(..., NaN, ...)`, which effectively disables the similarity cutoff instead of rejecting or clamping bad input.
- Fresh evolution audit is still split: `bun test` stayed green (`3948 pass, 3 skip, 0 fail`), but `bunx tsc --noEmit` is still red in `src/gateway/src/stores/chat.ts` because the store imports `ChatAttachment` from `MessageInput.tsx` and still passes `string | null` into `toDisplayPath()`.
- Gateway queued turns are still persisted before the queue decision. Fresh repro against `registerChatHandlers()` sent two `chat.send` calls to active `thread-1`; the second response came back with `{ queued: true }`, but `threadDb.addThreadMessage()` had already written both `"first"` and `"second"` user turns.
- The media-transcription rollback is still lying across surfaces. Gateway chat still accepts `audio/*`, `video/*`, and `application/ogg`; Discord still replies that audio/video attachments are transcribed; and OpenRouter still turns a fake `clip.mp3` into `[File: clip.mp3]\n��\u0000abc` instead of transcript text.

## 2026-03-30

- Fresh evolution audit is clean in the current tree: `bun test` passed (`3958 pass, 3 skip, 0 fail`) and `bunx tsc --noEmit` is green.
- Gateway queued turns still mutate durable history too early. Fresh repro against `registerChatHandlers()` kept `thread-1` active, then sent a second `chat.send`; the reply returned `{ queued: true }`, but `threadDb.addThreadMessage()` had already persisted both `"first"` and `"second"` user turns.
- Gateway `/crawl` still bypasses active-thread serialization. Fresh repro with `thread-1` already active sent `chat.send` for `/crawl https://example.com/docs`; it returned a normal response with no `queued` flag, `crawlCalled=1`, and assistant output was appended immediately.
- Gateway `chat.abort` still falls through to unrelated work. Fresh repro sent `chat.abort` from `device-b` with no `threadId`; after `cancelTask("gateway", "device-b")` failed, the handler called `cancelTask("gateway", "thread-1")` and cancelled another thread's active invocation.

## 2026-03-31

- Evolution audit stayed clean: `bun test` passed (`3958 pass, 3 skip, 0 fail`) and `bunx tsc --noEmit` is green.
- Gateway queued turns are still written into thread history before they are actually accepted for execution. Fresh repro returned `{ queued: true }` for the second `chat.send` on `thread-1`, but the queued `"second"` user turn was already present in `threadDb`.
- Gateway `/crawl` still sidesteps active-thread ownership. With `thread-1` already active, `chat.send` for `/crawl https://example.com/docs` ran immediately, incremented `crawlCalls` to `1`, and appended assistant output instead of queueing.
- Gateway `chat.abort` still has a cross-thread fallback. Fresh repro from `device-b` with no `threadId` called `cancelTask("gateway", "device-b")` first, then fell through to `cancelTask("gateway", "thread-1")` and cancelled unrelated active work.

## 2026-04-01

- Evolution audit is still clean: `bun test` passed and `bunx tsc --noEmit` is green in the current tree.
- Gateway queued turns still hit durable history too early. Fresh repro kept `thread-1` active, then sent a second `chat.send`; the handler returned `{ queued: true }` while `threadDb` already contained both `"first"` and queued `"second"` user turns.
- Gateway `/crawl` still bypasses thread serialization. With `thread-1` already active, `chat.send` for `/crawl https://example.com/docs` ran immediately, produced an assistant message, and incremented `crawlCalls` instead of queueing behind the active turn.
- Gateway `chat.abort` still falls through to unrelated work. Fresh repro from `device-b` with no `threadId` first called `cancelTask("gateway", "device-b")`, then called `cancelTask("gateway", "thread-1")` and cancelled another thread's active invocation.
- Fresh evolution pass stayed clean again: `bun test` is `3963 pass, 3 skip, 0 fail` and `bunx tsc --noEmit` is clean.
- Reverse-relay callback tokens are still not bound to the intended remote instance in the live route path. Fresh repro issued a token for `remote-a`, then posted `/api/relay/callback` without any remote identity and got `200`; the handler accepted it and forwarded the callback as `sender="relay", sender_id="relay"`.
- Reverse-relay callbacks still collapse onto the same relay identity when the remote omits sender metadata. Fresh repro sent two callbacks through `relayRoutes()` with the same token and different nonces; both reached `processImmediate()` as `channel="relay", sender="relay", sender_id="relay"`, so they share the same conversation/model-override bucket.
- Relay nonce TTL is still time-wrong on quiet instances. Fresh repro against `messagesRoutes()` posted `nonce="stale-nonce"`, advanced `Date.now()` by six minutes, then posted the same nonce again; it still returned `{ status: "duplicate" }` because `seenNonces` only prunes once the map exceeds `500` entries.

## 2026-04-03 (evolution:codebase-review)

**bun test**: 4148 pass, 3 skip, **4 fail** — first cycle with real test failures in a while.
**bunx tsc --noEmit**: clean.

Root cause of all 4 failures: working-tree changes that were never committed (or deliberately uncommitted) but left the tests behind. `src/agents/invoke.ts` had the always_cli OpenRouter fallback reverted; `src/defaults.ts` removed openrouter from `DEFAULT_FALLBACK_ORDER`. The tests in `invoke-routing.test.ts` and `router.test.ts` still expect the old behavior.

Second finding: `nyx chat` Ctrl+C drops the local SSE stream but never calls `POST /api/message/:id/cancel`. Server-side agent runs to completion anyway.

Third finding: the new `getAgentSdkSessionRolloverReason` function has unit tests but the rollover integration path through `resolveCliSession` is only tested for the happy path (session reuse), not for the rollover case.

Proposals: proposal-49a047c0, proposal-b7beaece, proposal-7dfbd79b.

## 2026-04-05 (cycle 11)

- `bun test`: 4191 pass, 3 skip, 0 fail. `bunx tsc --noEmit`: 6 errors — 3 in compiler.ts (in pipeline as proposal-47), 3 new.
- Two new TS errors from 87123b4 (--pipe/--prompt): `chat.ts:603` inst not narrowed in `resumeStoredSession` closure after process.exit guard; `chat.test.ts:158` passes `string[]` where `AsyncIterable<string>` required.
- `briefing.test.ts:32` TS2322: `makeTask()` missing `notify_thread_id: null` and `webhook_url: null` after scheduler reply-threading + completion-webhook commits added those fields.
- `invoke-agent-sdk.ts` gutted from 945→18 lines (all paths now route through CLI), with test pruning and 3 new untracked passing test files — all uncommitted.
- Pattern: dirty-tree accumulation continues; the `invoke-agent-sdk` removal is architecturally significant and has no commit yet.
- Proposals: Fix chat.ts/chat.test.ts TS errors, fix briefing.test.ts makeTask, commit Agent SDK removal + dirty working tree.

## 2026-04-07 (cycle 13)

- `bun test`: 4145 pass, 3 skip, 0 fail. `bunx tsc --noEmit`: clean.
- Dirty tree: 80+ modified files, 5 new untracked (cockpit.ts, tool-activity.ts, review-policy.ts, strider.yaml, plans/nyxhive-onboarding-ux.md). Nothing committed since 5bc5572.
- Key changes in dirty tree verified: Telegram replay dedup via shouldDropReplay + QueueDB.findMessageByThread; atomic markReviewing using conditional SQL (`AND status IN ('proposed','reviewed')`); enqueueReview refactored with _activeReviewId deduplication; new /api/queue/failed routes (GET/DELETE); DEFAULT_WORKER_MODEL changed to deepseek/deepseek-v3.2; processor thread-DB ops scoped to `msg.channel === "gateway"` only.
- Bug: enqueueReview returns `{ status: "queued", position: 0 }` for both "just started" and "already running" cases — callers can't distinguish. Proposal proposal-94f770f0.
- Gap: /api/queue/failed routes and underlying DB methods (getFailedMessages, clearFailedMessages, clearFailedMessage) have zero test coverage. Proposal proposal-d41ad89e.
- Pattern: dirty tree keeps growing across cycles. Committed everything is clean and working but nothing ships from this tree. Proposal proposal-b6c0e232.
- No product code changed in evolution mode.

## 2026-04-06 (cycle 12)

- Audit regressed from the earlier partial read: full `bun test` finished at `4065 pass, 3 skip, 1 fail`; the lone failure is `primary-agent.test.ts` because `isSingleBrainMode(undefined)` still reads ambient `NYXHIVE_MAIN_BRAIN`, so the helper is order-dependent instead of pure.
- `bunx tsc --noEmit` is deeply red again. The loudest cluster is shared type drift from the native-api / Agent SDK cleanup: `AgentConfig` no longer declares `anthropic_runtime`, `processImmediate()` lost `thread_id` from its public opts type while Discord/Telegram still pass it, and thread suspension uses `"waiting_input"` even though `ThreadStatus` excludes it.
- A second compile cluster is channel/input-request typing: Discord and Telegram both map `Record<string, unknown>` into `InputRequestOption[]` with predicates TypeScript rejects, and the Discord button builder typing is now off enough to trip generic/value mismatches.
- A third compile cluster is smaller but real: `extractClaudeInputRequest()` dereferences nullable `raw` after only optional-chaining the first property access, and the runs test fixture now uses `brain: "anthropic"` while `DelegationRunBrain` still only allows `"codex" | "opus" | "sdk"`.
- Pattern this cycle: the code is migrating away from Codex/Agent SDK faster than the shared types are. Runtime code mostly moved; type surfaces and tests are lagging behind and now breaking in groups instead of singly.

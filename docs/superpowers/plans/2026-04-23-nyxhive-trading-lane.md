# NyxHive Trading Lane Implementation Plan

**Date:** 2026-04-23
**Status:** Draft
**Depends on:** `docs/superpowers/specs/2026-04-23-nyxhive-trading-lane-design.md`

---

## Goal

Turn NyxHive's existing manual trading desk into a bounded trading lane with:

- structured trade intents
- deterministic risk controls
- paper execution
- Hyperliquid testnet support
- clear live-trading gates

## Phase Order

### Phase 1: Lane spine

Target:

- no live venue calls
- lane modes exist
- paper execution is end-to-end

Primary files:

- `src/trading/types.ts`
- `src/trading/db.ts`
- `src/trading/intent.ts`
- `src/trading/risk-engine.ts`
- `src/trading/lane.ts`
- `src/mcp/trading-tools.ts`

Deliverables:

- structured trade-intent type and validator
- lane mode state machine
- approval gate interface
- risk-engine module
- DB schema additions for intents, orders, approvals, reconciliation, halts
- MCP/tooling surface updated to use intents instead of direct freeform position logging

Verification:

- unit tests for intent validation
- unit tests for lane-mode transitions
- unit tests for risk rejects and accepts
- DB migration tests

### Phase 2: Paper execution and reconciliation

Target:

- the specialist agent can create intents and send them to a paper adapter
- every paper order produces a durable audit trail

Primary files:

- `src/trading/adapter/base.ts`
- `src/trading/adapter/paper.ts`
- `src/trading/reconciler.ts`
- `src/trading/db.ts`
- `src/trading/*.test.ts`

Deliverables:

- adapter contract
- paper adapter with deterministic fills or explicit simulation rules
- order and fill ledger
- reconciliation job for local order state
- halt behavior on reconciliation drift

Verification:

- unit tests for paper fills
- unit tests for reconciliation mismatch detection
- unit tests for halt escalation

### Phase 3: Ops and runtime posture

Target:

- trading lane is visible as control-plane state
- lane mode and safety posture are obvious

Primary files:

- `src/nyx-workspace/src/screens/operations/*`
- `src/queue/*` where runtime posture exposure is needed
- `src/types.ts`

Deliverables:

- ops screen cards for lane mode, adapter health, open orders, recent fills, last halt, last approval
- clear paper/live labels
- lane-mode reporting in traces or status payloads where appropriate

Verification:

- frontend tests for ops surface
- API/route tests for status payloads

### Phase 4: Hyperliquid testnet adapter

Target:

- real venue integration on testnet only

Primary files:

- `src/trading/adapter/hyperliquid.ts`
- `src/trading/adapter/hyperliquid-nonce.ts`
- `src/trading/hyperliquid-types.ts`
- `src/trading/reconciler.ts`
- `.env`/config surfaces as needed

Deliverables:

- REST info/exchange client
- websocket consumer for market and user streams
- durable nonce allocator
- restart recovery path from venue snapshots
- scheduled-cancel heartbeat support

Verification:

- adapter unit tests with mocked venue responses
- nonce allocator tests under concurrency
- reconnect/recovery tests
- testnet smoke path documented and runnable

### Phase 5: Live gates

Target:

- live capability exists only behind explicit arm/approval flows

Primary files:

- `src/trading/lane.ts`
- `src/trading/risk-engine.ts`
- `src/trading/db.ts`
- workspace/API approval surfaces

Deliverables:

- `live_armed` and `halted` modes
- approval events
- manual-entry approval flow
- automatic risk-reducing exit policy
- explicit denial of transfers/withdrawals/other unsupported venue actions

Verification:

- tests that scheduled jobs cannot arm live mode
- tests that live entries require approval
- tests that unsupported venue actions are refused
- halt drill tests

## Delivery Discipline

- Keep paper and live adapters behind one interface.
- Keep venue specifics out of prompts.
- Keep trading state in the trading store, not the general memory graph.
- Do not ship live support before reconciliation and halt drills pass.
- Prefer a dedicated automation account boundary on Hyperliquid before any live pilot.

## First Slice Recommendation

Build Phases 1 and 2 before touching Hyperliquid.

Reason:

- it exercises the lane contract
- it reduces coordination debt first
- it lets us prove the specialist-agent + structured-intent shape without venue noise
- it gives us a paper loop we can judge before involving real exchange mechanics

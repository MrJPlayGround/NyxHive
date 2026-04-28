# NyxHive Trading Lane + Hyperliquid Execution Design

**Date:** 2026-04-23
**Status:** Design
**Scope:** New NyxHive-native trading domain, isolated from NyxLabs/Vortex, paper-first with Hyperliquid as the eventual live venue.

---

## Problem

Hermes has already shown the usual failure mode: a second runtime with weak boundaries, weak memory discipline, and no stable engine contract. Trading is exactly where that gets expensive.

NyxHive already has part of a trading desk:

- `src/trading/db.ts` stores watchlists, signals, positions, risk state, notes, journal entries, alerts, and todos.
- `src/mcp/trading-tools.ts` exposes a useful manual desk surface for watchlists, signals, positions, notes, journal, and risk checks.
- NyxHive's runtime posture now treats lanes as bounded operating environments, not ambient identity drift.

What is missing is the actual trading lane:

- a specialist trading agent identity
- exchange adapters
- structured execution intents
- reconciliation and drift detection
- hard risk gates
- replay/eval infrastructure
- a live-trading posture that is strict enough to deserve trust

The right move is not to revive Hermes. The right move is to turn trading into a first-class NyxHive lane with a hard contract.

## Assumptions

- This domain is separate from NyxLabs. Reuse from NyxLabs is optional integration, not ownership.
- Hyperliquid is the first real execution venue if live trading is ever enabled.
- The first shippable loop is paper trading on live data, not live order placement.
- Live trading will require explicit User approval, explicit runtime arming, and a dedicated venue account boundary.
- Working agent id in this document is `market`; naming can change later without changing the architecture.

## Goals

1. Keep a single runtime home: NyxHive.
2. Create a bounded trading lane with clear tools, memory, permissions, and risk posture.
3. Support a full paper loop: market data, thesis, signal, order intent, paper execution, journal, review.
4. Add Hyperliquid support cleanly enough that live trading is an adapter and policy change, not a rewrite.
5. Make the system auditable: every signal, order intent, execution, rejection, halt, and approval should be reconstructable.
6. Reduce coordination tax by turning missing capabilities into engine primitives and explicit contracts.

## Non-Goals

- No general autonomous trader that can invent its own permissions.
- No live trading in phase 1.
- No multi-venue abstraction from day one.
- No backdoor use of Vortex as a trading owner.
- No chat-driven freeform order placement.
- No withdrawals, transfers, builder-fee approvals, or wallet-management actions in the trading lane.

## External Research Anchors

### Hyperliquid capabilities that matter

- Official API supports both mainnet and testnet via separate base URLs.
- Official WebSocket feeds provide market data and user-specific streams for order updates, fills, funding, and ledger events.
- Hyperliquid supports API wallets ("agent wallets") approved by a master account, but queries must still use the actual account address rather than the agent wallet address.
- Hyperliquid tracks the 100 highest nonces per signer and explicitly recommends an atomic nonce counter for automated systems.
- Hyperliquid exposes a native scheduled cancel operation that acts like a dead man's switch for open orders.
- Hyperliquid publishes explicit IP and address-based rate limits, including websocket connection and subscription limits.
- Testnet exists, but the faucet requires prior mainnet deposit activity on the same address.

### Automated trading controls that matter

- FINRA's guidance for algorithmic trading emphasizes documented controls, testing, deployment discipline, monitoring, and post-implementation review.
- FIA's 2024 best-practices paper emphasizes pre-trade limits, cancel-on-disconnect, kill-switch behavior, repeated automated execution limits, reconciliation, and exchange-based conformance testing.

These are not just compliance theater. They map directly onto the controls we need for a trustworthy trading lane.

## Core Architecture

NyxHive should model trading as four layers:

1. **Runtime owner:** Nyx and the NyxHive engine.
2. **Trading lane:** permissions, state, tools, evals, approvals, and safety policy.
3. **Trading specialist agent:** the domain mind operating inside the lane.
4. **Venue adapter:** paper execution first, Hyperliquid later.

That separation matters:

- Nyx owns runtime and coordination.
- The trading specialist owns market reasoning.
- The lane owns constraints.
- The adapter owns venue-specific mechanics.

Do not collapse these into one prompt blob.

## Lane Contract

The trading lane should be explicit and versioned. It should define:

- allowed tools
- allowed memory surfaces
- allowed state mutations
- execution mode
- approval requirements
- risk envelope
- reporting obligations

### Lane states

The lane should support exactly these states:

- `disabled`: no trading actions, read-only analysis only
- `research`: market analysis, thesis writing, journaling, no execution intents
- `paper`: full structured order intents and paper execution only
- `live_armed`: live adapter available, but only during an explicitly armed session
- `halted`: forced stop, cancel outstanding live orders, refuse new entries until cleared

There should be no ambient "sometimes live" posture.

### Channel posture

- Workspace/API/private channels may inspect lane state and submit approvals.
- Public Discord never gets live-operational trading controls.
- Scheduled tasks may run market scans and paper workflows, but may not arm live trading.
- Live-mode transitions must be interactive and logged.

## Trading Specialist Agent

Create a new specialist agent instead of repurposing Nyx or Vortex.

### Agent responsibilities

- maintain market watchlists and session thesis
- generate structured trade setups
- invalidate stale setups
- propose order intents
- explain entries, exits, and non-actions
- produce daily/weekly review output

### Agent restrictions

- cannot place freeform venue calls
- cannot bypass risk validation
- cannot change lane mode
- cannot mutate venue credentials
- cannot transfer funds
- cannot suppress reconciliation failures

### Output shape

Every actionable setup should compile into a structured intent object with:

- `symbol`
- `market`
- `timeframe`
- `direction`
- `thesis`
- `invalidation`
- `entry_model`
- `stop_loss`
- `take_profit`
- `risk_percent`
- `confidence`
- `evidence`
- `expires_at`
- `execution_mode` (`paper` or `live`)

Natural language is for explanation. Structured intent is for execution.

## Execution Model

The execution path should be:

1. ingest market and account state
2. generate or update thesis
3. compile a structured order intent
4. validate against risk rules
5. require approval if policy says so
6. route to adapter (`paper` or `hyperliquid`)
7. record venue response and derived order state
8. reconcile against venue/user streams
9. journal outcome and update strategy feedback

This turns "place a trade" from chat theater into a proper state machine.

## Hyperliquid Integration Design

### Venue boundary

Use an exchange adapter interface:

- `PaperExecutionAdapter`
- `HyperliquidExecutionAdapter`

The rest of the lane should talk to a neutral contract:

- `getMarketSnapshot`
- `getAccountState`
- `submitOrderIntent`
- `cancelOrder`
- `syncOpenOrders`
- `syncFills`
- `heartbeat`
- `healthCheck`

### Authentication and account model

For live trading, do **not** use User's primary discretionary wallet as the automation home.

Preferred order of safety:

1. dedicated Hyperliquid account/wallet for automation
2. dedicated subaccount, if available and operationally clean
3. dedicated API wallet approved only for the chosen account boundary

Important Hyperliquid-specific rules:

- Use a dedicated approved API wallet for signing live actions.
- Query account state with the actual account address, not the API wallet address.
- Persist signer/account mapping explicitly in NyxHive config/state.
- Rotate to a fresh API wallet if one is deregistered or pruned.

### Nonce strategy

Implement a durable atomic nonce allocator per signer.

Requirements:

- monotonic per signer
- persisted locally
- safe across concurrent order submissions
- able to fast-forward to current milliseconds
- explicit recovery path after restart

Do not derive nonces ad hoc in random call sites. That is how automated trading turns into replay weirdness.

### Market data and user events

Use Hyperliquid websocket feeds for:

- `allMids` or targeted book feeds
- order updates
- user fills
- user funding updates
- user ledger updates where relevant

Use REST/info endpoints for:

- initial snapshots
- reconciliation
- restart recovery
- explicit order-status lookup
- rate-limit inspection

The websocket consumer must tolerate disconnects and rebuild from snapshots on reconnect.

### Dead man's switch and heartbeats

When in `live_armed`, the adapter should continuously refresh Hyperliquid's scheduled cancel deadline.

If NyxHive heartbeat fails, stale-data thresholds breach, or reconciliation drifts past tolerance:

- stop new entries
- schedule/cause cancel-all where possible
- mark lane `halted`
- surface the reason in ops immediately

Hyperliquid's native scheduled cancel is not sufficient by itself, but it should be part of the live safety stack.

### Order policy

Initial supported order policy for live mode should be narrow:

- limit orders
- market orders only when explicitly allowed by policy
- reduce-only exits
- TP/SL handling
- cancel by oid/cloid

Explicitly defer:

- TWAP
- builder-fee workflows
- transfers/withdrawals
- staking/delegation
- vault operations
- multi-leg strategies

The venue can do more. The lane should intentionally do less.

## Risk Model

Risk rules should be deterministic code, not prompt suggestions.

### Pre-trade controls

- max notional per order
- max position size per symbol
- max total exposure
- max concurrent positions
- max daily loss
- max daily trades
- cooldown after consecutive losses
- stale-price rejection
- max slippage tolerance
- repeated automated execution limit
- symbol denylist or session denylist

### Session controls

- lane-wide pause
- hard halt
- disconnect detection
- reconciliation drift detection
- manual operator override with audit trail

### Live approval policy

For the first live-capable version:

- entries require explicit User approval
- risk-reducing exits may execute automatically once a position is live
- lane cannot arm itself
- scheduled tasks cannot open live positions

That keeps the earliest live posture closer to guarded execution assistant than "autonomous bot."

## State and Data Model

Extend the existing `TradingDB`; do not replace it.

The current schema is good for a manual desk. It is not sufficient for automated execution.

Add tables or equivalent storage for:

- `trading_strategies`
  - strategy id, scope, status, config, version
- `trade_intents`
  - structured signal-to-order intent records
- `execution_orders`
  - local order records with venue ids, client ids, status, timestamps
- `execution_fills`
  - fill-level ledger from venue/user streams
- `account_snapshots`
  - balance, margin, open positions, funding, equity snapshots
- `venue_sessions`
  - lane mode, venue target, signer/account identity, heartbeat status
- `approval_events`
  - who approved what, when, and under which policy
- `reconciliation_events`
  - detected mismatches, severity, resolution status
- `halt_events`
  - why the lane stopped, whether cancel-all was attempted, and recovery notes
- `eval_runs`
  - replay/backtest/paper evaluation outputs

### Data ownership rules

- venue truth beats local cache for order/fill/account state
- local intent history is immutable audit history
- summaries are derived, never primary
- general conversation memory should not be the system of record for trading state

## Memory and Retrieval Policy

Do **not** let trading state pollute Nyx's casual conversational memory surfaces.

Use this hierarchy:

- trading DB and execution ledger as primary source of truth
- context artifacts for research bundles and external reports
- selective memory summaries only for durable preferences or strategic lessons
- no automatic injection of trade-by-trade operational debris into normal chat turns

If Nyx is not in a trading context, the system should not drag in order chatter just because it exists.

## Evaluation and Replay

The lane needs two different eval systems:

### Strategy eval

- historical replay
- paper performance review
- thesis-to-outcome scoring
- setup quality by symbol/timeframe/session

### Runtime eval

- nonce safety
- adapter reconnect correctness
- reconciliation drift handling
- halt/cancel behavior
- approval gate enforcement
- stale-data detection

A trading lane without evals is just a narrative generator with side effects.

## Operations Surface

NyxHive should expose trading ops as first-class control-plane state.

Required ops views:

- lane mode and armed status
- adapter health
- websocket health
- last heartbeat and scheduled-cancel deadline
- open positions and pending orders
- recent fills
- recent halts and reconciliation failures
- approval queue and last approval events
- paper-vs-live clearly labeled everywhere

This belongs in the existing operations/control-plane surface, not in a secret side UI.

## Proposed File and Module Shape

This is the cleanest initial decomposition:

- `src/trading/types.ts`
  - extend existing domain types
- `src/trading/db.ts`
  - extend schema and persistence methods
- `src/trading/intent.ts`
  - structured trade-intent schema and validation
- `src/trading/risk-engine.ts`
  - deterministic risk checks and session controls
- `src/trading/adapter/base.ts`
  - exchange adapter contract
- `src/trading/adapter/paper.ts`
  - paper execution adapter
- `src/trading/adapter/hyperliquid.ts`
  - Hyperliquid REST/WS adapter
- `src/trading/adapter/hyperliquid-nonce.ts`
  - signer-scoped nonce allocator
- `src/trading/reconciler.ts`
  - order/fill/account reconciliation
- `src/trading/lane.ts`
  - lane mode, approval gating, orchestration surface
- `src/trading/evals/*`
  - replay and runtime eval harness
- `src/mcp/trading-tools.ts`
  - evolve current manual tools into structured lane tooling
- `src/nyx-workspace/src/screens/operations/*`
  - trading lane visibility in ops

Avoid shoving venue logic into prompts or general queue code.

## Rollout Sequence

### Phase 1: Lane spine, no live venue

- structured trade intents
- deterministic risk engine
- lane modes
- paper execution adapter
- execution ledger and reconciliation scaffolding
- ops visibility

### Phase 2: Hyperliquid testnet integration

- testnet REST adapter
- websocket user/market streams
- durable nonce allocator
- restart recovery and reconciliation
- dead-man-switch heartbeat

### Phase 3: Paper on live market data

- live market feeds with paper execution
- session reviews
- decision evals
- repeated-run stability

### Phase 4: Guarded live readiness

- dedicated venue account boundary
- approval events and arming flow
- live adapter restricted to narrow order policy
- halt drills and reconciliation drills

### Phase 5: Tiny-size live pilot

- explicit opt-in
- micro size only
- manual approvals for entries
- auto exits only within policy
- daily post-trade review and incident review

## Ship Criteria

Do not allow live mode until all of this is true:

- paper execution and journaling are boring and stable
- order intent schema is enforced everywhere
- reconciliation catches injected failures
- halt mode and cancel-all drills pass
- websocket disconnect/reconnect behavior is tested
- nonce allocation survives restart and concurrency
- approval gates are unskippable
- ops surface shows enough truth to diagnose failure fast

## Decisions

- Build a new NyxHive-native trading specialist agent.
- Keep Nyx as runtime owner, not trading persona.
- Keep Vortex out of primary ownership.
- Extend the existing trading desk instead of replacing it.
- Treat Hyperliquid as a venue adapter, not as the system architecture.
- Treat live trading as a late, tightly gated mode, not a default capability.

## Open Items Deferred Deliberately

- final agent name and soul text
- exact strategy family
- exact paper fill model
- whether live mode uses a dedicated wallet or an available subaccount
- portfolio-level multi-strategy routing
- NyxLabs integration points, if any

These are real decisions, but they do not block the lane contract.

## References

- Hyperliquid API docs: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api
- Hyperliquid exchange endpoint: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint
- Hyperliquid info endpoint: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint
- Hyperliquid nonces and API wallets: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/nonces-and-api-wallets
- Hyperliquid websocket overview: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket
- Hyperliquid websocket subscriptions: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/websocket/subscriptions
- Hyperliquid rate limits: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits
- Hyperliquid testnet faucet: https://hyperliquid.gitbook.io/hyperliquid-docs/onboarding/testnet-faucet
- Hyperliquid Python SDK: https://github.com/hyperliquid-dex/hyperliquid-python-sdk
- FINRA Regulatory Notice 15-09: https://www.finra.org/rules-guidance/notices/15-09
- FIA Best Practices for Automated Trading Risk Controls and System Safeguards (July 2024): https://www.fia.org/sites/default/files/2024-07/FIA_WP_AUTOMATED%20TRADING%20RISK%20CONTROLS_FINAL_0.pdf

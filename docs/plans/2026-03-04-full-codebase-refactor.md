# NyxHive Full Codebase Refactor

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Clean up the entire NyxHive codebase — fix types, standardize patterns, decompose god files, harden the API layer.

**Architecture:** Incremental phases, each independently testable and committable. No behavior changes — pure refactor.

**Tech Stack:** TypeScript, Bun, Hono, Zod, SQLite

---

## Phase 1: Foundation

### Task 1a: Replace console.log with logger (26 files)
- Find all `console.log`, `console.warn`, `console.error` in `src/` (excluding tests)
- Replace with `logger.info`, `logger.warn`, `logger.error` respectively
- Add `import { logger } from "@/utils/logger.js"` where missing
- Exception: logger.ts itself uses console internally (correct)

### Task 1b: Fix `any` type annotations (40 occurrences, 11 files)
Key files:
- `src/channels/discord.ts` (8) — type Discord.js optional dep properly
- `src/channels/slack.ts` (27) — type Bolt optional dep properly
- `src/queue/management.ts` (10) — extract proper interfaces to break circular deps
- Scattered: `src/queue/delegation.ts`, `src/providers/anthropic.ts`, `src/server/index.ts`, `src/server/routes/dev.ts`, `src/server/routes/messages.ts`, `src/server/routes/memory-bank.ts`, `src/utils/audit.ts`, `src/development/plan.ts`

### Task 1c: Extract hardcoded constants
Move scattered magic numbers to `src/defaults.ts`:
- SSE heartbeat interval (30s) from `src/server/sse.ts`
- Dedup windows from `src/server/routes/messages.ts`, `src/mcp/server.ts`
- Timeouts from `src/server/routes/messages.ts`
- Circuit breaker values from `src/providers/router.ts`
- Learning dedup windows from `src/learning/listeners.ts`
- Scheduler tick from `src/config-schema.ts` (reference defaults.ts)

## Phase 2: Config & Types

### Task 2a: Derive config types from Zod schemas
- In `config-schema.ts`, export `agentSchema`, `teamSchema`
- In `types.ts`, replace manual `AgentConfig`, `TeamConfig`, `NyxHiveConfig` interfaces with `z.infer<typeof ...>`
- Keep re-exports for backward compatibility
- Verify all consumers compile

### Task 2b: Type SSEEvent/ThreadEvent with discriminated unions
- Create event type map in `types.ts`
- Type the `data` field properly per event type
- Use existing Zod schemas from `gateway/protocol/events.ts` as reference

## Phase 3: God File Decomposition

### Task 3: Split `processor.ts` (1,577 lines) into focused modules
Target structure:
```
src/queue/
  processor.ts              (~300 lines — orchestration facade)
  model-overrides.ts        (set/clear/get model overrides)
  event-bus.ts              (SSE/thread event pub/sub)
  budget-monitor.ts         (budget checks, state cleanup)
  agent-invoker.ts          (processForAgent core logic)
  immediate-invoker.ts      (processImmediate for API calls)
  context-builder.ts        (system prompt, delegation context, knowledge merge)
  conversation-ops.ts       (clear, undo, forget, trim, getContextInfo)
  proposal-resolver.ts      (resolveProposalAgent, resolveProposalRepoPath)
```

## Phase 4: API Layer

### Task 4a: Standardize API validation
- Create Zod schemas for all routes currently using raw `c.req.json()`
- Routes to fix: `proposals.ts`, `dev.ts`, `scheduler.ts`, `tasks.ts`, `knowledge.ts`, `queue.ts`
- Use existing `parseBody()` helper from `validate.ts`

### Task 4b: Add global Hono error middleware
- Add `app.onError()` handler in `server/index.ts`
- Standardize error response format: `{ error: string, status: number }`
- Remove ad-hoc try/catch in individual routes where the global handler suffices

## Phase 5: Final Verification
- Run full test suite (`bun test`)
- Run TypeScript check (`bunx tsc --noEmit`)
- Start daemon and verify it boots cleanly
- Commit each phase separately

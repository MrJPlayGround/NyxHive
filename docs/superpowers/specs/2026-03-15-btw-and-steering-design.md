# BTW & Steering — Mid-Task Agent Communication

**Date**: 2026-03-15
**Status**: Draft

## Problem

When a NyxHive agent is processing a task, there is no way to:
1. Ask it a question about what it's doing without killing the task
2. Inject new context or direction into the running task

Claude Code has `/btw` (ephemeral side queries). Codex has Enter-to-steer (mid-turn injection). NyxHive needs both capabilities, backend-agnostic, across all channels (Discord, Slack, iOS Gateway).

## Two Distinct Capabilities

### Capability 1: Side Query (BTW)

**Purpose**: Read-only question against a running agent's context. Ephemeral — never enters conversation history, never affects the running task.

**Inspired by**: Claude Code's `/btw` command.

### Capability 2: Mid-Task Steering

**Purpose**: Inject context or direction into a running agent's task. Persisted in history. Delivered at checkpoints between tool calls.

**Inspired by**: Codex's Enter-to-steer (`turn/steer`), but checkpoint-based to avoid the derailment problem.

---

## Side Query (BTW) Design

### API

```
POST /api/agents/:agentKey/btw
```

**Request body**:
```json
{
  "question": "what file are you editing right now?",
  "conversation_id": "optional — auto-resolved if agent has exactly one active task, 400 if ambiguous",
  "source": "human" | "<agentKey>"
}
```

**Response** (synchronous):
```json
{
  "answer": "I'm currently editing src/queue/processor.ts, adding a new...",
  "context_tokens": 12400,
  "model": "claude-haiku-4-5-20251001"
}
```

### How It Works

1. **Context cache**: When the processor starts processing a message, it caches the assembled context (system prompt, conversation history, knowledge context) in an in-memory Map keyed by `message_id`. This avoids rebuilding the prompt (soul loading, knowledge retrieval) for BTW calls and prevents race conditions with live state.
2. Processor looks up the agent's active processing state from the cache + live progress:
   - Cached system prompt
   - Cached conversation history snapshot
   - Current `last_progress_text` and `last_activity` from messages table (live)
3. Makes a **separate LLM call** with:
   - Cached system prompt (read-only)
   - Cached conversation history (read-only snapshot)
   - Current progress as additional context: `"[Agent is currently: {last_activity}. Progress so far: {last_progress_text}]"`
   - The question
   - **No tools** — inference only
   - Cheapest capable model (Haiku by default, configurable)
   - **Max 500 output tokens** — side queries should be concise
4. Returns the answer directly to the caller
5. **Nothing is persisted in conversation history**. The running agent never sees the question or answer.
6. A lightweight SSE event (`btw:query` / `btw:response`) is emitted for observability (activity feed, iOS status).

### Data Model

No new tables. Stateless fire-and-forget. Cost tracked in trace store for usage reports.

### Context Cache Lifecycle

- **Created**: When processor starts processing a message (in `processForAgent`, after context assembly)
- **Evicted**: When message completes, fails, or is dead-lettered
- **Max-age sweep**: Entries older than 60 minutes are pruned in the processor's periodic cleanup cycle (existing `cleanExpiredState` runs every 5 min)

### Rate Limiting & Cost Control

- Max **5 BTW calls per minute** per source (reuses existing `checkSenderRateLimit` pattern)
- Context sent to BTW is capped at last **20 messages** from history (not the full window)
- Agent-to-agent BTW loops are prevented: an agent cannot BTW the same target more than 2x per minute

### Agent-to-Agent BTW

Agents can BTW other agents via MCP tool `btw_agent`:
```
Tool: btw_agent
Input: { target_agent: "coder", question: "what file are you editing?" }
Output: "I'm currently editing src/queue/processor.ts..."
```

Or via action tag in responses: `[@btw coder: what file are you editing?]`

---

## Mid-Task Steering Design

### API

```
POST /api/agents/:agentKey/steer
```

**Request body**:
```json
{
  "message": "also check the migration file in db/migrations/",
  "conversation_id": "optional — auto-resolved if agent has exactly one active task, 400 if ambiguous",
  "priority": "normal",
  "source": "human" | "<agentKey>",
  "ttl_seconds": 300,
  "on_expire": "discard"
}
```

**Response**:
```json
{
  "steer_id": "steer_abc123",
  "status": "queued",
  "target_message_id": "msg_xyz789",
  "estimated_delivery": "next_checkpoint"
}
```

### Priority Levels

| Priority | Delivery | Who can send |
|----------|----------|--------------|
| `normal` | Next checkpoint (between tool calls) or next turn boundary | Anyone |
| `interrupt` | Next tool boundary (earliest possible) | Human only (by default) |

### Data Model

New `steers` table:

```sql
CREATE TABLE IF NOT EXISTS steers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  steer_id TEXT NOT NULL UNIQUE,
  target_message_id TEXT,
  target_agent TEXT NOT NULL,
  conversation_id TEXT NOT NULL,
  source TEXT NOT NULL,
  channel TEXT,                              -- derived from target_message_id, NULL for MCP/API calls
  message TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal',
  status TEXT NOT NULL DEFAULT 'pending',
  ttl_seconds INTEGER DEFAULT 300,           -- auto-expire after TTL, NULL = no expiry
  on_expire TEXT NOT NULL DEFAULT 'discard', -- discard | requeue
  created_at INTEGER NOT NULL,
  delivered_at INTEGER,
  expired_at INTEGER
);

CREATE INDEX idx_steers_target ON steers (target_message_id, status);
CREATE INDEX idx_steers_agent ON steers (target_agent, status, created_at);
```

**Status lifecycle**: `pending` -> `delivered` | `expired`

- `delivered`: Steer was injected into agent context
- `expired`: Target message completed before steer could be delivered

### Delivery Mechanism

**Turn-boundary delivery** (backend-agnostic):

The `onProgress` callback is **read-only** — it observes progress but cannot inject into the running subprocess. Steers are therefore delivered at **turn boundaries**, not mid-tool-call.

**How it works**:

1. Steer arrives via API, written to `steers` table with `status = 'pending'`
2. The `onProgress` callback detects steers exist (lightweight poll: `SELECT count(*) FROM steers WHERE target_message_id = ? AND status = 'pending'`) and flags them internally
3. **Normal priority**: When the current agent invocation completes (CLI subprocess exits), before the next invocation starts (via `--resume` session), the processor:
   - Reads all pending steers for this message
   - Saves them to conversation history as user messages with steer metadata
   - Marks steers as `delivered`
   - The next agent invocation sees them in conversation history naturally
4. **Interrupt priority**: Same delivery path, but the processor also sets an `AbortSignal` that terminates the current CLI subprocess gracefully (SIGTERM). The subprocess's partial work is preserved via session state. The agent is immediately re-invoked with steers in history. This wastes tokens on the aborted partial turn — use sparingly.
5. If the target message completes before delivery, mark `status = 'expired'`, set `expired_at`

**Backend-specific notes**:
- **Claude CLI**: Uses `--resume SESSION_ID`. Session state persists across subprocess restarts. Steers appear as conversation history on re-invocation.
- **Codex SDK**: When `turn/steer` becomes available in the TypeScript SDK, swap in direct injection for both priority levels (no subprocess restart needed). Until then, same turn-boundary mechanism as Claude.

**Limitation**: For single-turn tasks (agent completes in one invocation), normal-priority steers may arrive too late. The steer is then either marked `expired` or re-queued as a normal follow-up message (configurable via `on_expire: "discard" | "requeue"`).

### Steer Batching Format

When multiple steers are pending at delivery time, they are batched:

```
[STEERS RECEIVED]
1. (from human, 2 min ago): also check the migration file
2. (from scout, 1 min ago): found a related issue in db/schema.ts
[END STEERS]
```

### History Persistence

Delivered steers are saved to conversation history as plain `role: "user"` messages. The steer identity is encoded in the content string, not in a metadata field — this keeps `ConversationMessage` unchanged (`{ role, content }`) and avoids any API compatibility issues:

**LLM-facing (ConversationMessage)**:
```typescript
{
  role: "user",
  content: "[STEER from human]: also check the migration file"
}
```

**DB/UI layer (MemoryStore)**:
The conversation memory DB stores additional columns (`source`, `steer_id`, `type`) alongside the message for UI rendering and audit. These are NOT sent to the LLM — they're used by channels and iOS to render steers differently (gray italic, collapsible, etc.).

This means:
- `ConversationMessage` type stays unchanged — `{ role: "user" | "assistant", content: string }`
- The LLM sees steers as user input with a `[STEER from ...]` prefix — semantically correct
- The UI layer uses DB metadata to render steers distinctly
- Full audit trail in thread history

### Agent-to-Agent Steering

Agents can steer other agents via MCP tool `steer_agent`:
```
Tool: steer_agent
Input: { target_agent: "coder", message: "migration file changed, recheck db/migrations/003.sql", priority: "normal" }
Output: { steer_id: "steer_abc", status: "queued" }
```

Or via action tag: `[@steer coder: also check the migration file]`

### Expiry & Edge Cases

- **Agent not processing**: Return 409 with `{ error: "agent_idle", message: "No active task for agent" }`. Optionally queue as a normal message instead.
- **Multiple steers queued**: Delivered in order (priority DESC, created_at ASC). All pending steers for a message are batched into a single injection (see batching format above).
- **Steer arrives after completion**: Marked `expired`. Behavior controlled by `on_expire` field: `"discard"` (default) or `"requeue"` (re-queue as normal message).
- **TTL expiry**: Steers have an optional `ttl_seconds` field (default: 300). Steers older than their TTL are auto-expired by the processor's periodic cleanup cycle.
- **Ambiguous target**: When `conversation_id` is omitted and the agent has multiple active tasks, return 400 with `{ error: "ambiguous_target", active_conversations: [...] }`. When the agent has exactly one active task, resolve automatically.

### Active Task Resolution

Channel adapters and API callers need to know if an agent is actively processing. New processor methods:

```typescript
// Returns all active tasks for an agent (for ambiguity detection)
getActiveTasks(agentKey: string): Array<{
  message_id: string;
  conversation_id: string;
  activity: string;
  started_at: number;
}>
```

Backed by: `SELECT message_id, conversation_id, last_activity, updated_at FROM messages WHERE agent = ? AND status = 'processing' ORDER BY updated_at DESC`

**Resolution logic** (used by both BTW and Steer endpoints):
1. Call `getActiveTasks(agentKey)`
2. If 0 results: return 409 `agent_idle`
3. If 1 result: auto-resolve, use that task
4. If >1 results and `conversation_id` provided: match by conversation_id
5. If >1 results and no `conversation_id`: return 400 `ambiguous_target` with the list

---

## Channel Integration

### Routing Logic (All Channels)

When a message arrives for a bot that is currently processing (`status = 'processing'` in messages table for that conversation):

| Message pattern | Action |
|---|---|
| Contains `btw` prefix (after bot mention) | Route to BTW endpoint |
| Any other message | Route to Steer endpoint |
| No active task | Route to normal message queue |

### Discord (NyxAI, NyxLabs instances)

**BTW**: `@nyx btw what are you working on?`
- Response sent as ephemeral message (flag `64`) — only sender sees it
- Does not appear in channel history

**Steer**: `@nyx also check the migration file`
- Confirmation: bot reacts with a checkmark emoji to the steer message
- On delivery: brief system note in thread: `"Steer delivered: also check the migration file"`

### Slack (Acme instance)

**BTW**: `@acme btw what file are you on?`
- Response sent as ephemeral message (`response_type: "ephemeral"`)
- Only visible to sender, disappears on reload

**Steer**: `@acme also check the auth middleware`
- Confirmation: bot reacts with checkmark emoji
- On delivery: threaded reply: `"Steer delivered: also check the auth middleware"`

### iOS Gateway (All instances)

**Prerequisite**: Input bar must remain enabled during agent streaming.

**UI changes**:
- Floating action button appears when an agent is actively processing
- Tap to open input sheet with two modes: "Side question" (BTW) and "Steer"
- **Side question responses**: Dismissible overlay/sheet, not in main thread
- **Steer confirmation**: Subtle inline system message in thread (e.g., gray italic text: `"Steer queued: also check the migration file"`)
- **Steer delivery**: Update system message to `"Steer delivered"` with checkmark

---

## MCP Tools

Two new tools added to NyxHive MCP server:

### `btw_agent`

```json
{
  "name": "btw_agent",
  "description": "Ask a side question to a running agent without disrupting its task. Read-only, ephemeral.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "target_agent": { "type": "string", "description": "Agent key to query" },
      "question": { "type": "string", "description": "Question to ask" }
    },
    "required": ["target_agent", "question"]
  }
}
```

### `steer_agent`

```json
{
  "name": "steer_agent",
  "description": "Inject context or direction into a running agent's task. Delivered at next checkpoint.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "target_agent": { "type": "string", "description": "Agent key to steer" },
      "message": { "type": "string", "description": "Context or direction to inject" },
      "priority": { "type": "string", "enum": ["normal", "interrupt"], "default": "normal" }
    },
    "required": ["target_agent", "message"]
  }
}
```

### Action Tags

Agent response parser extended to recognize:
- `[@btw agent: question]` -> calls BTW endpoint
- `[@steer agent: message]` -> calls Steer endpoint

---

## Architecture Diagram

```
                    Human (Discord/Slack/iOS)  or  Agent (MCP tool)
                                   |
                            ┌──────┴──────┐
                            │   Channel    │
                            │   Adapter    │
                            └──────┬──────┘
                                   │
                      ┌────────────┼────────────┐
                      │            │            │
                 btw prefix?    steer?     no active task?
                      │            │            │
                      v            v            v
             POST /btw      POST /steer    POST /message
                      │            │            │
                      v            v            v
            ┌─────────────┐  ┌──────────┐  ┌──────────┐
            │  Context     │  │  steers  │  │ messages │
            │  cache +     │  │  table   │  │  table   │
            │  Haiku call  │  │ (SQLite) │  │ (queue)  │
            │  (no tools)  │  └────┬─────┘  └──────────┘
            └──────┬──────┘       │
                   │              v
                   │     ┌──────────────────────┐
                   │     │  Current invocation   │
                   │     │  completes (subprocess│
                   │     │  exits naturally)     │
                   │     └────────┬──────────────┘
                   │              │
                   │              v
                   │     ┌──────────────────────┐
                   │     │  Processor checks     │
                   │     │  steers table before  │
                   │     │  next --resume turn   │
                   │     └────────┬──────────────┘
                   │              │
                   │              v
                   │     ┌──────────────────────┐
                   │     │  Save to history as   │
                   │     │  role: "user" with     │
                   │     │  type: "steer" metadata│
                   │     └────────┬──────────────┘
                   │              │
                   v              v
            Ephemeral        Agent sees steer
            response         in conversation
            (not persisted)  history on next turn
```

---

## Files to Modify

### New Files
- `src/queue/steers.ts` — Steers table, CRUD, delivery logic
- `src/queue/btw.ts` — BTW context snapshot + inference call

### Modified Files
- `src/queue/db.ts` — Add `steers` table creation to schema init
- `src/queue/processor.ts` — Add steer checkpoint check in `onProgress`, BTW context assembly
- `src/server/routes.ts` — Add `POST /api/agents/:agentKey/btw` and `POST /api/agents/:agentKey/steer`
- `src/mcp/tools.ts` — Register `btw_agent` and `steer_agent` MCP tools
- `src/queue/conversation.ts` — Render steer metadata prefix in history display (steers are `role: "user"` with `[STEER from ...]` prefix in content)
- `src/agents/invoke-cli.ts` — Handle steer-triggered subprocess restart (interrupt priority)
- `src/agents/invoke-codex.ts` — Handle steer-triggered turn restart (interrupt priority)
- `src/channels/discord.ts` — BTW/steer routing logic based on active task state, `deferReply` for BTW latency
- `src/channels/slack.ts` — BTW/steer routing logic based on active task state
- `src/types.ts` — `SteerMessage`, `BtwRequest`, `BtwResponse`, steer metadata in `ConversationMessage`

### iOS Gateway (separate repo: nyx-ios)
- Input bar: remain enabled during streaming
- Floating action button for BTW/Steer mode selection
- Dismissible overlay for BTW responses
- System message rendering for steer confirmations

---

## Success Criteria

1. Human can `@nyx btw <question>` on Discord/Slack during an active task and get an ephemeral answer without disrupting the agent
2. Human can send a message during an active task and it's treated as a steer, delivered at next turn boundary
3. Agents can BTW and steer other agents via MCP tools or action tags
4. Steers appear in conversation history as `role: "user"` with `type: "steer"` metadata and `[STEER from ...]` prefix
5. iOS Gateway allows input during streaming with mode selection
6. No task derailment — steers are additive context, not task replacement
7. Works identically across Claude CLI and Codex backends (turn-boundary delivery for both)
8. BTW calls are rate-limited (5/min per source) and cost-tracked in traces
9. Steers auto-expire after TTL (default 300s)

## Implementation Order

1. **BTW** — simpler, self-contained, immediate value. No new tables, no subprocess changes.
2. **Steer with turn-boundary delivery** — steers table, processor integration, delivered when current invocation completes and next starts via `--resume`.
3. **Steer with interrupt delivery** — SIGTERM + re-invoke for interrupt priority. Only after turn-boundary delivery is stable.
4. **Channel integration** — Discord/Slack routing, Gateway UI changes.
5. **MCP tools + action tags** — agent-to-agent BTW and steering.

# Slack Delivery Upgrade

Date: 2026-03-25

## Goals

Replace the current Slack "conjuring" trace / chunked-response model with a
structured delivery layer that maps runtime events to a small set of Slack
message types. The result should feel like following a well-managed thread,
not a chatbot dumping text.

## Design Decisions

### Thread Containment
Long-running work stays inside Slack threads, never spills into the parent
channel. One active task = one thread. Multiple active tasks should not flood
the channel.

### Progress Model
Phase-based, not token-streamed. Meaningful state labels:
`Planning`, `Running commands`, `Editing files`, `Reviewing`,
`Waiting for approval`, `Waiting for input`, `Completed`, `Failed`.

### Edit-over-Append
Prefer editing an existing progress message in-thread over posting many new
messages. Append a new message only when a durable milestone is reached (e.g.
completion summary, approval request, file-change summary).

### Approval UX
Slack Block Kit buttons as the primary path. Text-reply fallback only for
resilience if interactivity fails. Do not treat reply commands as an equal path.

### Structured Input UX
Narrow scope: button-based choices for bounded decisions, short plain-text
replies for open input. No modals, no general-purpose form flows.

### Completion Summaries
Always include a gateway deep-link. The Slack card is the summary; the gateway
is the full inspection surface.

### File-Change Reporting
Compact: files touched, add/remove counts if available, short summary,
verification status, and gateway link for full diff review.

### Message Types
Six types, no more abstraction:
1. **Progress update** - editable status message with phase label
2. **Approval request** - Block Kit buttons (approve/reject) + text fallback
3. **Input request** - Block Kit buttons for choices, text for open input
4. **Change summary** - compact file-change card
5. **Completion summary** - result + gateway deep-link
6. **Failure summary** - error + gateway deep-link

## Delivery Constraints

### Rate Limiting / Debounce
- Slack API: max 1 message update per 2s per channel (Slack rate limit: ~1/s
  for chat.update, but we target 2s for safety with concurrent agents).
- New messages: debounce at 1s minimum between posts to the same thread.
- Concurrent agent activity: per-channel token bucket (burst 5, refill 1/s).

### Retry and Recovery
- Use existing `withRetry` (exponential backoff, retry on 429/5xx).
- On persistent failure (3 retries exhausted): log, do not crash the
  processing loop, mark the Slack delivery as degraded in the trace.

### Truncation
- Slack block text limit: 3000 chars per section block.
- Total blocks per message: 50 (Slack limit).
- When content exceeds limits, truncate with "See full details in gateway"
  and include deep-link.
- File lists: show first 10 files, then "+N more in gateway".

### Edit-vs-Append Rules
| Condition | Action |
|---|---|
| Phase transition (planning -> running) | Edit progress message |
| Same phase, new tool activity | Edit progress message |
| Approval needed | Append new approval card |
| Input needed | Append new input card |
| Completion | Append completion summary, delete progress message |
| Failure | Append failure summary, delete progress message |
| File changes available | Append change summary (once per turn) |

## Implementation

### New module: `src/channels/slack/delivery.ts`
Contains `SlackDeliveryManager` — manages the lifecycle of messages in a
single Slack thread for one processing run.

Interface:
```typescript
interface SlackDeliveryManager {
  // Phase transitions — edits the progress message
  updatePhase(phase: SlackPhase): Promise<void>;

  // Append durable cards
  postApprovalRequest(proposal: ApprovalRequestData): Promise<void>;
  postInputRequest(request: InputRequestData): Promise<void>;
  postChangeSummary(changes: ChangeSummaryData): Promise<void>;
  postCompletionSummary(summary: CompletionSummaryData): Promise<void>;
  postFailureSummary(error: FailureSummaryData): Promise<void>;

  // Cleanup
  finalize(): Promise<void>;
}
```

### Gateway Deep-Links
Use `config.server.public_url` to construct:
- Thread link: `{public_url}/#/threads/{threadId}`
- Diff link: `{public_url}/#/threads/{threadId}?tab=changes`

### Integration
Replace the current "conjuring" trace + chunked-response flow in both
`handleMessage` and `handleMention` with the delivery manager. The progress
callback (`onProgress`) drives phase transitions instead of raw trace updates.

### Mapping from CLIProgress to Slack phases
| CLIProgress.phase | CLIProgress.activity pattern | Slack phase |
|---|---|---|
| working | contains "Read" or "planning" | Planning |
| working | contains "Bash", "command", "test" | Running commands |
| working | contains "Edit", "Write", file ops | Editing files |
| working | contains "review" | Reviewing |
| responding | any | Completing |

## Success Criteria
- One active task feels easy to follow in a thread
- Multiple active tasks don't flood the parent channel
- Approvals are one-click when possible
- Large coding turns summarize cleanly without raw diffs
- Every meaningful Slack summary provides a consistent path into the gateway

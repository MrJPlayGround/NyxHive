# Gateway Chat Runtime Upgrade

## Goal

Upgrade gateway chat with a NyxHive-native runtime contract and UI shell that can support richer coding turns without rebasing onto another app.

## Contract

### Thread + Turn

- `thread.started`
  - Emitted when gateway creates or resumes a thread for an active turn.
  - Payload: `threadId`, `agent`, `startedAt`, `created`.
- `turn.started`
  - Emitted once per send/crawl invocation.
  - Payload: `threadId`, `turn`, `agent`, `startedAt`.
- `turn.completed`
  - Emitted on success, failure, or abort.
  - Payload: `threadId`, `turn`, `agent`, `status`, `finishedAt`, `tokensIn`, `tokensOut`, `cost`, `durationMs`, `text`.

### Work Items

- `item.started`
- `item.updated`
- `item.completed`
  - Payload: `threadId`, `turn`, `item`.
  - `item` shape: `id`, `type`, `title`, optional `subtitle`, `details`, `command`, `outputPreview`, `exitCode`, `changes`, `timestamp`.
  - `type` is one of `command`, `file_change`, `mcp_tool`, `web_search`, `status`, `agent_message`.

### Requests

- `request.opened`
  - First implementation target: proposal approvals that already exist in NyxHive.
  - Shape: `requestId`, `kind`, `title`, `description`, `actions`, optional `proposal`.
- `request.resolved`
  - Shape: `requestId`, `kind`, `resolution`, `resolvedAt`.
- `user-input.requested`
- `user-input.resolved`
  - Reserved for future structured prompt-for-input flows.

### Context + Diff

- `context.updated`
  - Payload: `threadId`, `utilizationPct`, `estimated`.
- `diff.updated`
  - Payload: `threadId`, `changes`.
  - `changes` comes from thread file-change rows, not inferred UI state.

## Scope Split

### Cross-channel runtime semantics

- Thread/turn lifecycle
- Item lifecycle
- Request lifecycle
- Context pressure
- Persisted diff snapshots

### Gateway-only UI behavior

- Diff drawer and changed-files tree
- Inline request cards above the composer
- Terminal snippet chips sourced from gateway trace output
- Provider/model picker ergonomics
- Timeline presentation

## Delivery Order

1. Typed runtime event contract and gateway protocol declarations.
2. Diff drawer fed by persisted thread file changes.
3. Inline approval cards backed by proposal requests.
4. Gateway-only terminal snippet chips injected into outgoing prompts.
5. Provider/context header cleanup.
6. Turn timeline polish.

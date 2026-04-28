# Nyx Workspace Gateway Port List

## Position

The new workspace stays the base. We should port Nyx-native operational features from the old gateway, not the old gateway as a product.

## P0: Port First

1. Cockpit / multi-instance rail

   Port the old cockpit idea: `nyxai`, `nyxlabs`, and future local instances, each with presence, current run, pending requests, and quick switch.

   Source:
   - `src/gateway/src/pages/Cockpit.tsx`
   - `src/gateway/src/stores/fleet-chat.ts`
   - `src/gateway/src/components/cockpit/InstanceRail.tsx`

2. Execution / trace rail

   Workspace chat should show tool calls, command progress, file reads/writes, runtime status, and final verification outside the assistant message body.

   Source:
   - `src/gateway/src/components/chat/ExecutionPanel.tsx`
   - `src/gateway/src/components/chat/message-execution.ts`
   - `src/gateway/src/lib/runtime-events.ts`

3. Diff / changed-files panel

   When Nyx edits files, the workspace needs a clean changed-files rail: file tree, selected diff, attach snippet, open file.

   Source:
   - `src/gateway/src/components/chat/ThreadChangesPanel.tsx`
   - `src/gateway/src/lib/thread-changes.ts`

4. Pending request inbox

   Approval/input requests need to be first-class. "Nyx needs a decision" should surface outside the chat scroll.

   Source:
   - `src/gateway/src/components/cockpit/FleetInboxPanel.tsx`
   - `src/gateway/src/components/chat/ChatRequestCards.tsx`

5. Stream recovery logic

   Port the old gateway's self-repair patterns: stale stream timeout, auto-finalize, history repair, and stale placeholder pruning.

   Source:
   - `src/gateway/src/pages/Chat.tsx`
   - `src/gateway/src/stores/history-merge.ts`

## P1: Port Next

6. BTW / steer while Nyx is working

   While a run is active, User should be able to send `btw ...` or steering notes without killing the run.

   Source:
   - `src/gateway/src/lib/chat-commands.ts`
   - `src/gateway/src/pages/Chat.tsx`

7. Instance presence model

   Workspace needs richer status than connected/disconnected: idle, working, stale, needs input, errored, unreachable.

   Source:
   - `src/gateway/src/components/cockpit/instance-presence.ts`

8. Activity feed / needs attention

   A compact "what happened recently / what needs me" surface belongs on the workspace dashboard.

   Source:
   - `src/gateway/src/pages/ActivityFeed.tsx`
   - `src/gateway/src/components/home/NeedsAttentionPanel.tsx`

9. Procedural skills analytics

   New workspace already has skills, but old gateway has NyxHive-native audit/quality views. Port the analytics, not necessarily the old UI.

   Source:
   - `src/gateway/src/pages/ProceduralSkills.tsx`
   - `src/gateway/src/pages/procedural-skills-view.ts`

10. Logs display formatting

    Old gateway has useful log summarization and severity treatment. Workspace should use that in runtime/event panels.

    Source:
    - `src/gateway/src/pages/Logs.tsx`
    - `src/gateway/src/lib/log-display.ts`

## P2: Port Selectively

11. Proposals UI

    Useful, but it comes after cockpit, trace, diff, and requests.

    Source:
    - `src/gateway/src/components/proposals`
    - `src/gateway/src/stores/proposals.ts`

12. Scheduler controls

    Workspace already has jobs/tasks concepts. Port only NyxHive scheduler-specific controls and status formatting.

    Source:
    - `src/gateway/src/pages/Scheduler.tsx`

13. Agents / models / config detail pages

    Workspace already has provider/settings screens. Port only NyxHive-specific agent runtime cards, not duplicate generic settings.

    Source:
    - `src/gateway/src/pages/Agents.tsx`
    - `src/gateway/src/pages/Models.tsx`
    - `src/gateway/src/pages/Config.tsx`

## Do Not Port Wholesale

- Old gateway layout shell.
- Old generic chat page as-is.
- Duplicate auth/config plumbing.
- Old visual styling.
- Any Aether/Strider naming or assumptions.
- Anything that competes with the Hermes workspace base instead of extending it.

## Target Shape

Workspace is the main app. Cockpit is a workspace mode or panel. Trace, diff, and requests are docked developer rails. Multi-instance is presence plus switching, not orchestration theater.

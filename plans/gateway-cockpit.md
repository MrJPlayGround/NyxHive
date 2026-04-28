# Gateway Cockpit Plan

## Problem

The current gateway is single-instance by design.

- One websocket client: `src/gateway/src/lib/ws.ts`
- One auth store: `src/gateway/src/stores/auth.ts`
- One `instanceName`, one `leadAgent`
- One permanently-mounted `ChatPage` in `src/gateway/src/components/Layout.tsx`

That works for one hive. It sucks for the real setup:

- `NyxAI`
- `NyxLabs`
- `Aether`

Right now the user has to bounce between separate gateways to manage three repo owners. That kills continuity and makes the gateway inferior to the local cockpit.

## Direction

Build the web gateway into a fleet cockpit, not a prettier single chat.

The mental model should match the CLI:

- one front door
- multiple owners
- direct conversations by default
- shared run / approval / diff / trace surfaces

## Non-Goals

- Do not fake this by skinning the current single gateway chat.
- Do not introduce another orchestrator personality.
- Do not require three browser tabs.

## Architecture Call

Add a fleet client layer in the frontend.

Instead of one global `gateway`, the cockpit should manage a set of instance clients:

- `NyxAI`
- `NyxLabs`
- `Aether`

Each instance client needs:

- websocket URL
- device auth state
- instance metadata
- thread/session state
- stream lifecycle
- pending approvals

## Phase 1

Create fleet plumbing without deleting the current single-instance gateway.

Deliverables:

1. `FleetGatewayClient`
   - wraps multiple `GatewayClient` instances
   - keyed by instance slug
   - unified subscribe/request API where the caller specifies the target instance

2. `fleet-config` store
   - persistent browser-side config for known instances
   - name, ws URL, display label, preferred agent

3. `fleet-auth` store
   - tracks auth/connection state per instance
   - no more singleton `instanceName`

4. new `/cockpit` page
   - left rail: owners
   - center: active conversation
   - right rail: execution, diff, trace, approvals

## Phase 2

Move the current chat UX into cockpit-capable primitives.

Refactor:

- `MessageList`
- `MessageInput`
- `ExecutionPanel`
- `ThreadChangesPanel`
- request cards

These should become target-instance aware instead of assuming one global store.

## Phase 3

Unify the inbox.

The cockpit should show:

- cross-instance approvals
- active runs across the fleet
- unread messages
- stream status per owner

This is the point where the gateway becomes genuinely useful.

## First Implementation Slice

Recommended first slice:

1. Add `fleet-config` and hardcode the three local Tailscale endpoints in dev.
2. Build a minimal `/cockpit` page with:
   - owner switcher
   - per-instance connection status
   - one active conversation at a time
3. Reuse the current chat rendering for the selected instance only.
4. Keep `/chat` alive until `/cockpit` is stable.

## Hard Truth

If the gateway keeps a singleton websocket/auth model, it will never become a real cockpit.

The right move is a fleet layer first, page chrome second.

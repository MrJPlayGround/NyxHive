# Slack Channel Upgrades — OpenClaw Feature Parity

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring NyxHive's Slack channel to feature parity with OpenClaw's integration — interactive elements, streaming, per-channel config, and operational tooling — without breaking the live Acme deployment.

**Architecture:** The current `slack.ts` (1500 lines) is a single class handling all Slack logic. We'll extract new capabilities into focused modules under `src/channels/slack/`, keeping `slack.ts` as the orchestrator that delegates to them. All new features are opt-in via config so the existing deployment keeps working with zero config changes.

**Tech Stack:** @slack/bolt (existing), Slack Block Kit, Slack Web API (`chat.update`, `reactions.*`, `pins.*`), Slack streaming API (`assistant:write` scope)

---

## File Structure

```
src/channels/slack.ts                    # Existing — refactored to import from slack/ modules
src/channels/slack-types.ts              # Existing — extended with new config types
src/channels/slack/                      # NEW directory
  interactive.ts                         # Block Kit directive parser + action handlers
  streaming.ts                          # Live text streaming via Slack API
  identity.ts                           # Per-agent bot identity (name/icon/emoji)
  channel-config.ts                     # Per-channel config resolution
  reactions.ts                          # Reaction management (add/remove/list on any message)
  pins.ts                               # Pin management (pin/unpin/list)
  message-ops.ts                        # Message edit/delete operations
  chunking.ts                           # Configurable paragraph-aware message chunking
  events.ts                             # Channel/member event tracking
  arg-menus.ts                          # Slash command argument menus (buttons/selects)
  modals.ts                             # Modal form submissions
src/channels/utils.ts                   # Existing — splitMessage moved to chunking.ts, re-exported

src/__tests__/slack-interactive.test.ts  # Tests for directive parsing + action routing
src/__tests__/slack-streaming.test.ts    # Tests for streaming lifecycle
src/__tests__/slack-identity.test.ts     # Tests for identity resolution
src/__tests__/slack-channel-config.test.ts # Tests for per-channel config
src/__tests__/slack-chunking.test.ts     # Tests for paragraph-aware chunking
src/__tests__/slack-reactions.test.ts    # Tests for reaction management
src/__tests__/slack-pins.test.ts         # Tests for pin management
src/__tests__/slack-message-ops.test.ts  # Tests for edit/delete
src/__tests__/slack-events.test.ts       # Tests for channel/member events
src/__tests__/slack-arg-menus.test.ts    # Tests for arg menu rendering
src/__tests__/slack-modals.test.ts       # Tests for modal handling
```

---

## Tier 1 — Immediate Impact

### Task 1: Interactive Buttons & Selects

Agent responses can contain directives like `[[slack_buttons: Approve:approve, Reject:reject]]` and `[[slack_select: Pick model | Sonnet:sonnet, Opus:opus]]`. These get parsed out and rendered as Slack Block Kit elements. When a user clicks, the value is sent back as a message to the agent.

**Files:**
- Create: `src/channels/slack/interactive.ts`
- Create: `src/__tests__/slack-interactive.test.ts`
- Modify: `src/channels/slack.ts` (register action handlers, call directive parser before sending)
- Modify: `src/channels/slack-types.ts` (add `interactive_replies` config flag)
- Modify: `src/config-schema.ts` (add `interactive_replies` to slack schema)
- Modify: `src/types.ts` (add `interactive_replies` to slack type)

- [ ] **Step 1: Write failing tests for directive parsing**

```typescript
// src/__tests__/slack-interactive.test.ts
import { describe, it, expect } from "bun:test";
import { parseInteractiveDirectives, buildBlockKitBlocks } from "../channels/slack/interactive.js";

describe("parseInteractiveDirectives", () => {
  it("extracts button directives from text", () => {
    const input = "Here are your options:\n[[slack_buttons: Approve:approve, Reject:reject]]";
    const result = parseInteractiveDirectives(input);
    expect(result.cleanText).toBe("Here are your options:");
    expect(result.directives).toHaveLength(1);
    expect(result.directives[0].type).toBe("buttons");
    expect(result.directives[0].options).toEqual([
      { label: "Approve", value: "approve" },
      { label: "Reject", value: "reject" },
    ]);
  });

  it("extracts select directives with placeholder", () => {
    const input = "Choose a model:\n[[slack_select: Pick model | Sonnet:sonnet, Opus:opus, Haiku:haiku]]";
    const result = parseInteractiveDirectives(input);
    expect(result.cleanText).toBe("Choose a model:");
    expect(result.directives).toHaveLength(1);
    expect(result.directives[0].type).toBe("select");
    expect(result.directives[0].placeholder).toBe("Pick model");
    expect(result.directives[0].options).toHaveLength(3);
  });

  it("returns original text when no directives", () => {
    const input = "Just a normal message";
    const result = parseInteractiveDirectives(input);
    expect(result.cleanText).toBe("Just a normal message");
    expect(result.directives).toHaveLength(0);
  });

  it("handles multiple directives", () => {
    const input = "Pick:\n[[slack_buttons: A:a, B:b]]\nAlso:\n[[slack_select: Choose | X:x, Y:y]]";
    const result = parseInteractiveDirectives(input);
    expect(result.directives).toHaveLength(2);
  });

  it("handles labels with spaces", () => {
    const input = "[[slack_buttons: Do Thing:do_thing, Cancel All:cancel_all]]";
    const result = parseInteractiveDirectives(input);
    expect(result.directives[0].options[0].label).toBe("Do Thing");
  });
});

describe("buildBlockKitBlocks", () => {
  it("builds section + actions blocks for buttons", () => {
    const blocks = buildBlockKitBlocks("Pick one:", [{
      type: "buttons" as const,
      options: [
        { label: "Yes", value: "yes" },
        { label: "No", value: "no" },
      ],
    }], "callback-123");
    expect(blocks).toHaveLength(2); // section + actions
    expect(blocks[1].type).toBe("actions");
    expect(blocks[1].elements).toHaveLength(2);
    expect(blocks[1].elements[0].type).toBe("button");
  });

  it("builds section + actions blocks for select", () => {
    const blocks = buildBlockKitBlocks("Choose:", [{
      type: "select" as const,
      placeholder: "Pick one",
      options: [
        { label: "A", value: "a" },
        { label: "B", value: "b" },
      ],
    }], "callback-456");
    expect(blocks).toHaveLength(2);
    expect(blocks[1].elements[0].type).toBe("static_select");
  });

  it("uses opaque callback IDs (values not exposed)", () => {
    const blocks = buildBlockKitBlocks("Pick:", [{
      type: "buttons" as const,
      options: [{ label: "Secret", value: "secret_value" }],
    }], "cb-789");
    const button = blocks[1].elements[0];
    // action_id should contain the callback prefix, value is opaque token
    expect(button.action_id).toContain("nyxhive:");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/__tests__/slack-interactive.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement directive parser and Block Kit builder**

```typescript
// src/channels/slack/interactive.ts
import { randomUUID } from "crypto";

export interface InteractiveOption {
  label: string;
  value: string;
}

export interface InteractiveDirective {
  type: "buttons" | "select";
  placeholder?: string;
  options: InteractiveOption[];
}

export interface ParseResult {
  cleanText: string;
  directives: InteractiveDirective[];
}

const BUTTON_RE = /\[\[slack_buttons:\s*(.+?)\]\]/g;
const SELECT_RE = /\[\[slack_select:\s*(.+?)\]\]/g;

function parseOptions(raw: string): InteractiveOption[] {
  return raw.split(",").map((part) => {
    const trimmed = part.trim();
    const colonIdx = trimmed.lastIndexOf(":");
    if (colonIdx <= 0) return { label: trimmed, value: trimmed.toLowerCase().replace(/\s+/g, "_") };
    return {
      label: trimmed.slice(0, colonIdx).trim(),
      value: trimmed.slice(colonIdx + 1).trim(),
    };
  });
}

export function parseInteractiveDirectives(text: string): ParseResult {
  const directives: InteractiveDirective[] = [];
  let cleanText = text;

  // Parse buttons
  for (const match of text.matchAll(BUTTON_RE)) {
    directives.push({ type: "buttons", options: parseOptions(match[1]) });
    cleanText = cleanText.replace(match[0], "");
  }

  // Parse selects (format: "placeholder | opt1:val1, opt2:val2")
  for (const match of text.matchAll(SELECT_RE)) {
    const raw = match[1];
    const pipeIdx = raw.indexOf("|");
    if (pipeIdx > 0) {
      directives.push({
        type: "select",
        placeholder: raw.slice(0, pipeIdx).trim(),
        options: parseOptions(raw.slice(pipeIdx + 1)),
      });
    } else {
      directives.push({ type: "select", options: parseOptions(raw) });
    }
    cleanText = cleanText.replace(match[0], "");
  }

  return { cleanText: cleanText.trim(), directives };
}

// In-memory map of opaque tokens → original values.
// Entries expire after 1 hour. Bounded to 10k entries.
const tokenStore = new Map<string, { value: string; expires: number }>();
const TOKEN_TTL_MS = 60 * 60 * 1000;
const TOKEN_MAX = 10_000;

function mintToken(value: string): string {
  const token = randomUUID().slice(0, 12);
  if (tokenStore.size >= TOKEN_MAX) {
    // Evict oldest entries
    const now = Date.now();
    for (const [k, v] of tokenStore) {
      if (v.expires < now) tokenStore.delete(k);
    }
    // If still full, delete first 1000
    if (tokenStore.size >= TOKEN_MAX) {
      let count = 0;
      for (const k of tokenStore.keys()) {
        tokenStore.delete(k);
        if (++count >= 1000) break;
      }
    }
  }
  tokenStore.set(token, { value, expires: Date.now() + TOKEN_TTL_MS });
  return token;
}

export function resolveToken(token: string): string | null {
  const entry = tokenStore.get(token);
  if (!entry) return null;
  if (entry.expires < Date.now()) {
    tokenStore.delete(token);
    return null;
  }
  return entry.value;
}

export function buildBlockKitBlocks(
  text: string,
  directives: InteractiveDirective[],
  callbackId: string,
): any[] {
  const blocks: any[] = [];

  // Text section
  if (text) {
    blocks.push({ type: "section", text: { type: "mrkdwn", text } });
  }

  for (const directive of directives) {
    if (directive.type === "buttons") {
      blocks.push({
        type: "actions",
        elements: directive.options.map((opt) => {
          const token = mintToken(opt.value);
          return {
            type: "button",
            text: { type: "plain_text", text: opt.label },
            action_id: `nyxhive:reply_button:${callbackId}:${token}`,
            value: token,
          };
        }),
      });
    } else if (directive.type === "select") {
      blocks.push({
        type: "actions",
        elements: [{
          type: "static_select",
          placeholder: {
            type: "plain_text",
            text: directive.placeholder ?? "Choose...",
          },
          action_id: `nyxhive:reply_select:${callbackId}:${randomUUID().slice(0, 8)}`,
          options: directive.options.map((opt) => ({
            text: { type: "plain_text", text: opt.label },
            value: mintToken(opt.value),
          })),
        }],
      });
    }
  }

  return blocks;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/__tests__/slack-interactive.test.ts`
Expected: PASS

- [ ] **Step 5: Wire interactive handlers into SlackChannel**

In `src/channels/slack.ts`:

1. Import `parseInteractiveDirectives`, `buildBlockKitBlocks`, `resolveToken` from `./slack/interactive.js`
2. Add `interactive_replies` config check (disabled by default)
3. In the response-sending sections (after `splitMessage`), check for directives in the **last chunk** only
4. Register `app.action(/^nyxhive:reply_button:/, ...)` and `app.action(/^nyxhive:reply_select:/, ...)` handlers in `setupHandlers()`
5. When a button/select is clicked, resolve the token, and send the value as a new message to the agent in the same thread

In `src/channels/slack-types.ts`, `src/config-schema.ts`, `src/types.ts`:
- Add `interactive_replies?: boolean` to the slack config (default: `false`)

- [ ] **Step 6: Add integration test for action handler routing**

```typescript
// Add to src/__tests__/slack-interactive.test.ts
describe("resolveToken", () => {
  it("resolves a valid token", () => {
    const { parseInteractiveDirectives, buildBlockKitBlocks, resolveToken } = require("../channels/slack/interactive.js");
    const blocks = buildBlockKitBlocks("test", [{
      type: "buttons",
      options: [{ label: "Go", value: "go_value" }],
    }], "test-cb");
    const tokenValue = blocks[1].elements[0].value;
    expect(resolveToken(tokenValue)).toBe("go_value");
  });

  it("returns null for unknown token", () => {
    const { resolveToken } = require("../channels/slack/interactive.js");
    expect(resolveToken("nonexistent")).toBeNull();
  });
});
```

- [ ] **Step 7: Run full test suite**

Run: `bun test`
Expected: All tests pass

- [ ] **Step 8: Type check**

Run: `bunx tsc --noEmit`
Expected: No errors

- [ ] **Step 9: Commit**

```bash
git add src/channels/slack/interactive.ts src/__tests__/slack-interactive.test.ts src/channels/slack.ts src/channels/slack-types.ts src/config-schema.ts src/types.ts
git commit -m "feat(slack): interactive buttons and selects via Block Kit directives"
```

---

### Task 2: Proposal Notifications with Approve/Reject Buttons

Slack is the only major channel missing `sendProposalNotification`. Discord and Telegram both have it. This is a concrete use of interactive buttons.

**Files:**
- Modify: `src/channels/slack.ts` (add `sendProposalNotification` method, add proposal action handlers)
- Modify: `src/channels/slack-types.ts` (add `proposalStore?: ProposalStore` to `SlackChannelOpts`)
- Modify: `src/framework/channels/slack.ts` (pass `proposalStore` from deps)
- Create: `src/__tests__/slack-proposals.test.ts`

**Dependency:** `ProposalStore` lives at `src/proposals/store.ts` with `approve(proposalId, approvedBy)` and `reject(proposalId, reason)`. The `SlackChannel` needs a reference to it — add `proposalStore?: ProposalStore` to `SlackChannelOpts` and store as `this.proposalStore`.

- [ ] **Step 1: Write failing test for proposal notification formatting**

```typescript
// src/__tests__/slack-proposals.test.ts
import { describe, it, expect } from "bun:test";
import { formatSlackProposalBlocks } from "../channels/slack/interactive.js";

describe("formatSlackProposalBlocks", () => {
  const mockProposal = {
    proposal_id: "prop-123",
    title: "Add retry logic to webhook handler",
    category: "feature",
    effort: "small",
    description: "Adds exponential backoff when webhook delivery fails",
    status: "proposed",
    agent: "nyx",
    created_at: "2026-03-20T10:00:00Z",
    files: ["src/channels/webhook.ts"],
  };

  it("builds blocks with title, description, and approve/reject buttons", () => {
    const blocks = formatSlackProposalBlocks(mockProposal as any);
    // Should have: header section, details section, actions row
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    const actions = blocks.find((b: any) => b.type === "actions");
    expect(actions).toBeDefined();
    expect(actions.elements).toHaveLength(2);
    // Button custom_ids should encode proposal_id
    expect(actions.elements[0].action_id).toContain("prop-123");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/slack-proposals.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement `formatSlackProposalBlocks` and `sendProposalNotification`**

Add to `src/channels/slack/interactive.ts`:

```typescript
import type { Proposal } from "../../proposals/store.js";

export function formatSlackProposalBlocks(proposal: Proposal): any[] {
  const statusEmoji = proposal.status === "proposed" ? ":sparkles:" : ":arrows_counterclockwise:";
  const effortLabel = proposal.effort ?? "unknown";
  const fileList = proposal.files?.length
    ? proposal.files.map(f => `\`${f}\``).join(", ")
    : "none specified";

  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `${statusEmoji} *Proposal: ${proposal.title}*\n` +
          `Category: \`${proposal.category}\` | Effort: \`${effortLabel}\` | Agent: \`${proposal.agent}\`\n` +
          `Files: ${fileList}\n\n${proposal.description ?? ""}`,
      },
    },
    {
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Approve" },
          style: "primary",
          action_id: `nyxhive:proposal_approve:${proposal.proposal_id}`,
          value: proposal.proposal_id,
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Reject" },
          style: "danger",
          action_id: `nyxhive:proposal_reject:${proposal.proposal_id}`,
          value: proposal.proposal_id,
        },
      ],
    },
  ];
}
```

Add `sendProposalNotification` to `SlackChannel` class in `slack.ts`:

```typescript
async sendProposalNotification(recipientId: string, proposal: Proposal): Promise<void> {
  try {
    const blocks = formatSlackProposalBlocks(proposal);
    await withRetry(() => this.app.client.chat.postMessage({
      channel: recipientId,
      text: `Proposal: ${proposal.title}`, // fallback
      blocks,
    }), { baseDelayMs: 500 });
    this.stats.messagesSent++;
  } catch (err) {
    logger.warn(`[slack] sendProposalNotification failed: ${err}`);
  }
}
```

Register proposal action handlers in `setupHandlers()`.

**Important:** `ProposalStore.approve(proposalId, approvedBy)` requires an `approvedBy` string. Use the Slack user ID from `body.user.id`. `ProposalStore.reject(proposalId, reason)` requires a reason string.

```typescript
this.app.action(/^nyxhive:proposal_approve:/, async ({ action, ack, client, body }: any) => {
  await ack();
  if (!this.proposalStore) return;
  const proposalId = action.value;
  const approvedBy = body.user?.id ?? "slack-unknown";
  try {
    const result = this.proposalStore.approve(proposalId, approvedBy);
    await client.chat.postMessage({
      channel: body.channel?.id ?? body.user?.id,
      text: result ? `Proposal \`${proposalId}\` approved by <@${approvedBy}>.` : `Proposal \`${proposalId}\` not found or already processed.`,
    });
  } catch (err) {
    logger.warn(`[slack] Proposal approve action failed: ${err}`);
  }
});

this.app.action(/^nyxhive:proposal_reject:/, async ({ action, ack, client, body }: any) => {
  await ack();
  if (!this.proposalStore) return;
  const proposalId = action.value;
  try {
    const result = this.proposalStore.reject(proposalId, "Rejected via Slack");
    await client.chat.postMessage({
      channel: body.channel?.id ?? body.user?.id,
      text: result ? `Proposal \`${proposalId}\` rejected.` : `Proposal \`${proposalId}\` not found or already processed.`,
    });
  } catch (err) {
    logger.warn(`[slack] Proposal reject action failed: ${err}`);
  }
});
```

- [ ] **Step 4: Update management.ts to include slack in proposal notification channels**

In `src/queue/management.ts` at line ~590, the name-based channel filter gates proposal notifications. The cleaner fix is to remove the name-based check entirely and rely on the capability check (`ch.sendProposalNotification`) that already exists at line ~594. Replace:
```typescript
if (ch.name === "discord" || ch.name === "telegram") {
```
with:
```typescript
if (ch.sendProposalNotification) {
```
This makes any channel that implements `sendProposalNotification` automatically eligible — no need to update this filter for future channels.

- [ ] **Step 5: Run tests**

Run: `bun test src/__tests__/slack-proposals.test.ts && bun test`
Expected: All pass

- [ ] **Step 6: Type check and commit**

Run: `bunx tsc --noEmit`

```bash
git add src/channels/slack/interactive.ts src/channels/slack.ts src/__tests__/slack-proposals.test.ts src/queue/management.ts
git commit -m "feat(slack): proposal notifications with approve/reject buttons"
```

---

### Task 3: Live Text Streaming

Replace the current "Conjuring... + trace updates every 2s" pattern with real-time text streaming using Slack's `chat.postMessage` → `chat.update` pattern. As the agent produces output, we progressively update the message with the latest text.

**Note:** Slack's native `chat.startStream`/`appendStream`/`stopStream` requires the `assistant:write` scope and only works in thread contexts with the Agents & AI Apps API. We'll use the more reliable `postMessage` → `update` pattern which works everywhere.

**Files:**
- Create: `src/channels/slack/streaming.ts`
- Create: `src/__tests__/slack-streaming.test.ts`
- Modify: `src/channels/slack.ts` (use streaming in message handler)
- Modify: `src/channels/slack-types.ts` (add streaming config)
- Modify: `src/config-schema.ts` (add streaming config)
- Modify: `src/types.ts` (add streaming config)

- [ ] **Step 1: Write failing tests for streaming manager**

```typescript
// src/__tests__/slack-streaming.test.ts
import { describe, it, expect } from "bun:test";
import { SlackStreamManager } from "../channels/slack/streaming.js";

describe("SlackStreamManager", () => {
  it("throttles updates to configured interval", async () => {
    let updateCount = 0;
    const manager = new SlackStreamManager({
      updateIntervalMs: 100,
      maxChars: 4000,
      onUpdate: async (text) => { updateCount++; },
      onFinalize: async (text) => {},
    });

    manager.append("Hello ");
    manager.append("world ");
    manager.append("test ");
    // Only 1 update should fire within throttle window
    await new Promise(r => setTimeout(r, 50));
    expect(updateCount).toBeLessThanOrEqual(1);

    await manager.finalize();
  });

  it("truncates to maxChars with ellipsis", () => {
    const manager = new SlackStreamManager({
      updateIntervalMs: 100,
      maxChars: 20,
      onUpdate: async () => {},
      onFinalize: async () => {},
    });

    manager.append("A".repeat(50));
    const preview = manager.getCurrentText();
    expect(preview.length).toBeLessThanOrEqual(23); // 20 + "..."
  });

  it("calls onFinalize with full text on finalize()", async () => {
    let finalText = "";
    const manager = new SlackStreamManager({
      updateIntervalMs: 50,
      maxChars: 4000,
      onUpdate: async () => {},
      onFinalize: async (text) => { finalText = text; },
    });

    manager.append("Hello ");
    manager.append("world");
    await manager.finalize();
    expect(finalText).toBe("Hello world");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/__tests__/slack-streaming.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement SlackStreamManager**

```typescript
// src/channels/slack/streaming.ts

export interface StreamManagerOpts {
  updateIntervalMs: number;  // Min ms between Slack API updates (default 500)
  maxChars: number;          // Max chars for preview message (default 4000)
  onUpdate: (text: string) => Promise<void>;
  onFinalize: (text: string) => Promise<void>;
}

export class SlackStreamManager {
  private buffer = "";
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastUpdate = 0;
  private opts: StreamManagerOpts;
  private finalized = false;

  constructor(opts: StreamManagerOpts) {
    this.opts = opts;
  }

  append(chunk: string): void {
    if (this.finalized) return;
    this.buffer += chunk;
    this.scheduleUpdate();
  }

  getCurrentText(): string {
    if (this.buffer.length <= this.opts.maxChars) return this.buffer;
    return this.buffer.slice(0, this.opts.maxChars) + "...";
  }

  private scheduleUpdate(): void {
    if (this.timer) return;
    const elapsed = Date.now() - this.lastUpdate;
    const delay = Math.max(0, this.opts.updateIntervalMs - elapsed);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.lastUpdate = Date.now();
      if (!this.finalized) {
        this.opts.onUpdate(this.getCurrentText()).catch(() => {});
      }
    }, delay);
  }

  async finalize(): Promise<void> {
    this.finalized = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.opts.onFinalize(this.buffer);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/__tests__/slack-streaming.test.ts`
Expected: PASS

- [ ] **Step 5: Wire streaming into SlackChannel message handler**

In `src/channels/slack.ts`, modify the message handling flow:

1. Add `streaming` config option: `{ enabled: boolean; update_interval_ms: number; max_preview_chars: number }` (defaults: `false`, `500`, `4000`)
2. The existing `onProgress` callback already fires with `info.activity` strings (tool names). Streaming uses a different path: the `processImmediate` result contains `result.response` as the final text. To enable live preview, we use the existing trace message (`traceTs`) and progressively update it:
   - Post initial "Conjuring..." message (as before, reuse `traceTs`)
   - In `onProgress`, use `info.textSoFar` (already available on `CLIProgress` in `src/agents/invoke.ts` — the CLI layer captures stdout and exposes it via `textSoFar` and `textDelta` fields). Append `info.textDelta` to `SlackStreamManager` on each progress callback.
   - StreamManager updates the trace message via `chat.update` at throttled intervals, showing both trace activity AND partial response text
   - On completion, finalize: delete the stream message and post the final response as normal
3. **Wiring:** The `onProgress` callback in `handleMessage` already receives progress info. Check if `info.textDelta` is defined — if so, feed it to the stream manager. The `CLIProgress` type already has these fields; the only change needed is to ensure `processImmediate` forwards them through its `onProgress` callback (check the call chain in `src/queue/processor.ts`).
4. **Fallback:** If streaming is enabled but no `textDelta` is available (e.g., non-CLI providers), the behavior degrades gracefully to the current trace-only pattern — no breakage.

Add to config schema and types:
```
streaming?: { enabled?: boolean; update_interval_ms?: number; max_preview_chars?: number }
```

- [ ] **Step 6: Run full test suite and type check**

Run: `bun test && bunx tsc --noEmit`
Expected: All pass

- [ ] **Step 7: Commit**

```bash
git add src/channels/slack/streaming.ts src/__tests__/slack-streaming.test.ts src/channels/slack.ts src/channels/slack-types.ts src/config-schema.ts src/types.ts
git commit -m "feat(slack): live text streaming via progressive message updates"
```

---

### Task 4: Message Edit & Delete

Agent can programmatically edit or delete its own previously sent messages. Exposed as methods on SlackChannel that can be called from the processor or via MCP tools.

**Files:**
- Create: `src/channels/slack/message-ops.ts`
- Create: `src/__tests__/slack-message-ops.test.ts`
- Modify: `src/channels/slack.ts` (expose edit/delete methods)
- Modify: `src/channels/types.ts` (add optional `editMessage`/`deleteMessage` to Channel interface)

- [ ] **Step 1: Write failing tests**

```typescript
// src/__tests__/slack-message-ops.test.ts
import { describe, it, expect } from "bun:test";
import { validateEditParams, validateDeleteParams } from "../channels/slack/message-ops.js";

describe("message-ops validation", () => {
  it("validates edit params", () => {
    expect(validateEditParams("C123", "1234567890.123456", "new text")).toEqual({ ok: true });
    expect(validateEditParams("", "1234567890.123456", "new text").ok).toBe(false);
    expect(validateEditParams("C123", "", "new text").ok).toBe(false);
    expect(validateEditParams("C123", "1234567890.123456", "").ok).toBe(false);
  });

  it("validates delete params", () => {
    expect(validateDeleteParams("C123", "1234567890.123456")).toEqual({ ok: true });
    expect(validateDeleteParams("", "1234567890.123456").ok).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/__tests__/slack-message-ops.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement message ops**

```typescript
// src/channels/slack/message-ops.ts

interface ValidationResult {
  ok: boolean;
  error?: string;
}

export function validateEditParams(channel: string, ts: string, text: string): ValidationResult {
  if (!channel) return { ok: false, error: "channel is required" };
  if (!ts) return { ok: false, error: "ts is required" };
  if (!text) return { ok: false, error: "text is required" };
  return { ok: true };
}

export function validateDeleteParams(channel: string, ts: string): ValidationResult {
  if (!channel) return { ok: false, error: "channel is required" };
  if (!ts) return { ok: false, error: "ts is required" };
  return { ok: true };
}

export async function editMessage(
  client: any,
  channel: string,
  ts: string,
  text: string,
): Promise<{ ok: boolean; error?: string }> {
  const validation = validateEditParams(channel, ts, text);
  if (!validation.ok) return validation;
  try {
    await client.chat.update({ channel, ts, text, blocks: [{ type: "section", text: { type: "mrkdwn", text } }] });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

export async function deleteMessage(
  client: any,
  channel: string,
  ts: string,
): Promise<{ ok: boolean; error?: string }> {
  const validation = validateDeleteParams(channel, ts);
  if (!validation.ok) return validation;
  try {
    await client.chat.delete({ channel, ts });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}
```

- [ ] **Step 4: Run tests, verify pass**

Run: `bun test src/__tests__/slack-message-ops.test.ts`

- [ ] **Step 5: Add editMessage/deleteMessage to Channel interface and SlackChannel**

In `src/channels/types.ts`:
```typescript
editMessage?(channel: string, ts: string, text: string): Promise<{ ok: boolean; error?: string }>;
deleteMessage?(channel: string, ts: string): Promise<{ ok: boolean; error?: string }>;
```

In `src/channels/slack.ts`, add methods that delegate to the message-ops module.

- [ ] **Step 6: Run full test suite + type check, commit**

Run: `bun test && bunx tsc --noEmit`

```bash
git add src/channels/slack/message-ops.ts src/__tests__/slack-message-ops.test.ts src/channels/slack.ts src/channels/types.ts
git commit -m "feat(slack): message edit and delete operations"
```

---

### Task 5: Custom Bot Identity Per Agent

When multiple agents share a Slack workspace, each should post with its own name and avatar. Uses Slack's `chat:write.customize` scope.

**Files:**
- Create: `src/channels/slack/identity.ts`
- Create: `src/__tests__/slack-identity.test.ts`
- Modify: `src/channels/slack.ts` (apply identity when posting messages)
- Modify: `src/config-schema.ts` (add identity fields to agent config)
- Modify: `src/types.ts` (add identity fields)

- [ ] **Step 1: Write failing tests**

```typescript
// src/__tests__/slack-identity.test.ts
import { describe, it, expect } from "bun:test";
import { resolveSlackIdentity } from "../channels/slack/identity.js";

describe("resolveSlackIdentity", () => {
  it("returns empty object when no identity configured", () => {
    const result = resolveSlackIdentity(undefined);
    expect(result).toEqual({});
  });

  it("returns username and icon_emoji", () => {
    const result = resolveSlackIdentity({ slack_username: "Morph", slack_emoji: ":robot_face:" });
    expect(result).toEqual({ username: "Morph", icon_emoji: ":robot_face:" });
  });

  it("returns username and icon_url", () => {
    const result = resolveSlackIdentity({ slack_username: "Nyx", slack_icon_url: "https://example.com/nyx.png" });
    expect(result).toEqual({ username: "Nyx", icon_url: "https://example.com/nyx.png" });
  });

  it("prefers icon_url over icon_emoji", () => {
    const result = resolveSlackIdentity({
      slack_username: "Test",
      slack_emoji: ":robot:",
      slack_icon_url: "https://example.com/icon.png",
    });
    expect(result.icon_url).toBe("https://example.com/icon.png");
    expect(result.icon_emoji).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify fail, implement, verify pass**

```typescript
// src/channels/slack/identity.ts

export interface SlackIdentityConfig {
  slack_username?: string;
  slack_emoji?: string;
  slack_icon_url?: string;
}

export interface SlackIdentityPayload {
  username?: string;
  icon_emoji?: string;
  icon_url?: string;
}

export function resolveSlackIdentity(config: SlackIdentityConfig | undefined): SlackIdentityPayload {
  if (!config) return {};
  const result: SlackIdentityPayload = {};
  if (config.slack_username) result.username = config.slack_username;
  if (config.slack_icon_url) {
    result.icon_url = config.slack_icon_url;
  } else if (config.slack_emoji) {
    result.icon_emoji = config.slack_emoji;
  }
  return result;
}
```

- [ ] **Step 3: Wire into SlackChannel**

In `src/channels/slack.ts`, when posting messages after processing:
1. The agent name is available from `result.agent` (returned by `processImmediate`), which is already used at line 526 for audit logging. Use this to look up identity config.
2. Look up `this.config.agents[result.agent]?.identity` for Slack-specific fields
3. Spread `resolveSlackIdentity(this.config.agents[result.agent]?.identity)` into all `chat.postMessage` calls in the response-sending sections (both in `handleMessage` at line ~509 and `handleMention` at line ~679)

Add to `AgentConfig` in `src/types.ts`:
```typescript
identity?: {
  slack_username?: string;
  slack_emoji?: string;
  slack_icon_url?: string;
};
```

Add corresponding Zod schema in `src/config-schema.ts`.

- [ ] **Step 4: Run full test suite + type check, commit**

Run: `bun test && bunx tsc --noEmit`

```bash
git add src/channels/slack/identity.ts src/__tests__/slack-identity.test.ts src/channels/slack.ts src/config-schema.ts src/types.ts
git commit -m "feat(slack): per-agent bot identity (name/icon/emoji)"
```

---

## Tier 2 — Operational

### Task 6: Per-Channel Config

Each Slack channel can have its own system prompt, tool allowlist, user allowlist, and require-mention override.

**Files:**
- Create: `src/channels/slack/channel-config.ts`
- Create: `src/__tests__/slack-channel-config.test.ts`
- Modify: `src/channels/slack.ts` (resolve per-channel config before processing)
- Modify: `src/config-schema.ts` and `src/types.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// src/__tests__/slack-channel-config.test.ts
import { describe, it, expect } from "bun:test";
import { resolveChannelConfig } from "../channels/slack/channel-config.js";

describe("resolveChannelConfig", () => {
  const globalDefaults = { require_mention: false, system_prompt: undefined, allowed_users: undefined };

  it("returns defaults when no per-channel config", () => {
    const result = resolveChannelConfig("C_UNKNOWN", undefined);
    expect(result.require_mention).toBe(false);
    expect(result.system_prompt).toBeUndefined();
  });

  it("returns per-channel overrides", () => {
    const channels = {
      C_SUPPORT: {
        agent: "morph",
        require_mention: true,
        system_prompt: "You are a support agent.",
        allowed_users: ["U123"],
      },
    };
    const result = resolveChannelConfig("C_SUPPORT", channels);
    expect(result.agent).toBe("morph");
    expect(result.require_mention).toBe(true);
    expect(result.system_prompt).toBe("You are a support agent.");
    expect(result.allowed_users).toEqual(["U123"]);
  });

  it("channels not in config get defaults", () => {
    const channels = { C_OTHER: { agent: "nyx" } };
    const result = resolveChannelConfig("C_RANDOM", channels);
    expect(result.agent).toBeUndefined();
  });
});
```

- [ ] **Step 2: Implement, test, wire into SlackChannel, full test + tsc, commit**

```typescript
// src/channels/slack/channel-config.ts

export interface PerChannelConfig {
  agent?: string;
  require_mention?: boolean;
  system_prompt?: string;
  allowed_users?: string[];
  tools?: string[];
  allow_bots?: boolean;
}

export function resolveChannelConfig(
  channelId: string,
  channels: Record<string, PerChannelConfig> | undefined,
): PerChannelConfig {
  if (!channels || !channels[channelId]) {
    return { require_mention: false };
  }
  return { require_mention: false, ...channels[channelId] };
}
```

Config schema additions:
```
channels?: Record<string, {
  agent?: string;
  require_mention?: boolean;
  system_prompt?: string;
  allowed_users?: string[];
  tools?: string[];
  allow_bots?: boolean;
}>
```

- [ ] **Step 3: Commit**

```bash
git commit -m "feat(slack): per-channel config (agent, system_prompt, allowed_users, require_mention)"
```

---

### Task 7: Configurable Ack & Typing Reactions

Per-agent emoji for the "processing" and "done" states. Falls back to current `:eyes:` / `:white_check_mark:` defaults.

**Files:**
- Create: `src/__tests__/slack-reactions-config.test.ts`
- Modify: `src/channels/slack/identity.ts` (add reaction resolution)
- Modify: `src/channels/slack.ts` (parameterize reaction names)
- Modify: `src/types.ts` and `src/config-schema.ts` (add reaction config to identity)

- [ ] **Step 1: Write failing tests for reaction resolution**

```typescript
// src/__tests__/slack-reactions-config.test.ts
import { describe, it, expect } from "bun:test";
import { resolveReactions } from "../channels/slack/identity.js";

describe("resolveReactions", () => {
  it("returns defaults when no config", () => {
    const r = resolveReactions(undefined);
    expect(r.ack).toBe("eyes");
    expect(r.done).toBe("white_check_mark");
    expect(r.error).toBe("x");
    expect(r.typing).toBeUndefined();
  });

  it("overrides configured reactions", () => {
    const r = resolveReactions({ ack_reaction: "hourglass", done_reaction: "sparkles" });
    expect(r.ack).toBe("hourglass");
    expect(r.done).toBe("sparkles");
    expect(r.error).toBe("x"); // still default
  });

  it("strips colons from emoji names", () => {
    const r = resolveReactions({ ack_reaction: ":brain:" });
    expect(r.ack).toBe("brain");
  });

  it("provides typing reaction when configured", () => {
    const r = resolveReactions({ typing_reaction: "gear" });
    expect(r.typing).toBe("gear");
  });
});
```

- [ ] **Step 2: Implement resolveReactions in identity.ts**

```typescript
// Add to src/channels/slack/identity.ts

export interface ReactionConfig {
  ack_reaction?: string;
  done_reaction?: string;
  error_reaction?: string;
  typing_reaction?: string;
}

export interface ResolvedReactions {
  ack: string;
  done: string;
  error: string;
  typing?: string;
}

function stripColons(emoji: string): string {
  return emoji.replace(/^:|:$/g, "");
}

export function resolveReactions(config: ReactionConfig | undefined): ResolvedReactions {
  return {
    ack: stripColons(config?.ack_reaction ?? "eyes"),
    done: stripColons(config?.done_reaction ?? "white_check_mark"),
    error: stripColons(config?.error_reaction ?? "x"),
    typing: config?.typing_reaction ? stripColons(config.typing_reaction) : undefined,
  };
}
```

- [ ] **Step 3: Add reaction fields to AgentConfig.identity**

```typescript
// Add to AgentConfig.identity in src/types.ts
ack_reaction?: string;      // default: "eyes"
done_reaction?: string;     // default: "white_check_mark"
error_reaction?: string;    // default: "x"
typing_reaction?: string;   // shown during processing, removed on done
```

- [ ] **Step 4: Wire into handleMessage/handleMention**

Replace hardcoded `"eyes"`, `"white_check_mark"`, `"x"` with resolved values:
```typescript
const agentKey = agent ?? Object.keys(this.config.agents)[0];
const reactions = resolveReactions(this.config.agents[agentKey]?.identity);
await this.addReaction(client, channelId, message.ts, reactions.ack);
// ... on success:
await this.addReaction(client, channelId, message.ts, reactions.done);
// ... on error:
await this.addReaction(client, channelId, message.ts, reactions.error);
```

- [ ] **Step 5: Run tests, type check, commit**

Run: `bun test src/__tests__/slack-reactions-config.test.ts && bun test && bunx tsc --noEmit`

```bash
git commit -m "feat(slack): configurable ack/done/error reactions per agent"
```

---

### Task 8: Reaction Management

Agent can programmatically add/remove/list reactions on any message. Useful for workflow automation.

**Files:**
- Create: `src/channels/slack/reactions.ts`
- Create: `src/__tests__/slack-reactions.test.ts`
- Modify: `src/channels/types.ts` (add optional reaction methods to Channel interface)
- Modify: `src/channels/slack.ts` (expose via public methods)

- [ ] **Step 1: Write tests for validation**

```typescript
// src/__tests__/slack-reactions.test.ts
import { describe, it, expect } from "bun:test";
import { validateReactionParams } from "../channels/slack/reactions.js";

describe("validateReactionParams", () => {
  it("accepts valid params", () => {
    expect(validateReactionParams("C123", "1234567890.123456", "thumbsup")).toEqual({ ok: true });
  });
  it("rejects empty channel", () => {
    expect(validateReactionParams("", "123", "thumbsup").ok).toBe(false);
  });
  it("strips colons from emoji name", () => {
    // Slack API wants "thumbsup" not ":thumbsup:"
    expect(validateReactionParams("C123", "123", ":thumbsup:")).toEqual({ ok: true, emoji: "thumbsup" });
  });
});
```

- [ ] **Step 2: Implement, test, commit**

```typescript
// src/channels/slack/reactions.ts
export function validateReactionParams(channel: string, ts: string, emoji: string) {
  if (!channel) return { ok: false as const, error: "channel required" };
  if (!ts) return { ok: false as const, error: "ts required" };
  const cleaned = emoji.replace(/^:|:$/g, "");
  if (!cleaned) return { ok: false as const, error: "emoji required" };
  return { ok: true as const, emoji: cleaned };
}

export async function addReaction(client: any, channel: string, ts: string, emoji: string) {
  const v = validateReactionParams(channel, ts, emoji);
  if (!v.ok) return v;
  try { await client.reactions.add({ channel, timestamp: ts, name: v.emoji }); return { ok: true }; }
  catch (err) { return { ok: false, error: String(err) }; }
}

export async function removeReaction(client: any, channel: string, ts: string, emoji: string) {
  const v = validateReactionParams(channel, ts, emoji);
  if (!v.ok) return v;
  try { await client.reactions.remove({ channel, timestamp: ts, name: v.emoji }); return { ok: true }; }
  catch (err) { return { ok: false, error: String(err) }; }
}

export async function listReactions(client: any, channel: string, ts: string) {
  try {
    const result = await client.reactions.get({ channel, timestamp: ts, full: true });
    return { ok: true, reactions: result.message?.reactions ?? [] };
  } catch (err) { return { ok: false, error: String(err), reactions: [] }; }
}
```

```bash
git commit -m "feat(slack): reaction management (add/remove/list on any message)"
```

---

### Task 9: Pin Management

Agent can pin/unpin/list pins. Same pattern as reactions.

**Files:**
- Create: `src/channels/slack/pins.ts`
- Create: `src/__tests__/slack-pins.test.ts`
- Modify: `src/channels/slack.ts` (expose pin methods)
- Modify: `src/channels/types.ts` (add optional pin methods to Channel interface)

- [ ] **Step 1: Write failing tests**

```typescript
// src/__tests__/slack-pins.test.ts
import { describe, it, expect } from "bun:test";
import { validatePinParams } from "../channels/slack/pins.js";

describe("validatePinParams", () => {
  it("accepts valid params", () => {
    expect(validatePinParams("C123", "1234567890.123456")).toEqual({ ok: true });
  });
  it("rejects empty channel", () => {
    expect(validatePinParams("", "123").ok).toBe(false);
  });
  it("rejects empty ts", () => {
    expect(validatePinParams("C123", "").ok).toBe(false);
  });
});
```

- [ ] **Step 2: Implement pin operations**

```typescript
// src/channels/slack/pins.ts

interface ValidationResult {
  ok: boolean;
  error?: string;
}

export function validatePinParams(channel: string, ts: string): ValidationResult {
  if (!channel) return { ok: false, error: "channel required" };
  if (!ts) return { ok: false, error: "ts required" };
  return { ok: true };
}

export async function pinMessage(client: any, channel: string, ts: string) {
  const v = validatePinParams(channel, ts);
  if (!v.ok) return v;
  try { await client.pins.add({ channel, timestamp: ts }); return { ok: true }; }
  catch (err) { return { ok: false, error: String(err) }; }
}

export async function unpinMessage(client: any, channel: string, ts: string) {
  const v = validatePinParams(channel, ts);
  if (!v.ok) return v;
  try { await client.pins.remove({ channel, timestamp: ts }); return { ok: true }; }
  catch (err) { return { ok: false, error: String(err) }; }
}

export async function listPins(client: any, channel: string) {
  if (!channel) return { ok: false, error: "channel required", items: [] };
  try {
    const result = await client.pins.list({ channel });
    return { ok: true, items: result.items ?? [] };
  } catch (err) { return { ok: false, error: String(err), items: [] }; }
}
```

- [ ] **Step 3: Wire into SlackChannel, run tests, type check, commit**

Run: `bun test src/__tests__/slack-pins.test.ts && bun test && bunx tsc --noEmit`

```bash
git commit -m "feat(slack): pin management (pin/unpin/list)"
```

---

### Task 10: Configurable Message Chunking

Replace the basic `splitMessage` with paragraph-aware chunking that respects configurable limits.

**Files:**
- Create: `src/channels/slack/chunking.ts`
- Create: `src/__tests__/slack-chunking.test.ts`
- Modify: `src/channels/slack.ts` (use new chunker)

- [ ] **Step 1: Write failing tests**

```typescript
// src/__tests__/slack-chunking.test.ts
import { describe, it, expect } from "bun:test";
import { chunkMessage } from "../channels/slack/chunking.js";

describe("chunkMessage", () => {
  it("returns single chunk for short messages", () => {
    expect(chunkMessage("Hello", 3000)).toEqual(["Hello"]);
  });

  it("splits on paragraph boundaries first", () => {
    const text = "Para 1\n\nPara 2\n\nPara 3";
    const chunks = chunkMessage(text, 15);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // Each chunk should be a complete paragraph
    expect(chunks[0]).not.toContain("Para 2");
  });

  it("splits on newline if no paragraph break fits", () => {
    const text = "Line 1\nLine 2\nLine 3\nLine 4";
    const chunks = chunkMessage(text, 14);
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });

  it("hard-splits at limit if no break found", () => {
    const text = "A".repeat(100);
    const chunks = chunkMessage(text, 30);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(30);
    }
  });

  it("preserves code blocks across splits", () => {
    const text = "Before\n\n```\ncode line 1\ncode line 2\ncode line 3\n```\n\nAfter";
    const chunks = chunkMessage(text, 200);
    // Code block should not be split
    const codeChunk = chunks.find(c => c.includes("```"));
    expect(codeChunk).toContain("code line 1");
    expect(codeChunk).toContain("code line 3");
  });
});
```

- [ ] **Step 2: Implement paragraph-aware chunker**

```typescript
// src/channels/slack/chunking.ts

export function chunkMessage(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    // Try paragraph break (\n\n) first
    let splitIdx = remaining.lastIndexOf("\n\n", maxLen);
    if (splitIdx > maxLen * 0.3) {
      chunks.push(remaining.slice(0, splitIdx));
      remaining = remaining.slice(splitIdx + 2);
      continue;
    }

    // Try single newline
    splitIdx = remaining.lastIndexOf("\n", maxLen);
    if (splitIdx > maxLen * 0.3) {
      chunks.push(remaining.slice(0, splitIdx));
      remaining = remaining.slice(splitIdx + 1);
      continue;
    }

    // Try space
    splitIdx = remaining.lastIndexOf(" ", maxLen);
    if (splitIdx > maxLen * 0.3) {
      chunks.push(remaining.slice(0, splitIdx));
      remaining = remaining.slice(splitIdx + 1);
      continue;
    }

    // Hard split
    chunks.push(remaining.slice(0, maxLen));
    remaining = remaining.slice(maxLen);
  }

  return chunks;
}
```

- [ ] **Step 3: Add `chunk_limit` to slack config (default 3000), wire in, test, commit**

```bash
git commit -m "feat(slack): configurable paragraph-aware message chunking"
```

---

## Tier 3 — Infrastructure

### Task 11: Slash Command Arg Menus

When a slash command has predefined options, render them as buttons (<5), static select (<100), or external select with search (100+).

**Files:**
- Create: `src/channels/slack/arg-menus.ts`
- Create: `src/__tests__/slack-arg-menus.test.ts`
- Modify: `src/channels/slack.ts` (use in `/agent` and `/model` commands)

- [ ] **Step 1: Write tests**

```typescript
// src/__tests__/slack-arg-menus.test.ts
import { describe, it, expect } from "bun:test";
import { renderArgMenu } from "../channels/slack/arg-menus.js";

describe("renderArgMenu", () => {
  it("renders buttons for <= 5 options", () => {
    const blocks = renderArgMenu("Pick agent:", [
      { label: "Nyx", value: "nyx" },
      { label: "Morph", value: "morph" },
    ], "agent_select");
    const actions = blocks.find((b: any) => b.type === "actions");
    expect(actions.elements[0].type).toBe("button");
  });

  it("renders static_select for 6-100 options", () => {
    const options = Array.from({ length: 10 }, (_, i) => ({ label: `Opt ${i}`, value: `opt_${i}` }));
    const blocks = renderArgMenu("Pick:", options, "pick_select");
    const actions = blocks.find((b: any) => b.type === "actions");
    expect(actions.elements[0].type).toBe("static_select");
  });
});
```

- [ ] **Step 2: Implement, wire into `/agent` and `/model` commands, test, commit**

```bash
git commit -m "feat(slack): adaptive arg menus for slash commands (buttons/select)"
```

---

### Task 12: Modal Forms

**Status: Design only — implementation deferred until Tasks 1-11 are complete.**

Register modal submission handler. Agents can trigger modals programmatically via a `[[slack_modal: title | field1:type, field2:type]]` directive. Modals require `trigger_id` from a prior interaction (slash command or button click), so this depends on Task 1 (interactive buttons) and Task 11 (arg menus) being in place first.

**Files:**
- Create: `src/channels/slack/modals.ts`
- Create: `src/__tests__/slack-modals.test.ts`
- Modify: `src/channels/slack.ts`

**Design notes:**
- Modal directive format: `[[slack_modal: Form Title | name:text, email:email, date:datepicker]]`
- Parse directive to extract title and field definitions
- On interaction (button click), capture `trigger_id` and open modal via `views.open`
- Register `app.view(/^nyxhive:modal_submit:/, ...)` handler
- Extract submitted values from `view.state.values` and send as message to agent
- Scoped with `nyxhive:` prefix on all callback IDs

- [ ] **Step 1: Write tests for modal directive parsing**

```typescript
// src/__tests__/slack-modals.test.ts
import { describe, it, expect } from "bun:test";
import { parseModalDirective, buildModalView } from "../channels/slack/modals.js";

describe("parseModalDirective", () => {
  it("parses title and fields", () => {
    const result = parseModalDirective("Bug Report | title:text, severity:select, description:textarea");
    expect(result.title).toBe("Bug Report");
    expect(result.fields).toHaveLength(3);
    expect(result.fields[0]).toEqual({ name: "title", type: "text" });
    expect(result.fields[1]).toEqual({ name: "severity", type: "select" });
    expect(result.fields[2]).toEqual({ name: "description", type: "textarea" });
  });
});

describe("buildModalView", () => {
  it("builds view with input blocks for each field", () => {
    const view = buildModalView("Test Form", [
      { name: "name", type: "text" },
      { name: "notes", type: "textarea" },
    ], "cb-123");
    expect(view.type).toBe("modal");
    expect(view.title.text).toBe("Test Form");
    expect(view.blocks).toHaveLength(2);
    expect(view.callback_id).toContain("nyxhive:modal_submit:");
  });
});
```

- [ ] **Step 2: Implement modal directive parser and view builder**
- [ ] **Step 3: Register view submission handler in setupHandlers()**
- [ ] **Step 4: Test, commit**

```bash
git commit -m "feat(slack): modal form submissions with rich inputs"
```

---

### Task 13: Channel & Member Events

Track `channel_created`, `channel_rename`, `member_joined_channel`, `member_left_channel` as system events.

**Files:**
- Create: `src/channels/slack/events.ts`
- Create: `src/__tests__/slack-events.test.ts`
- Modify: `src/channels/slack.ts` (register event handlers)

- [ ] **Step 1: Write tests for event formatting**

```typescript
// src/__tests__/slack-events.test.ts
import { describe, it, expect } from "bun:test";
import { formatChannelEvent, formatMemberEvent } from "../channels/slack/events.js";

describe("slack events", () => {
  it("formats channel_created", () => {
    const event = formatChannelEvent("channel_created", { id: "C123", name: "new-channel" });
    expect(event.type).toBe("channel_created");
    expect(event.channel_id).toBe("C123");
    expect(event.channel_name).toBe("new-channel");
  });

  it("formats member_joined", () => {
    const event = formatMemberEvent("member_joined_channel", { user: "U123", channel: "C456" });
    expect(event.type).toBe("member_joined_channel");
    expect(event.user_id).toBe("U123");
  });
});
```

- [ ] **Step 2: Implement, register handlers, test, commit**

```bash
git commit -m "feat(slack): channel and member event tracking"
```

---

### Task 14: Message Edit/Delete Events

Track `message_changed` and `message_deleted` subtypes as system events. Currently ignored in `handleMessage` at line 249: `const ignoredSubtype = message.subtype && message.subtype !== "file_share"`.

**Files:**
- Modify: `src/channels/slack/events.ts` (add message event formatters)
- Modify: `src/channels/slack.ts` (allow `message_changed`/`message_deleted` subtypes through, route to event handler)
- Modify: `src/__tests__/slack-events.test.ts` (add test cases)

- [ ] **Step 1: Write tests for message event formatting**

```typescript
// Add to src/__tests__/slack-events.test.ts
describe("message events", () => {
  it("formats message_changed", () => {
    const event = formatMessageEvent("message_changed", {
      channel: "C123",
      previous_message: { text: "old", user: "U456", ts: "123.456" },
      message: { text: "new", user: "U456", ts: "123.456" },
    });
    expect(event.type).toBe("message_changed");
    expect(event.previous_text).toBe("old");
    expect(event.new_text).toBe("new");
    expect(event.user_id).toBe("U456");
  });

  it("formats message_deleted", () => {
    const event = formatMessageEvent("message_deleted", {
      channel: "C123",
      previous_message: { text: "deleted msg", user: "U456", ts: "123.456" },
    });
    expect(event.type).toBe("message_deleted");
    expect(event.previous_text).toBe("deleted msg");
  });
});
```

- [ ] **Step 2: Implement formatMessageEvent in events.ts**

```typescript
// Add to src/channels/slack/events.ts
export interface MessageEvent {
  type: "message_changed" | "message_deleted";
  channel: string;
  user_id?: string;
  previous_text?: string;
  new_text?: string;
  ts?: string;
}

export function formatMessageEvent(type: "message_changed" | "message_deleted", data: any): MessageEvent {
  return {
    type,
    channel: data.channel,
    user_id: data.previous_message?.user ?? data.message?.user,
    previous_text: data.previous_message?.text,
    new_text: type === "message_changed" ? data.message?.text : undefined,
    ts: data.previous_message?.ts,
  };
}
```

- [ ] **Step 3: Update handleMessage subtype filter**

Change line 249 in `slack.ts` from:
```typescript
const ignoredSubtype = message.subtype && message.subtype !== "file_share";
```
to:
```typescript
const allowedSubtypes = new Set(["file_share", "message_changed", "message_deleted"]);
const ignoredSubtype = message.subtype && !allowedSubtypes.has(message.subtype);
```

For `message_changed`/`message_deleted` subtypes, route to event formatter and log via audit, then return early (don't process as a new message).

- [ ] **Step 4: Run tests, commit**

Run: `bun test src/__tests__/slack-events.test.ts && bun test && bunx tsc --noEmit`

```bash
git commit -m "feat(slack): track message edit/delete as system events"
```

---

### Task 15: Per-Channel History Config

Configurable `history_limit`, `dm_history_limit`, and `initial_history_limit` per channel.

**Files:**
- Modify: `src/channels/slack/channel-config.ts` (add history config fields)
- Modify: `src/channels/slack.ts` (use config in `fetchThreadContext`)
- Modify: `src/config-schema.ts` and `src/types.ts`

- [ ] **Step 1: Add to per-channel config**

```typescript
history_limit?: number;       // default: 50
dm_history_limit?: number;    // default: 50
```

- [ ] **Step 2: Wire into fetchThreadContext (replace hardcoded `limit: 50`)**
- [ ] **Step 3: Test, commit**

```bash
git commit -m "feat(slack): configurable per-channel history limits"
```

---

### Task 16: Multi-Account Support

Support multiple Slack workspaces with per-account tokens and config.

**Files:**
- Modify: `src/channels/slack-types.ts` (add accounts config)
- Modify: `src/channels/slack.ts` (multi-app initialization)
- Modify: `src/config-schema.ts` and `src/types.ts`
- Modify: `src/framework/channels/slack.ts` (resolve per-account tokens)

**Note:** This is the most complex task. The current `SlackChannel` manages one `App` instance. Multi-account means creating one `App` per account, sharing handler logic.

**Architecture decision:** The framework's `ChannelFactory` interface (`src/framework/types.ts`) returns a single `Channel`. For multi-account, we have two options:
- (a) `SlackAccountManager` that implements `Channel` and internally manages multiple `SlackChannel` instances, aggregating stats and forwarding start/stop calls
- (b) Return multiple channels from the factory (requires changing `ChannelFactory` interface)

**Recommendation:** Option (a) — keeps the factory interface unchanged. `SlackAccountManager` implements `Channel`, wraps N `SlackChannel` instances.

- [ ] **Step 1: Design account config schema**

```toml
[slack]
bot_token_env = "SLACK_BOT_TOKEN"        # default account (backward compat)
app_token_env = "SLACK_APP_TOKEN"

[slack.accounts.acme]
bot_token_env = "OPTIPLY_SLACK_BOT_TOKEN"
app_token_env = "OPTIPLY_SLACK_APP_TOKEN"
channel_agents = { "C123" = "morph" }

[slack.accounts.nyxai]
bot_token_env = "NYXAI_SLACK_BOT_TOKEN"
app_token_env = "NYXAI_SLACK_APP_TOKEN"
```

- [ ] **Step 2: Implement SlackAccountManager**

Create `src/channels/slack/account-manager.ts`:
- Implements `Channel` interface
- Constructor: if `slack.accounts` is defined, create one `SlackChannel` per account; otherwise create one from the top-level config (backward compat)
- `start()`: start all accounts in parallel
- `stop()`: stop all accounts
- `isConnected()`: true if any account is connected
- `getStats()`: aggregate stats across accounts
- `sendOutbound()`: route to correct account based on channel ID
- `sendProposalNotification()`: route to correct account

- [ ] **Step 3: Update framework factory**

In `src/framework/channels/slack.ts`:
- When `slack.accounts` is defined, create `SlackAccountManager` instead of `SlackChannel`
- When no accounts defined, create `SlackChannel` directly (unchanged behavior)
- Pass all dependencies (proposalStore, crawlService, etc.) to each account's channel instance

- [ ] **Step 4: Test backward compatibility (single account still works)**
- [ ] **Step 5: Run tests, commit**

```bash
git commit -m "feat(slack): multi-account support for multiple workspaces"
```

---

### Task 17: HTTP Events Mode

Alternative to Socket Mode using HTTP webhooks with signing secret validation.

**Files:**
- Modify: `src/channels/slack.ts` (conditional HTTP vs Socket Mode init)
- Modify: `src/channels/slack-types.ts` (add mode config)
- Modify: `src/config-schema.ts` and `src/types.ts`

- [ ] **Step 1: Add `mode` config**

```typescript
mode?: "socket" | "http";  // default: "socket"
signing_secret_env?: string;  // required for HTTP mode
webhook_path?: string;  // default: "/slack/events"
```

- [ ] **Step 2: Implement HTTP mode initialization**

**Important:** NyxHive uses Hono, not Express. Bolt's built-in `HTTPReceiver` expects Express. Three options:
- (a) **Custom Hono receiver:** Write a minimal Bolt-compatible receiver that handles Hono requests. Parse the raw body, validate signing secret, dispatch to Bolt's event/action/command handlers.
- (b) **Bypass Bolt for HTTP events:** Handle Slack HTTP events directly in a Hono route (`POST /slack/events`). Validate signing secret with `@slack/bolt`'s `verifySlackRequest`, then dispatch to the same handler methods already registered. Use Bolt only for sending (via `WebClient`).
- (c) **Standalone port:** Run Bolt's `HTTPReceiver` on a separate port (e.g., 3001) and reverse-proxy from the main Hono server.

**Recommendation:** Option (b) — least coupling, reuses existing handler logic. Add a Hono route that:
1. Validates signing secret via `crypto.timingSafeEqual` on the `x-slack-signature` header
2. Parses the JSON body
3. Handles URL verification challenge (`type: "url_verification"`)
4. Routes events to the same `handleMessage`, `handleMention`, `handleReaction` methods
5. Routes interactivity payloads to the same action/view handlers

- [ ] **Step 3: Test both modes, commit**

```bash
git commit -m "feat(slack): HTTP Events mode as alternative to Socket Mode"
```

---

## Deployment Notes

### Required Slack App Scopes (new)

Add these to the Slack app configuration for full feature support:

- `chat:write.customize` — for per-agent identity (Task 5)
- `reactions:read` — for listing reactions (Task 8)
- `pins:read`, `pins:write` — for pin management (Task 9)
- `channels:read`, `groups:read` — for channel events (Task 13)

### Backward Compatibility

All features are opt-in:
- `interactive_replies: false` by default
- `streaming.enabled: false` by default
- No `identity` config = same bot identity as before
- No `channels` config = current behavior
- No `accounts` config = single-account mode
- `mode: "socket"` by default

### Migration Path

1. Deploy Tier 1 tasks first (highest impact, lowest risk)
2. Enable `interactive_replies: true` on Acme after testing
3. Roll out Tier 2 features one at a time
4. Tier 3 features are infrastructure — enable as needed

### Testing Strategy

Each task has unit tests for pure logic (parsing, validation, formatting). Integration testing against a live Slack workspace should be done manually before enabling each feature in production.
